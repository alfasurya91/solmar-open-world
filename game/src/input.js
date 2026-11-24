/*
 * Input layer.
 *
 * Three channels leave this module:
 *   - continuous state (held keys, sticks, virtual touch pads), polled every
 *     frame via move()/down()/running()
 *   - one-shot actions latched into a bitmask and drained with take()
 *   - a short ordered buffer of recent presses (input buffering), exposed
 *     through buffered()/consumeBuffered()/drainBuffered()
 *
 * Every action has its own bit so a single frame can carry several
 * intents at once (e.g. interact while running). Bits are append-only:
 * existing values are frozen because other systems may have already
 * stored them, so new actions always take the next free power of two.
 *
 * Sources feeding the same action funnel through raise(), so keyboard,
 * pointer, touch and gamepad all share one latch + one buffer.
 */

/* ---- action bits (append-only; never renumber an existing one) ---- */
export const ACT_CONFIRM = 1;    // 1 << 0  — Enter / NumpadEnter / Space / Numpad5 / pointer tap
export const ACT_PAUSE = 2;      // 1 << 1  — Escape / P / Pause
export const ACT_INTERACT = 4;   // 1 << 2  — E
export const ACT_SAVE = 8;       // 1 << 3  — Digit1
export const ACT_LOAD = 16;      // 1 << 4  — Digit2 / L / C
export const ACT_ATTACK = 32;    // 1 << 5  — J / left mouse button
export const ACT_WEAPON = 64;    // 1 << 6  — Q / Digit3 (cycle weapon)
export const ACT_CANCEL = 128;   // 1 << 7  — Backspace
export const ACT_RELOAD = 256;   // 1 << 8  — R
export const ACT_MAP = 512;      // 1 << 9  — Tab / M
export const ACT_HORN = 1024;    // 1 << 10 — H
export const ACT_KICK = 2048;    // 1 << 11 — Q (push kick; raised alongside the
                                 //            weapon cycle, see SECONDARY_BINDINGS)
export const ACT_BLUNT = 4096;   // 1 << 12 — F (blunt swing) / RB (secondary)

/*
 * Bits that only the melee extras use. They drain twice on purpose: once
 * through take() like every other action, and once through the extras
 * latch, so kickPressed()/bluntPressed() still report a press that a
 * legacy take() consumer (main.js) has already consumed.
 */
const EXTRA_ACTIONS = ACT_KICK | ACT_BLUNT;

/*
 * How long an extra press stays readable after take() drains the main mask.
 * main.js dispatches a fixed action list through take(), so without this
 * latch the kick/blunt bits would be cleared in the same frame they were
 * raised and no consumer could ever see them. The window is short on
 * purpose: a press must not fire a phantom attack a second later.
 */
const EXTRAS_TTL_MS = 250;

/* Human-readable names, handy for HUD prompts and rebinding UIs. */
export const ACTION_NAMES = Object.freeze({
  [ACT_CONFIRM]: 'confirm',
  [ACT_PAUSE]: 'pause',
  [ACT_INTERACT]: 'interact',
  [ACT_SAVE]: 'save',
  [ACT_LOAD]: 'load',
  [ACT_ATTACK]: 'attack',
  [ACT_WEAPON]: 'weapon',
  [ACT_CANCEL]: 'cancel',
  [ACT_RELOAD]: 'reload',
  [ACT_MAP]: 'map',
  [ACT_HORN]: 'horn',
  [ACT_KICK]: 'kick',
  [ACT_BLUNT]: 'blunt',
});

/*
 * Default code -> action table. This is the single place a keyboard
 * binding lives; controllers copy it at construction time so rebinding
 * one instance never mutates the defaults.
 *
 * Device prefixes used by the extra channels:
 *   'Pad0'..'Pad15'   standard gamepad buttons
 *   'Mouse0'..'Mouse4' pointer buttons (opt-in, see onPointerDown)
 *   'Touch:<id>'      virtual buttons declared by the touch layout
 */
