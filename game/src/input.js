// Input: a single set of listeners and two ways to interrogate it. Continuous controls (walking,
// throttle, handbrake, run) are polled from the keys held at this instant. Discrete controls
// (confirm, pause, interact, save, load) are latched into a bitmask and handed out exactly once, so a
// tap landing between two frames is neither dropped nor acted on twice.
//
// Keys are watched on window rather than on the canvas, so the title card and the pause menu answer
// before the canvas has ever been clicked.

export const ACT_CONFIRM = 1;
export const ACT_PAUSE = 2;
export const ACT_INTERACT = 4;
export const ACT_SAVE = 8;
export const ACT_LOAD = 16;

/** Keys the game claims: suppressing their default stops the page scrolling or tabbing away. */
const WATCHED = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'KeyP',
  'KeyL',
  'KeyC',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'Enter',
  'NumpadEnter',
  'Escape',
  'Digit1',
  'Digit2',
]);

export function createInput(target) {
  const held = new Set();
  let actions = 0;

  function onKeyDown(event) {
    if (!WATCHED.has(event.code)) return;
    event.preventDefault();

    const wasHeld = held.has(event.code);
    held.add(event.code);

    // Auto-repeat keeps the key available for polling, but must not fire its action over and over.
    if (event.repeat) return;

    switch (event.code) {
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        // Space is both start on the menu and handbrake in a car; the loop tells the two apart.
        actions |= ACT_CONFIRM;
        break;
      case 'Escape':
      case 'KeyP':
        actions |= ACT_PAUSE;
        break;
      case 'KeyE':
        actions |= ACT_INTERACT;
        break;
      case 'Digit1':
        actions |= ACT_SAVE;
        break;
      case 'Digit2':
      case 'KeyL':
        actions |= ACT_LOAD;
        break;
      case 'KeyC':
        // Only a fresh press of C resumes a saved game.
        if (!wasHeld) actions |= ACT_LOAD;
        break;
      default:
        break;
    }
  }

  function onKeyUp(event) {
    if (!WATCHED.has(event.code)) return;
    held.delete(event.code);
  }

  // A key released while the tab is hidden never fires keyup: drop everything on blur.
  function onBlur() {
    held.clear();
  }

  function onPointerDown() {
    actions |= ACT_CONFIRM;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  if (target && target.addEventListener) target.addEventListener('pointerdown', onPointerDown);

  return {
    /** Direction being held, each component -1, 0 or 1. +y points down, so S gives {x: 0, y: 1}. */
    move() {
      let x = 0;
      let y = 0;
      if (held.has('KeyA') || held.has('ArrowLeft')) x -= 1;
      if (held.has('KeyD') || held.has('ArrowRight')) x += 1;
      if (held.has('KeyW') || held.has('ArrowUp')) y -= 1;
      if (held.has('KeyS') || held.has('ArrowDown')) y += 1;
      return { x, y };
    },

    /** Is this physical key down right now? e.g. down('Space') for the handbrake. */
    down(code) {
      return held.has(code);
    },

    /** Shift, read as the run modifier on foot. */
    running() {
      return held.has('ShiftLeft') || held.has('ShiftRight');
    },

    /** Every one-shot press since the last call, OR-ed together; the queue is then emptied. */
    take() {
      const taken = actions;
      actions = 0;
      return taken;
    },

    /** Forget queued presses and held keys: used when a screen change makes them stale. */
    clear() {
      actions = 0;
      held.clear();
    },
  };
}