export const DEFAULT_BINDINGS = Object.freeze({
  /* confirm */
  Enter: ACT_CONFIRM,
  NumpadEnter: ACT_CONFIRM,
  Space: ACT_CONFIRM,
  Numpad5: ACT_CONFIRM,
  /* pause */
  Escape: ACT_PAUSE,
  KeyP: ACT_PAUSE,
  Pause: ACT_PAUSE,
  /* interact */
  KeyE: ACT_INTERACT,
  /* attack */
  KeyJ: ACT_ATTACK,
  /* weapon cycle */
  KeyQ: ACT_WEAPON,
  Digit3: ACT_WEAPON,
  Numpad3: ACT_WEAPON,
  /* persistence */
  Digit1: ACT_SAVE,
  Numpad1: ACT_SAVE,
  Digit2: ACT_LOAD,
  KeyL: ACT_LOAD,
  KeyC: ACT_LOAD,
  /* extras */
  Backspace: ACT_CANCEL,
  KeyR: ACT_RELOAD,
  Tab: ACT_MAP,
  KeyM: ACT_MAP,
  KeyH: ACT_HORN,
  /* melee extras — F swings a pipe/bat; Q keeps cycling the weapon *and*
     raises a kick, see SECONDARY_BINDINGS */
  KeyF: ACT_BLUNT,
});

/*
 * Codes that raise a second bit on top of their DEFAULT_BINDINGS entry.
 * This exists so a new intent can share a key without touching the mapping
 * other systems already depend on: Q still emits ACT_WEAPON exactly as
 * before, and additionally emits ACT_KICK, which callers that do not know
 * about it simply ignore. Consuming one bit never consumes the other.
 */
export const SECONDARY_BINDINGS = Object.freeze({
  KeyQ: ACT_KICK,
  Pad1: ACT_KICK,      // B / circle, alongside ACT_CANCEL
  Pad5: ACT_BLUNT,     // RB, alongside ACT_ATTACK
});

/* Keys we claim; anything else is left to the browser. */
const CLAIMED = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyE', 'KeyP', 'KeyL', 'KeyC', 'KeyJ', 'KeyQ', 'KeyF',
  'KeyR', 'KeyM', 'KeyH',
  'Space', 'ShiftLeft', 'ShiftRight',
  'Enter', 'NumpadEnter', 'Escape', 'Pause', 'Tab', 'Backspace',
  'Digit1', 'Digit2', 'Digit3',
  'Numpad1', 'Numpad3', 'Numpad5',
  'Numpad2', 'Numpad4', 'Numpad6', 'Numpad8',
];

const CLAIMED_SET = new Set(CLAIMED);

/* Keys whose movement axis they drive, kept here so move() stays dumb. */
const MOVE_KEYS = Object.freeze({
  left: ['KeyA', 'ArrowLeft', 'Numpad4'],
  right: ['KeyD', 'ArrowRight', 'Numpad6'],
  up: ['KeyW', 'ArrowUp', 'Numpad8'],
  down: ['KeyS', 'ArrowDown', 'Numpad2'],
});

const RUN_KEYS = ['ShiftLeft', 'ShiftRight', 'Pad10', 'Pad11'];

/* Standard-mapping d-pad: 12 = up, 13 = down, 14 = left, 15 = right. */
const PAD_DPAD = Object.freeze({ up: 12, down: 13, left: 14, right: 15 });

/*
 * Keys the browser would otherwise spend on scrolling / caret motion.
 * While the canvas owns focus these are swallowed; keys already in
 * CLAIMED are handled by onKeyDown and never reach this list twice.
 */
const SCROLL_KEYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End',
]);

/*
 * Default virtual touch layout, in normalised target coordinates
 * (0..1, origin top-left). Each pad either drives a movement axis or
 * raises an action bit. Games can replace it with setTouchLayout().
 */
export const DEFAULT_TOUCH_LAYOUT = Object.freeze([
  { id: 'left', axis: 'left', label: '◀', x: 0.03, y: 0.64, w: 0.13, h: 0.16 },
  { id: 'right', axis: 'right', label: '▶', x: 0.19, y: 0.64, w: 0.13, h: 0.16 },
  { id: 'up', axis: 'up', label: '▲', x: 0.11, y: 0.46, w: 0.13, h: 0.16 },
  { id: 'down', axis: 'down', label: '▼', x: 0.11, y: 0.82, w: 0.13, h: 0.16 },
  { id: 'run', key: 'ShiftLeft', label: 'RUN', x: 0.72, y: 0.80, w: 0.12, h: 0.14 },
  { id: 'attack', action: ACT_ATTACK, label: 'ATK', x: 0.86, y: 0.74, w: 0.12, h: 0.14 },
  { id: 'interact', action: ACT_INTERACT, label: 'USE', x: 0.86, y: 0.56, w: 0.12, h: 0.14 },
  { id: 'confirm', action: ACT_CONFIRM, label: 'OK', x: 0.72, y: 0.60, w: 0.12, h: 0.14 },
]);

/* Standard-mapping gamepad buttons, applied in addition to bindings. */
export const DEFAULT_GAMEPAD_BINDINGS = Object.freeze({
  Pad0: ACT_CONFIRM,   // A / cross
  Pad1: ACT_CANCEL,    // B / circle
  Pad2: ACT_RELOAD,    // X / square
  Pad3: ACT_WEAPON,    // Y / triangle
  Pad5: ACT_ATTACK,    // RB
  Pad6: ACT_ATTACK,    // LT
  Pad7: ACT_INTERACT,  // RT
  Pad9: ACT_PAUSE,     // start
  Pad8: ACT_MAP,       // select / back
});

const DIGIT_1 = 0x31;
const KEY_AT = 0x40;

const DEFAULT_BUFFER_SIZE = 16;
const DEFAULT_BUFFER_WINDOW = 250; // ms a buffered press stays "fresh"
const DEFAULT_DEADZONE = 0.22;

/* Recognise a retargetable code: physical keys plus Pad/Mouse/Touch ids. */
function isBindableCode(code) {
  if (typeof code !== 'string' || code.length === 0) return false;
  if (/^(Pad\d{1,2}|Mouse[0-4]|Touch:.+)$/.test(code)) return true;
  if (CLAIMED_SET.has(code)) return true;
  return /^(Key[A-Z]|Digit\d|Numpad\d|F\d{1,2}|[A-Z][A-Za-z]+)$/.test(code);
}

/*
 * createInput(target, options)
 *
 * target: optional element that should also count as a confirm surface
 * (canvas tap). Defaults to window-level behaviour when omitted.
 * options: optional tuning bag —
 *   deadzone      analog deadzone for sticks/triggers (default 0.22)
 *   bufferWindow  freshness window in ms for buffered presses (250)
 *   bufferSize    max buffered presses kept (16)
 *   touchLayout   replaces DEFAULT_TOUCH_LAYOUT when given
 *   bindings      extra/override code -> action entries
 *   gamepad       false disables gamepad polling
 *
 * Returns a controller with:
 *   move()            -> {x, y} each in -1..1 from held movement keys,
 *                        touch d-pad and left stick
 *   down(code)        -> is this raw keycode currently held
 *   isPressed(code)   -> alias of down() for held-state reads
 *   justPressed(code) -> true once per press of a raw code (consumes)
 *   wasPressedOnce(code) -> same edge, but non-consuming peek
 *   running()         -> shift / run pad / trigger held
 *   pressed(action)   -> edge helper: true once per press, consumes the
 *                        latch bit; does not consume the buffer
 *   take()            -> drain and return the action bitmask
 *   clear()           -> drop every held key and pending action
 *   destroy()         -> detach all listeners (keeps clear() semantics)
 *
 * Added helpers:
 *   bufferWindow(ms?) / bufferSize(n?)   read or tune buffering
 *   buffered(action)                     fresh press still in the queue
 *   consumeBuffered(action)              take the oldest matching entry
 *   drainBuffered()                      ordered list of fresh press bits
 *   bindings()                           copy of the live binding table
 *   setBinding(code, action) / clearBinding(code) / resetBindings()
 *   setTouchLayout(layout) / touchLayout()
 *   gamepad()                            current stick/button snapshot
 *   pollGamepad()                        pad axes + d-pad merged into a
 *                                        move vector (zero when no pad)
 *   hasGamepad()                         a pad is connected
 *   gamepadButtons()                     polled per-button state + edges
 *   kickPressed() / bluntPressed()       edge helpers for the melee extras
 *   poll()                               force a device sample (implicit
 *                                        in move()/take()/pressed())
 *
 * Melee extras (additive — no existing mapping changes):
 *   Q  ACT_WEAPON + ACT_KICK    cycle the weapon and throw a push kick
 *   F  ACT_BLUNT                swing a pipe/bat
 *   R  ACT_RELOAD               reload (unchanged)
 *   Pad LB / B  kick, Pad RB  blunt, alongside their existing actions
 */
export function createInput(target, options = {}) {
  /* --- mutable state --- */
  const held = new Set();
  const virtual = new Set();          // 'Touch:<id>' pads, 'PadN' buttons
  let latched = 0;                    // bits raised since the last drain
  let bound = false;

  /* rebinding state */
  const bindings = new Map(Object.entries(DEFAULT_BINDINGS));
  const gamepadBindings = new Map(Object.entries(DEFAULT_GAMEPAD_BINDINGS));
  const overrides = options.bindings && typeof options.bindings === 'object'
    ? Object.entries(options.bindings)
    : [];
  for (const [code, action] of overrides) {
    if (typeof action === 'number' && action > 0) bindings.set(code, action);
  }

  /* buffering state */
  let bufLimit = Number.isFinite(options.bufferSize) && options.bufferSize > 0
    ? Math.floor(options.bufferSize)
    : DEFAULT_BUFFER_SIZE;
  let bufWindow = Number.isFinite(options.bufferWindow) && options.bufferWindow >= 0
    ? options.bufferWindow
    : DEFAULT_BUFFER_WINDOW;
  let queue = [];                     // [{ bit, action, t }] oldest first
  /* Edge-time record for the melee extras, so take()'s drain does not eat
   * them before kickPressed()/bluntPressed() can read the press. */
  let extraAt = { [ACT_KICK]: -Infinity, [ACT_BLUNT]: -Infinity };

  /* analog / device state */
  let deadzone = Number.isFinite(options.deadzone) ? options.deadzone : DEFAULT_DEADZONE;
  const padsOn = options.gamepad !== false;
  let padAxes = [0, 0, 0, 0];
  let padConnected = false;
  let padPrev = [];                   // latched down-state, per button index
  const padEdges = new Set();         // indices that went down since the last read
  let padVec = { x: 0, y: 0 };        // stick + d-pad, merged, post-deadzone

  /* raw-code edge detection: codes pressed since the last justPressed() */
  const pressedEdges = new Set();

  /* touch state */
  let touchPads = Array.isArray(options.touchLayout)
    ? options.touchLayout.map((p) => ({ ...p }))
    : DEFAULT_TOUCH_LAYOUT.map((p) => ({ ...p }));
  const activeTouches = new Map();    // pointerId -> pad id
  let touchVec = { x: 0, y: 0 };

  let pointerBound = false;
  let touchBound = false;

  function raise(bit) {
    if (!bit) return;
    latched |= bit;
    const t = now();
    if (bit & ACT_KICK) extraAt[ACT_KICK] = t;
    if (bit & ACT_BLUNT) extraAt[ACT_BLUNT] = t;
    queue.push({ bit, action: bit, t });
    if (queue.length > bufLimit) queue.splice(0, queue.length - bufLimit);
  }

  /* True when `bit` was raised within the extras window; consumes it. */
  function claimExtra(bit) {
    const at = extraAt[bit];
    if (!(at > -Infinity)) return false;
    if (now() - at > EXTRAS_TTL_MS) { extraAt[bit] = -Infinity; return false; }
    extraAt[bit] = -Infinity;
    return true;
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  function prune() {
    if (bufWindow <= 0) return;
    const cutoff = now() - bufWindow;
    while (queue.length && queue[0].t < cutoff) queue.shift();
  }

  /* ---------------- keyboard ---------------- */

  function onKeyDown(e) {
    if (!CLAIMED_SET.has(e.code)) return;
    // Space/arrows scroll the page; we own them while focused.
    e.preventDefault();

    const alreadyHeld = held.has(e.code);
    held.add(e.code);

    // Auto-repeat must not re-fire a one-shot action.
    if (e.repeat) return;

    // Latch a raw-code edge unless the press is a repeat of a held key.
    // Virtual pads do not touch this set, so it stays keyboard-only.
    if (!alreadyHeld) pressedEdges.add(e.code);

    const bit = bindings.get(e.code);
    if (!bit) return;

    /*
     * Legacy quirk kept for compatibility: C only loads on the first
     * press, never on a repeat, and is ignored while already held.
     */
    if (e.code === 'KeyC' && alreadyHeld) return;

    raise(bit);

    /* A second intent riding the same key (Q -> kick on top of weapon). */
    const extra = SECONDARY_BINDINGS[e.code];
    if (extra) raise(extra);
  }

  function onKeyUp(e) {
    if (!CLAIMED_SET.has(e.code)) return;
    held.delete(e.code);
  }

  function onBlur() {
    // Focus loss would otherwise strand keys as "held" forever.
    held.clear();
    virtual.clear();
    activeTouches.clear();
    padPrev = [];
    padEdges.clear();
    padVec = { x: 0, y: 0 };
    pressedEdges.clear();
    touchVec = { x: 0, y: 0 };
    extraAt = { [ACT_KICK]: -Infinity, [ACT_BLUNT]: -Infinity };
  }

  /*
   * Canvas-scoped key handler: the window listener already swallows the
   * claimed game keys, but PageUp/PageDown/Home/End (and, on some
   * browsers, a canvas that is not the scroll target's owner) can still
   * scroll the document. While the game surface has focus we eat them
   * here. This never raises actions, so keyboard behaviour is unchanged.
   */
  function onTargetKeyDown(e) {
    if (!SCROLL_KEYS.has(e.code) && !CLAIMED_SET.has(e.code)) return;
    if (e.cancelable !== false) e.preventDefault();
  }

  /* ---------------- pointer ---------------- */

  function onPointerDown(e) {
    // Existing behaviour: any tap on the surface counts as a confirm.
    const bit = bindings.get('Mouse' + (e && Number.isFinite(e.button) ? e.button : 0));
    raise(bit || ACT_CONFIRM);
  }

  function onPointerUp() {
    // Nothing to release yet; hook kept so pointer state stays symmetrical
    // if held-button tracking is added later.
  }

  function onPointerMove() {
    // Reserved for aim/look support; keeps the listener set symmetrical.
  }

  /* ---------------- touch ---------------- */

  function padAt(px, py) {
    for (let i = 0; i < touchPads.length; i++) {
      const p = touchPads[i];
      const w = p.w ?? 0.1;
      const h = p.h ?? 0.1;
      if (px >= p.x && px <= p.x + w && py >= p.y && py <= p.y + h) return p;
    }
    return null;
  }

  function localPoint(clientX, clientY) {
    if (target?.getBoundingClientRect) {
      const r = target.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
      }
    }
    const w = (typeof window !== 'undefined' && window.innerWidth) || 1;
    const h = (typeof window !== 'undefined' && window.innerHeight) || 1;
    return { x: clientX / w, y: clientY / h };
  }

  function pressPad(pad, id) {
    const code = 'Touch:' + pad.id;
    const first = !virtual.has(code) && ![...activeTouches.values()].includes(pad.id);
    virtual.add(code);
    activeTouches.set(id, pad.id);
    if (pad.key) held.add(pad.key);
    if (first && pad.action) raise(pad.action);
    if (pad.action === ACT_ATTACK) held.add('Touch:' + pad.id + ':attack');
  }

  function releasePad(id) {
    const padId = activeTouches.get(id);
    if (padId === undefined) return;
    activeTouches.delete(id);
    const stillDown = [...activeTouches.values()].includes(padId);
    if (stillDown) return;
    virtual.delete('Touch:' + padId);
    held.delete('Touch:' + padId + ':attack');
    const pad = touchPads.find((p) => p.id === padId);
    if (pad?.key) held.delete(pad.key);
  }

  function updateTouchVec() {
    let x = 0;
    let y = 0;
    for (const padId of activeTouches.values()) {
      const pad = touchPads.find((p) => p.id === padId);
      if (!pad || !pad.axis) continue;
      if (pad.axis === 'left') x -= 1;
      if (pad.axis === 'right') x += 1;
      if (pad.axis === 'up') y -= 1;
      if (pad.axis === 'down') y += 1;
    }
    touchVec = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  function onTouchStart(e) {
    const list = e.changedTouches;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const pt = localPoint(t.clientX, t.clientY);
      const pad = padAt(pt.x, pt.y);
      if (!pad) {
        // Tap outside the virtual pads still confirms, like a pointer tap.
        raise(ACT_CONFIRM);
        continue;
      }
      pressPad(pad, t.identifier);
    }
    updateTouchVec();
    if (e.cancelable) e.preventDefault();
  }

  function onTouchMove(e) {
    const list = e.changedTouches;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const padId = activeTouches.get(t.identifier);
      if (padId === undefined) continue;
      const pt = localPoint(t.clientX, t.clientY);
      const pad = padAt(pt.x, pt.y);
      // Sliding off a pad releases it; sliding onto another engages it.
      if (!pad || pad.id !== padId) {
        releasePad(t.identifier);
        if (pad) pressPad(pad, t.identifier);
      }
    }
    updateTouchVec();
    if (e.cancelable) e.preventDefault();
  }

  function onTouchEnd(e) {
    const list = e.changedTouches;
    if (!list) return;
    for (let i = 0; i < list.length; i++) releasePad(list[i].identifier);
    updateTouchVec();
    if (e.cancelable) e.preventDefault();
  }

  /* ---------------- gamepad ---------------- */

  function sampleGamepad() {
    if (!padsOn || typeof navigator === 'undefined' || !navigator.getGamepads) {
      padConnected = false;
      return;
    }
    padEdges.clear();                   // edges live for one sample only
    let pads;
    try {
      pads = navigator.getGamepads() || [];
    } catch {
      padConnected = false;
      return;
    }
    let pad = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
    }
    padConnected = !!pad;
    if (!pad) {
      padPrev = [];
      padAxes = [0, 0, 0, 0];
      padVec = { x: 0, y: 0 };
      return;
    }

    const a = pad.axes || [];
    padAxes = [
      Number.isFinite(a[0]) ? a[0] : 0,
      Number.isFinite(a[1]) ? a[1] : 0,
      Number.isFinite(a[2]) ? a[2] : 0,
      Number.isFinite(a[3]) ? a[3] : 0,
    ];

    const buttons = pad.buttons || [];
    const prevButtons = padPrev.slice();     // pre-update, for analog edges
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const down = !!(b && (b.pressed || (Number.isFinite(b.value) && b.value > 0.5)));
      const code = 'Pad' + i;
      const was = !!padPrev[i];
      padPrev[i] = down;
      if (down) {
        virtual.add(code);
        if (!was) {
          padEdges.add(i);
          const bit = gamepadBindings.get(code);
          if (bit) raise(bit);
          /* Secondary intent on the same button (RB swings a blunt weapon
           * as well as attacking; B kicks as well as cancelling). */
          const extra = SECONDARY_BINDINGS[code];
          if (extra && extra !== bit) raise(extra);
        }
      } else {
        virtual.delete(code);
      }
    }

    /*
     * Analog triggers (LT = 6, RT = 7) can be pulled past the press
     * threshold before the browser flips `pressed`. Treat a deep pull as a
     * rising edge too, once per pull, so a pad-only player can fire and
     * swing without mashing. Skipped when the digital edge already fired
     * this sample, so one pull never raises twice.
     */
    const trig = (index, bit) => {
      if (!bit || prevButtons[index]) return;
      const b = buttons[index];
      const value = b && Number.isFinite(b.value) ? b.value : 0;
      if (value > 0.6) raise(bit);
    };
    trig(6, gamepadBindings.get('Pad6'));
    trig(7, gamepadBindings.get('Pad7'));

    /* Left bumper (LB = 4) has no default binding, so it is free to serve
     * as the pad's push kick. */
    if (padPrev[4] && !prevButtons[4] && !gamepadBindings.get('Pad4')) raise(ACT_KICK);

    /*
     * Merge the left stick (post-deadzone) with the d-pad into one vector
     * so a pad-only player moves exactly like a keyboard player. Kept in
     * padVec rather than added to move()'s existing sums so that move()'s
     * current output is untouched.
     */
    let px = applyDeadzone(padAxes[0] || 0);
    let py = applyDeadzone(padAxes[1] || 0);
    if (padPrev[PAD_DPAD.left]) px -= 1;
    if (padPrev[PAD_DPAD.right]) px += 1;
    if (padPrev[PAD_DPAD.up]) py -= 1;
    if (padPrev[PAD_DPAD.down]) py += 1;
    padVec = { x: clampAxis(px), y: clampAxis(py) };
  }

  /* ---------------- lifecycle ---------------- */

  function attach() {
    if (bound) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      bound = true;
      return;
    }
    bound = true;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    if (target?.addEventListener) {
      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointermove', onPointerMove);
      pointerBound = true;
      target.addEventListener('keydown', onTargetKeyDown);
      target.addEventListener('touchstart', onTouchStart, { passive: false });
      target.addEventListener('touchmove', onTouchMove, { passive: false });
      target.addEventListener('touchend', onTouchEnd, { passive: false });
      target.addEventListener('touchcancel', onTouchEnd, { passive: false });
      touchBound = true;
    }
  }

  function detach() {
    if (!bound) return;
    bound = false;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }
    if (target?.removeEventListener) {
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('keydown', onTargetKeyDown);
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', onTouchEnd);
      pointerBound = false;
      touchBound = false;
    }
  }

  attach();

  function anyHeld(codes) {
    for (let i = 0; i < codes.length; i++) {
      if (held.has(codes[i])) return true;
    }
    return false;
  }

  function clampAxis(v) {
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  function applyDeadzone(v) {
    return Math.abs(v) < deadzone ? 0 : clampAxis(v);
  }

  return {
    move() {
      sampleGamepad();
      let x = 0;
      let y = 0;

      if (anyHeld(MOVE_KEYS.left)) x -= 1;
      if (anyHeld(MOVE_KEYS.right)) x += 1;
      if (anyHeld(MOVE_KEYS.up)) y -= 1;
      if (anyHeld(MOVE_KEYS.down)) y += 1;

      x += touchVec.x;
      y += touchVec.y;

      if (padConnected) {
        x += applyDeadzone(padAxes[0] || 0);
        y += applyDeadzone(padAxes[1] || 0);
      }

      return { x: clampAxis(x), y: clampAxis(y) };
    },

    down(code) {
      return held.has(code) || virtual.has(code);
    },

    /**
     * Held-state alias for down(): keyboard key, gamepad button
     * ('Pad0'..) or touch pad ('Touch:<id>') currently down.
     * @param {string} code raw code, same vocabulary as bindings
     * @returns {boolean}
     */
    isPressed(code) {
      return held.has(code) || virtual.has(code);
    },

    /**
     * Edge-triggered read for a raw code: true on the first poll after a
     * key went down, and false on every poll after. Consuming, so it pairs
     * with isPressed() the way an action edge pairs with pressed().
     * Keyboard only; virtual pads report through down()/isPressed().
     * @param {string} code raw keycode such as 'KeyE'
     * @returns {boolean}
     */
    justPressed(code) {
      if (typeof code !== 'string' || !pressedEdges.has(code)) return false;
      pressedEdges.delete(code);
      return true;
    },

    /**
     * Non-consuming peek at the same edge justPressed() reports: the code
     * went down since the last consume and is still unread. Safe to call
     * repeatedly from several systems in one frame.
     * @param {string} code raw keycode such as 'KeyE'
     * @returns {boolean}
     */
    wasPressedOnce(code) {
      return typeof code === 'string' && pressedEdges.has(code);
    },

    running() {
      sampleGamepad();
      return anyHeld(RUN_KEYS) || (padConnected && !!(padPrev[10] || padPrev[11]));
    },

    /*
     * Edge-trigger helper. True exactly once per physical press: the bit
     * is consumed on read, so polling pressed() in a loop reports the
     * press on one frame only. take() remains a separate drain for
     * callers that dispatch the whole mask at once.
     */
    pressed(action) {
      if (!action) return false;
      sampleGamepad();
      if ((latched & action) === 0) return false;
      latched &= ~action;
      return true;
    },

    take() {
      sampleGamepad();
      const out = latched;
      latched = 0;
      return out;
    },

    /** Drain the melee extras: whatever is still latched plus any press the
     *  take() drain already consumed but that is still inside the window. */
    takeExtras() {
      sampleGamepad();
      let out = latched & EXTRA_ACTIONS;
      latched &= ~EXTRA_ACTIONS;
      if (claimExtra(ACT_KICK)) out |= ACT_KICK;
      if (claimExtra(ACT_BLUNT)) out |= ACT_BLUNT;
      return out;
    },

    clear() {
      latched = 0;
      extraAt = { [ACT_KICK]: -Infinity, [ACT_BLUNT]: -Infinity };
      held.clear();
      virtual.clear();
      activeTouches.clear();
      queue = [];
      touchVec = { x: 0, y: 0 };
      padPrev = [];
      padEdges.clear();
      padAxes = [0, 0, 0, 0];
      padVec = { x: 0, y: 0 };
      pressedEdges.clear();
    },

    destroy() {
      detach();
      latched = 0;
      extraAt = { [ACT_KICK]: -Infinity, [ACT_BLUNT]: -Infinity };
      held.clear();
      virtual.clear();
      activeTouches.clear();
      queue = [];
      touchVec = { x: 0, y: 0 };
      padVec = { x: 0, y: 0 };
      pressedEdges.clear();
      padEdges.clear();
    },

    /* ---- input buffering ---- */

    bufferWindow(ms) {
      if (Number.isFinite(ms) && ms >= 0) bufWindow = ms;
      return bufWindow;
    },

    bufferSize(n) {
      if (Number.isFinite(n) && n > 0) {
        bufLimit = Math.floor(n);
        if (queue.length > bufLimit) queue.splice(0, queue.length - bufLimit);
      }
      return bufLimit;
    },

    buffered(action) {
      if (!action) return false;
      prune();
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].action & action) return true;
      }
      return false;
    },

    consumeBuffered(action) {
      if (!action) return false;
      prune();
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].action & action) {
          queue.splice(i, 1);
          return true;
        }
      }
      return false;
    },

    drainBuffered() {
      prune();
      const out = queue.map((q) => q.bit);
      queue = [];
      return out;
    },

    /* ---- rebinding ---- */

    bindings() {
      return Object.fromEntries(bindings);
    },

    setBinding(code, action) {
      if (!isBindableCode(code) || typeof action !== 'number' || action <= 0) return false;
      bindings.set(code, action);
      if (/^Pad\d{1,2}$/.test(code)) gamepadBindings.set(code, action);
      return true;
    },

    clearBinding(code) {
      const had = bindings.delete(code) || gamepadBindings.delete(code);
      return had;
    },

    resetBindings() {
      bindings.clear();
      for (const [code, action] of Object.entries(DEFAULT_BINDINGS)) bindings.set(code, action);
      gamepadBindings.clear();
      for (const [code, action] of Object.entries(DEFAULT_GAMEPAD_BINDINGS)) {
        gamepadBindings.set(code, action);
      }
    },

    /* ---- touch ---- */

    setTouchLayout(layout) {
      if (!Array.isArray(layout)) return touchPads.map((p) => ({ ...p }));
      touchPads = layout.filter((p) => p && typeof p.id === 'string').map((p) => ({ ...p }));
      activeTouches.clear();
      touchVec = { x: 0, y: 0 };
      return touchPads.map((p) => ({ ...p }));
    },

    touchLayout() {
      return touchPads.map((p) => ({ ...p }));
    },

    /* ---- gamepad ---- */

    /**
     * Sample every pad and return a normalised move vector built from the
     * left stick (deadzone applied) plus the d-pad. Returns {x:0,y:0} and
     * connected:false when no pad is attached, and never touches keyboard
     * or touch state — so keyboard stays authoritative and callers can
     * OR this in only when hasGamepad() is true.
     * @returns {{x:number, y:number, connected:boolean}}
     */
    pollGamepad() {
      sampleGamepad();
      if (!padConnected) return { x: 0, y: 0, connected: false };
      return { x: padVec.x, y: padVec.y, connected: true };
    },

    /**
     * Force a device sample and return the raw snapshot: connected flag,
     * four stick axes and per-button booleans.
     * @returns {{connected:boolean, axes:number[], buttons:boolean[]}}
     */
    poll() {
      sampleGamepad();
      return this.gamepad();
    },

    /**
     * Raw snapshot: connected flag, four stick axes and per-button
     * booleans. Samples first, so it is safe to call standalone.
     * @returns {{connected:boolean, axes:number[], buttons:boolean[]}}
     */
    gamepad() {
      sampleGamepad();
      return {
        connected: padConnected,
        axes: padAxes.slice(),
        buttons: padPrev.map((d) => !!d),
      };
    },

    /**
     * Whether a standard-mapping pad is currently attached.
     * @returns {boolean}
     */
    hasGamepad() {
      sampleGamepad();
      return padConnected;
    },

    /**
     * Polled button state for every face button on the connected pad.
     * Uses polling rather than events, so it works without a gamepad
     * connection listener: `down` is the live level, `pressed` is true for
     * the one poll after the button went down, `held` is the latched level
     * carried across samples. Returns an empty array when no pad is attached.
     * @returns {Array<{index:number, down:boolean, pressed:boolean, value:number}>}
     */
    gamepadButtons() {
      sampleGamepad();
      if (!padConnected || typeof navigator === 'undefined' || !navigator.getGamepads) return [];
      let pads = [];
      try { pads = navigator.getGamepads() || []; } catch { return []; }
      let pad = null;
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
      }
      if (!pad) return [];
      const buttons = pad.buttons || [];
      const out = [];
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i] || {};
        const value = Number.isFinite(b.value) ? b.value : b.pressed ? 1 : 0;
        out.push({
          index: i,
          down: !!(b.pressed || value > 0.5),
          pressed: padEdges.has(i),   // edge from the most recent sample
          value,
          held: !!padPrev[i],
        });
      }
      return out;
    },

    /** True once per press of the pad's kick button (LB / B). Survives the
     *  take() drain that main.js performs, for EXTRAS_TTL_MS. */
    kickPressed() {
      if (this.pressed(ACT_KICK)) return true;
      return claimExtra(ACT_KICK);
    },

    /** True once per press of the blunt-swing input (F / RB). */
    bluntPressed() {
      if (this.pressed(ACT_BLUNT)) return true;
      return claimExtra(ACT_BLUNT);
    },
  };
}
