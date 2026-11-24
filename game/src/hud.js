import { COLORS, CITY, FONT } from './config.js';
import { clamp, formatClock, formatMoney, roundRect } from './utils.js';

/* ------------------------------------------------------------------ */
/* layout constants                                                    */
/* ------------------------------------------------------------------ */

const EDGE = 26;
const RIGHT_GAP = 34;
const BOTTOM_GAP = 28;
const PANEL_GAP = 14;
const PADDING = 16;
const TOAST_DEFAULT = 2.6;
const TOAST_LIMIT = 4;
const MAX_WANTED = 5;
const MAP_SIZE = 150;
const MAP_VIEW_RATIO = 0.62;

const STATUS_W = 320;
const STATUS_H = 138;
const OBJ_W = 420;
const OBJ_H = 118;
const CASH_W = 280;
const CASH_H = 172;

/* right-hand side-job card: sits under the cash panel */
const SIDE_W = 268;
const SIDE_H = 118;
const SIDE_IDLE_H = 84;

/* compass ribbon across the top middle */
const COMPASS_W = 340;
const COMPASS_FIELD = 80;   // degrees of arc that fit either side of the nose

const SPEED_MAX_KMH = 140;
const SPEED_SCALE = 2.4; // world units per second -> km/h

const STAR_HUES = ['#f2c75c', '#f0b559', '#eea154', '#eca04f', '#e8665b'];

const KIND_COLORS = {
  info: COLORS.cream,
  tip: COLORS.gold,
  good: COLORS.green,
  cash: COLORS.green,
  bad: COLORS.red,
  wanted: COLORS.red,
};

const KIND_LABELS = {
  info: 'NOTICE',
  tip: 'TIP',
  good: 'DONE',
  cash: 'PAYOUT',
  bad: 'ALERT',
  wanted: 'POLICE',
};

/* ------------------------------------------------------------------ */
/* drawing helpers                                                     */
/* ------------------------------------------------------------------ */

function font(ctx, size, weight = '600') {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function fit(ctx, txt, limit) {
  const s = String(txt ?? '');
  if (!Number.isFinite(limit) || limit <= 0) return;
  if (ctx.measureText(s).width <= limit) {
    ctx.fillText(s, 0, 0);
    return;
  }
  const dots = '\u2026';
  const room = Math.max(0, limit - ctx.measureText(dots).width);
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid)).width <= room) lo = mid;
    else hi = mid - 1;
  }
  const cut = s.slice(0, lo).replace(/[\s,.;:-]+$/, '');
  ctx.fillText(`${cut}${dots}`, 0, 0);
}

function box(ctx, x, y, w, h, r = 10) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.strokeStyle = COLORS.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function tag(ctx, txt, x, y, col = COLORS.muted) {
  font(ctx, 11, '700');
  ctx.fillStyle = col;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(txt, x, y);
}

function num(ctx, txt, x, y, sz = 13, col = COLORS.cream, maxW = 0, wt = '700') {
  const t = String(txt ?? '');
  font(ctx, sz, wt);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = col;
  if (maxW > 0) {
    const nat = ctx.measureText(t).width;
    if (nat > maxW) {
      const scaled = Math.max(9, Math.floor((sz * maxW) / nat));
      font(ctx, scaled, wt);
    }
  }
  ctx.fillText(t, x, y);
  font(ctx, sz, wt);
}

function rule(ctx, x, y, w, a = 0.1) {
  ctx.strokeStyle = `rgba(247, 241, 226, ${a})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
}

function track(ctx, x, y, w, h, r = 6) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = 'rgba(247, 241, 226, 0.12)';
  ctx.fill();
}

/*
 * Horizontal bar with an optional "ghost" layer: the pale block lags behind
 * a drop in health, so damage reads as a flash of lost value.
 */
function bar(ctx, x, y, w, h, frac, col, ghost = null) {
  const f = clamp(Number(frac) || 0, 0, 1);
  const r = Math.min(h / 2, 6);
  track(ctx, x, y, w, h, r);
  const grow = (v) => Math.max(h, w * v);
  if (Number.isFinite(ghost) && ghost > f) {
    roundRect(ctx, x, y, Math.min(w, grow(clamp(ghost, 0, 1))), h, r);
    ctx.fillStyle = 'rgba(247, 241, 226, 0.30)';
    ctx.fill();
  }
  if (f > 0) {
    roundRect(ctx, x, y, Math.min(w, grow(f)), h, r);
    ctx.fillStyle = col;
    ctx.fill();
  }
}

function starPath(ctx, cx, cy, r) {
  const r2 = r * 0.46;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r2;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(ang) * rad;
    const py = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/*
 * Wanted star. `frac` below 1 paints a partial star, which lets the HUD show
 * heat that has not yet rounded up to a full level.
 */
function star(ctx, cx, cy, r, col, frac = 1, glow = 0) {
  const f = clamp(frac, 0, 1);
  if (f > 0) {
    ctx.save();
    starPath(ctx, cx, cy, r);
    ctx.clip();
    if (glow > 0) {
      ctx.shadowColor = col;
      ctx.shadowBlur = glow;
    }
    ctx.fillStyle = col;
    ctx.fillRect(cx - r - 2, cy - r - 2, (r * 2 + 4) * f, r * 2 + 4);
    ctx.restore();
  }
  starPath(ctx, cx, cy, r);
  ctx.strokeStyle = f >= 1 ? 'rgba(20, 26, 30, 0.45)' : 'rgba(247, 241, 226, 0.30)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function pentagon(ctx, cx, cy, r, on, hue) {
  star(ctx, cx, cy, r, hue, on ? 1 : 0, 0);
}

function rose(ctx, cx, cy, rad, heading) {
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 18, 24, 0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 248, 230, 0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  const dx = Math.cos(heading), dy = Math.sin(heading);
  ctx.beginPath();
  ctx.moveTo(cx + dx * (rad - 2), cy + dy * (rad - 2));
  ctx.lineTo(cx - dy * 3.4, cy + dx * 3.4);
  ctx.lineTo(cx + dy * 3.4, cy - dx * 3.4);
  ctx.closePath();
  ctx.fillStyle = COLORS.gold;
  ctx.fill();
  font(ctx, 8, '700');
  ctx.fillStyle = COLORS.cream;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - rad + 3.4);
}

function shroud(ctx, w, h, a) {
  ctx.fillStyle = `rgba(6, 11, 15, ${a})`;
  ctx.fillRect(0, 0, w, h);
}

function headline(ctx, cx, y, txt, sz, col = COLORS.cream, bar = true) {
  font(ctx, sz, '800');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = col;
  ctx.fillText(txt, cx, y);
  if (!bar) return;
  const wid = Math.min(ctx.measureText(txt).width, cx * 2);
  ctx.strokeStyle = 'rgba(242, 199, 92, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - wid / 2, y + sz * 0.42);
  ctx.lineTo(cx + wid / 2, y + sz * 0.42);
  ctx.stroke();
}

function pair(ctx, label, val, x, y, width) {
  font(ctx, 13, '700');
  const vw = Math.min(width * 0.5, ctx.measureText(String(val ?? '')).width);
  const lw = Math.max(0, width - vw - 14);
  font(ctx, 12, '600');
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 14, lw, 20);
  ctx.clip();
  ctx.translate(x, y);
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  fit(ctx, label, lw);
  ctx.restore();
  num(ctx, val, x + width, y, 13, COLORS.cream, Math.max(0, width - lw - 8));
}

function caps(ctx, x, y, items, cap = Infinity) {
  const gap = 10;
  let cur = x;
  for (const it of items) {
    font(ctx, 12, '700');
    const cw = Math.max(26, ctx.measureText(it.key).width + 16);
    if (cur + cw > x + cap) break;
    roundRect(ctx, cur, y, cw, 24, 6);
    ctx.fillStyle = 'rgba(247, 241, 226, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(247, 241, 226, 0.26)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.cream;
    ctx.fillText(it.key, cur + cw / 2, y + 12.5);
    font(ctx, 11, '600');
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(it.action, cur + cw / 2, y + 42);
    cur += cw + gap;
  }
  return cur - gap;
}

function capsWidth(ctx, items) {
  let w = 0;
  for (const it of items) {
    font(ctx, 12, '700');
    w += Math.max(26, ctx.measureText(it.key).width + 16) + 10;
  }
  return Math.max(0, w - 10);
}

function gearFor(car) {
  if (!car) return 'P';
  if (car.handbrake) return 'H';
  const sp = Number(car.speed) || 0;
  if (sp < -2) return 'R';
  return Math.abs(sp) < 2 ? 'N' : 'D';
}

function speedColor(frac) {
  if (frac >= 0.86) return COLORS.red;
  if (frac >= 0.58) return COLORS.gold;
  return COLORS.green;
}

/* World-space heading (radians, +x = east) -> compass bearing in degrees. */
function bearing(wx, wy, px, py) {
  return (Math.atan2(wy - py, wx - px) * 180 / Math.PI + 450) % 360;
}

const CARDINALS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [360, 'N'],
];

/* Short label for an absolute bearing — used by the mission/vehicle ticks. */
function cardinalOf(deg) {
  const d = ((deg % 360) + 360) % 360;
  let best = CARDINALS[0][1], bestD = 999;
  for (const [a, name] of CARDINALS) {
    const diff = Math.abs(((d - a + 540) % 360) - 180);
    if (diff < bestD) { bestD = diff; best = name; }
  }
  return best;
}

/* Player facing: missions and traffic use radians where 0 points east. */
function playerHeading(p) {
  const f = Number(p?.facing);
  if (Number.isFinite(f)) return f;
  const car = p?.car;
  if (car && Number.isFinite(car.angle)) return car.angle;
  return 0;
}

/* In-game minutes -> one of five readable daylight phases. */
function daylight(clock) {
  const m = ((Number(clock) || 0) % 1440 + 1440) % 1440;
  const h = m / 60;
  if (h >= 5 && h < 7.5) return { label: 'DAWN', night: 0.35, tint: '#e8a06a' };
  if (h >= 7.5 && h < 12) return { label: 'MORNING', night: 0, tint: '#f2c75c' };
  if (h >= 12 && h < 17) return { label: 'AFTERNOON', night: 0, tint: '#fff0c2' };
  if (h >= 17 && h < 19.5) return { label: 'DUSK', night: 0.35, tint: '#e8955a' };
  if (h >= 19.5 && h < 22) return { label: 'EVENING', night: 0.72, tint: '#6f8fd6' };
  return { label: 'NIGHT', night: 1, tint: '#8ea4d6' };
}

/* The car the player would notice first: nearest live vehicle in the world. */
function nearestVehicle(W) {
  const pl = W?.player ?? {};
  const px = Number(pl.x), py = Number(pl.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  let best = null, bestD2 = Infinity;
  const scan = (list) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const c = entry?.car ?? entry;
      if (!c || c.wrecked) continue;
      const cx = Number(c.x), cy = Number(c.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (c === pl.car) continue;                 // the one you are already in
      const d2 = (cx - px) ** 2 + (cy - py) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = c; }
    }
  };
  scan(W.parked);
  scan(W.traffic?.list);
  if (!best) return null;
  return { car: best, dist: Math.sqrt(bestD2) };
}

/*
 * The side job the tracker card follows. `world.sideJob` wins when a caller
 * supplies one; otherwise the free "gig" objective (missions.js marks those
 * with `free: true`) stands in for it.
 */
function sideJobOf(W) {
  const explicit = W?.sideJob;
  if (explicit && (explicit.name || explicit.title)) {
    const prog = Number.isFinite(explicit.progress) ? clamp(explicit.progress, 0, 1)
      : (Number.isFinite(explicit.step) && Number.isFinite(explicit.steps) && explicit.steps > 0
        ? clamp(explicit.step / explicit.steps, 0, 1) : null);
    return {
      name: explicit.name ?? explicit.title,
      detail: explicit.detail ?? explicit.text ?? '',
      reward: Number.isFinite(explicit.reward) ? explicit.reward
        : (Number.isFinite(explicit.pay) ? explicit.pay : null),
      progress: prog,
      step: Number.isFinite(explicit.step) ? explicit.step : null,
      steps: Number.isFinite(explicit.steps) ? explicit.steps : null,
      x: Number.isFinite(explicit.x) ? explicit.x : null,
      y: Number.isFinite(explicit.y) ? explicit.y : null,
    };
  }
  const obj = W?.objective;
  if (!obj || obj.free !== true) return null;
  const prog = Number.isFinite(obj.progress) ? clamp(obj.progress, 0, 1)
    : (Number.isFinite(obj.step) && Number.isFinite(obj.steps) && obj.steps > 0
      ? clamp(obj.step / obj.steps, 0, 1) : null);
  return {
    name: obj.title ?? 'Side job',
    detail: obj.detail ?? '',
    reward: Number.isFinite(obj.pay) ? obj.pay : null,
    progress: prog,
    step: Number.isFinite(obj.step) ? obj.step : null,
    steps: Number.isFinite(obj.steps) ? obj.steps : null,
    x: Number.isFinite(obj.x) ? obj.x : null,
    y: Number.isFinite(obj.y) ? obj.y : null,
  };
}

/* ------------------------------------------------------------------ */
/* HUD factory                                                         */
/* ------------------------------------------------------------------ */

export function createHud() {
  /* transient screen messages */
  const notes = [];
  let noteSeq = 0;

  /* animation bookkeeping */
  let hpGhost = 1;
  let lastHp = null;
  let lastMoney = null;
  let lastWanted = 0;
  let cashDelta = 0;
  let cashTimer = 0;
  let hurtTimer = 0;
  let wantedTimer = 0;
  let lastTime = 0;

  function canvasFrame(ctx, fn) {
    ctx.save();
    const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    let sx = Math.abs(m.a) > 0.01 ? Math.abs(m.a) : 1;
    let sy = Math.abs(m.d) > 0.01 ? Math.abs(m.d) : 1;
    const rot = Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6;
    const mov = Math.abs(m.e) > 0.5 || Math.abs(m.f) > 0.5;
    if (rot || mov) { sx = 1; sy = 1; ctx.setTransform(1, 0, 0, 1, 0, 0); }
    const c = ctx.canvas;
    const w = Math.max(320, Math.round((c?.width || 1280) / sx));
    const h = Math.max(240, Math.round((c?.height || 720) / sy));
    fn(w, h);
    ctx.restore();
  }

  function say(t, secs = TOAST_DEFAULT, kind = 'info') {
    const text = String(t ?? '');
    if (!text) return;
    const dur = Number.isFinite(secs) && secs > 0 ? secs : TOAST_DEFAULT;
    const k = KIND_COLORS[kind] ? kind : 'info';
    notes.push({ id: ++noteSeq, text, kind: k, dur, left: dur });
    while (notes.length > TOAST_LIMIT) notes.shift();
  }

  function clearMessages() {
    notes.length = 0;
  }

  function update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (let i = notes.length - 1; i >= 0; i--) {
      notes[i].left -= dt;
      if (notes[i].left <= 0) notes.splice(i, 1);
    }
    if (cashTimer > 0) cashTimer = Math.max(0, cashTimer - dt);
    if (hurtTimer > 0) hurtTimer = Math.max(0, hurtTimer - dt);
    if (wantedTimer > 0) wantedTimer = Math.max(0, wantedTimer - dt);
  }

  /* frame delta derived from the simulation clock, so sizing/easing stays
     stable even when the world does not pass a dt into the draw calls */
  function frameDt(W) {
    const t = Number.isFinite(W.time) ? W.time : lastTime + 1 / 60;
    const d = clamp(t - lastTime, 0, 0.25);
    lastTime = t;
    return d > 0 ? d : 1 / 60;
  }

  function leftSpace(w) {
    return Math.max(200, Math.min(OBJ_W, w - EDGE - RIGHT_GAP - CASH_W - PANEL_GAP - 24));
  }

  /* ---------------------------------------------------------------- */
  /* vitals: health, stamina, wanted stars                             */
  /* ---------------------------------------------------------------- */

  function drawStats(ctx, W, w, dt) {
    const p = W.player ?? {};
    const hp = clamp(Number(p.health ?? 0), 0, 100);
    const hpFrac = hp / 100;
    const wanted = clamp(Number(W.wanted ?? 0), 0, MAX_WANTED);
    const stars = Math.round(wanted);
    const staminaMax = Number.isFinite(p.staminaMax) && p.staminaMax > 0 ? p.staminaMax : 100;
    const stamina = clamp(Number(p.stamina ?? staminaMax), 0, staminaMax);
    const staminaFrac = stamina / staminaMax;

    /* damage trail + transient timers */
    if (lastHp != null && hp < lastHp - 0.4) hurtTimer = 0.9;
    lastHp = hp;
    if (hp < hpGhost) hpGhost = Math.max(hpFrac, hpGhost - dt * 0.55);
    else hpGhost = hpFrac;

    if (wanted > lastWanted + 0.05) wantedTimer = 1.7;
    lastWanted = wanted;

    const x = EDGE, y = EDGE;
    const wid = Math.min(STATUS_W, leftSpace(w));
    const inner = Math.max(0, wid - PADDING * 2);
    box(ctx, x, y, wid, STATUS_H);

    /* health ------------------------------------------------------- */
    tag(ctx, 'HEALTH', x + PADDING, y + 24);
    num(ctx, `${Math.round(hp)}`, x + wid - PADDING - 18, y + 24, 13,
      hp <= 30 ? COLORS.red : COLORS.cream, 60);
    font(ctx, 9, '700');
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('/100', x + wid - PADDING, y + 24);

    const hbY = y + 32;
    bar(ctx, x + PADDING, hbY, inner, 14, hpFrac,
      hp <= 30 ? COLORS.red : (hp <= 60 ? COLORS.gold : COLORS.green),
      hpGhost);
    if (hurtTimer > 0) {
      roundRect(ctx, x + PADDING, hbY, inner, 14, 7);
      ctx.strokeStyle = `rgba(232, 102, 91, ${0.22 + 0.5 * (hurtTimer / 0.9)})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    /* stamina ------------------------------------------------------ */
    tag(ctx, 'STAMINA', x + PADDING, y + 66);
    const ex = !!p.exhausted;
    num(ctx, ex ? 'SPENT' : `${Math.round(staminaFrac * 100)}%`,
      x + wid - PADDING, y + 66, 10, ex ? COLORS.red : COLORS.muted, 60, '700');
    bar(ctx, x + PADDING, y + 72, inner, 6, staminaFrac,
      ex ? COLORS.red : 'rgba(126, 190, 214, 0.95)', null);

    /* wanted ------------------------------------------------------- */
    const starY = y + 104;
    const starR = 10;
    const gap = 26;
    tag(ctx, 'WANTED', x + PADDING, y + 95);
    const label = stars <= 0 ? 'CLEAR' : `${stars}/${MAX_WANTED}`;
    num(ctx, label, x + wid - PADDING, y + 95, 10,
      stars <= 0 ? COLORS.green : COLORS.gold, 60);

    const glow = wantedTimer > 0 ? 8 + 6 * Math.sin((1.7 - wantedTimer) * 16) : 0;
    for (let i = 0; i < MAX_WANTED; i++) {
      const frac = clamp(wanted - i, 0, 1);
      const hue = STAR_HUES[Math.min(i, STAR_HUES.length - 1)];
      const cx = x + PADDING + starR + i * gap;
      if (cx + starR > x + wid - PADDING) break;
      star(ctx, cx, starY, starR, hue, frac, frac > 0 ? Math.max(0, glow) : 0);
    }

    /* heat spike: a red frame around the star row plus a HEAT UP flag */
    if (wantedTimer > 0) {
      const k = clamp(wantedTimer / 1.7, 0, 1);
      const beat = 0.5 + 0.5 * Math.sin((1.7 - wantedTimer) * 21);
      ctx.save();
      ctx.globalAlpha = (0.30 + 0.45 * beat) * k;
      roundRect(ctx, x + PADDING - 5, starY - starR - 6,
        Math.min(inner + 10, starR * 2 + gap * (MAX_WANTED - 1) + 10), starR * 2 + 12, 7);
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      font(ctx, 8, '800');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.red;
      ctx.fillText('HEAT UP', x + PADDING, starY - starR - 12);
      ctx.restore();
    }

    /* police presence chip */
    const units = Array.isArray(W.police?.cars) ? W.police.cars.length : 0;
    if (units > 0) {
      font(ctx, 9, '700');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.red;
      ctx.fillText(`POLICE ${units}`, x + wid - PADDING, starY + 4);
    }

    /* save status */
    if (W.saveStatus && W.saveStatus !== 'none') {
      const sw = 96;
      if (inner > 300) {
        font(ctx, 9, '600');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(169, 179, 184, 0.8)';
        ctx.fillText(`SAVE \u00b7 ${String(W.saveStatus).toUpperCase()}`, x + PADDING, starY + 20);
      }
      void sw;
    }
  }

  /* ---------------------------------------------------------------- */
  /* mission tracker                                                   */
  /* ---------------------------------------------------------------- */

  function drawObjective(ctx, W, w) {
    const obj = W.objective;
    const x = EDGE;
    const y = EDGE + STATUS_H + PANEL_GAP;
    const wid = leftSpace(w);
    const inner = Math.max(0, wid - PADDING * 2);
    const job = Math.max(1, Math.round(W.jobsDone ?? 0) + 1);

    if (!obj) {
      box(ctx, x, y, wid, 54);
      tag(ctx, 'MISSION TRACKER', x + PADDING, y + 22);
      font(ctx, 12, '600');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText('No active job \u00b7 look for a gold marker', x + PADDING, y + 40);
      return;
    }

    box(ctx, x, y, wid, OBJ_H);

    /* header: stage dots on the right */
    tag(ctx, `MISSION \u00b7 JOB ${job}`, x + PADDING, y + 23);
    const dots = 5;
    const cycle = Math.max(0, Math.round(W.jobsDone ?? 0)) % dots;
    for (let i = 0; i < dots; i++) {
      const dx = x + wid - PADDING - (dots - 1 - i) * 12 - 3;
      ctx.beginPath();
      ctx.arc(dx, y + 19, 3, 0, Math.PI * 2);
      ctx.fillStyle = i <= cycle ? COLORS.gold : 'rgba(247, 241, 226, 0.18)';
      ctx.fill();
    }

    /* title + payout */
    font(ctx, 15, '700');
    const pay = Number.isFinite(obj.pay) ? formatMoney(obj.pay) : '';
    const pw = pay ? Math.min(inner * 0.5, ctx.measureText(pay).width) : 0;
    const tw = Math.max(60, inner - (pay ? pw + 16 : 0));
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + PADDING, y + 32, tw, 22);
    ctx.clip();
    ctx.translate(x + PADDING, y + 50);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.gold;
    fit(ctx, obj.title ?? 'Job', tw);
    ctx.restore();
    if (pay) num(ctx, pay, x + wid - PADDING, y + 50, 15, COLORS.green, inner * 0.5, '800');

    /* detail + distance */
    const pl = W.player ?? {};
    const hasPt = Number.isFinite(obj.x) && Number.isFinite(obj.y) && Number.isFinite(pl.x) && Number.isFinite(pl.y);
    const dist = hasPt ? `${Math.max(0, Math.round(Math.hypot(obj.x - pl.x, obj.y - pl.y) / 10))} m` : '';
    font(ctx, 10, '600');
    const dw = dist ? Math.min(inner * 0.4, ctx.measureText(dist).width) : 0;
    const det = Math.max(60, inner - (dist ? dw + 16 : 0));
    font(ctx, 12, '500');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + PADDING, y + 58, det, 20);
    ctx.clip();
    ctx.translate(x + PADDING, y + 74);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(247, 241, 226, 0.82)';
    fit(ctx, obj.detail ?? '', det);
    ctx.restore();
    if (dist) {
      font(ctx, 10, '600');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(dist, x + wid - PADDING, y + 74, Math.max(0, inner * 0.4));
    }

    /* progress */
    const prog = Number.isFinite(obj.progress)
      ? clamp(obj.progress, 0, 1)
      : (Number.isFinite(obj.step) && Number.isFinite(obj.steps) && obj.steps > 0
        ? clamp(obj.step / obj.steps, 0, 1)
        : null);
    const pct = prog == null ? '' : `${Math.round(prog * 100)}%`;
    font(ctx, 9, '700');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.muted;
    if (pct) ctx.fillText(pct, x + wid - PADDING, y + 92);
    if (prog == null) {
      rule(ctx, x + PADDING, y + 96, inner, 0.10);
    } else {
      bar(ctx, x + PADDING, y + 94, inner - (pct ? 40 : 0), 5, prog, COLORS.gold, null);
    }
    font(ctx, 9, '600');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`DAY ${Math.max(1, Math.round(W.day ?? 1))} \u00b7 ${formatClock(W.clock ?? 0)}`,
      x + PADDING, y + 108);
  }

  /* ---------------------------------------------------------------- */
  /* cash + clock                                                      */
  /* ---------------------------------------------------------------- */

  function drawCash(ctx, W, w, dt) {
    const p = W.player ?? {};
    const money = Number(p.money ?? 0);
    if (lastMoney == null) lastMoney = money;
    if (Math.abs(money - lastMoney) >= 1) {
      cashDelta = money - lastMoney;
      cashTimer = 2.4;
      lastMoney = money;
    }

    const wid = Math.min(CASH_W, Math.max(184, w - EDGE - RIGHT_GAP - 40));
    const x = w - RIGHT_GAP - wid;
    const y = EDGE;
    const inner = Math.max(0, wid - PADDING * 2);
    box(ctx, x, y, wid, CASH_H);

    tag(ctx, 'CASH', x + PADDING, y + 24);
    if (p.weapon && p.weapon !== 'fist') {
      font(ctx, 9, '700');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`${String(p.weapon).toUpperCase()} ${Math.max(0, Math.round(p.ammo ?? 0))}`,
        x + wid - PADDING, y + 24);
    }

    const txt = formatMoney(money);
    const room = Math.max(40, inner - 52);
    font(ctx, 26, '800');
    const nat = ctx.measureText(txt).width;
    const sz = nat > room ? Math.max(14, Math.floor((26 * room) / nat)) : 26;
    font(ctx, sz, '800');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = money < 0 ? COLORS.red : COLORS.green;
    ctx.fillText(txt, x + wid - PADDING, y + 48);

    if (cashTimer > 0 && cashDelta !== 0) {
      const a = clamp(cashTimer / 0.5, 0, 1);
      ctx.globalAlpha = a;
      font(ctx, 11, '700');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = cashDelta > 0 ? COLORS.green : COLORS.red;
      ctx.fillText(`${cashDelta > 0 ? '+' : '\u2212'}${formatMoney(Math.abs(cashDelta))}`,
        x + PADDING, y + 48);
      ctx.globalAlpha = 1;
    }

    rule(ctx, x + PADDING, y + 60, inner, 0.10);

    /* clock + daylight ------------------------------------------- */
    const clk = formatClock(W.clock ?? 0);
    const light = daylight(W.clock ?? 0);
    font(ctx, 22, '700');
    const cw = ctx.measureText(clk).width;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.cream;
    ctx.fillText(clk, x + PADDING, y + 90);

    /* sun / moon glyph, half-filled to show how deep into the phase we are */
    const gx = x + PADDING + cw + 16;
    const gy = y + 82;
    const gr = 7;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    if (light.night < 0.5) {
      ctx.fillStyle = light.tint;
      ctx.fill();
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(247, 241, 226, 0.10)';
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(gx, gy, gr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * light.night);
      ctx.lineTo(gx, gy);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = light.tint;
      ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* phase label on the right edge of the clock row */
    font(ctx, 9, '800');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = light.tint;
    if (inner > 190) ctx.fillText(light.label, x + wid - PADDING, y + 84);
    font(ctx, 9, '600');
    ctx.fillStyle = COLORS.muted;
    if (inner > 190) ctx.fillText(`DAY ${Math.max(1, Math.round(W.day ?? 1))}`, x + wid - PADDING, y + 96);

    /* 24h light strip: night on the ends, day through the middle */
    const sy = y + 104;
    const sw2 = inner;
    roundRect(ctx, x + PADDING, sy, sw2, 6, 3);
    ctx.fillStyle = 'rgba(247, 241, 226, 0.10)';
    ctx.fill();
    const dayStart = 5 / 24, dayEnd = 19.5 / 24;
    roundRect(ctx, x + PADDING + sw2 * dayStart, sy, sw2 * (dayEnd - dayStart), 6, 3);
    ctx.fillStyle = 'rgba(242, 199, 92, 0.34)';
    ctx.fill();
    const mins = ((Number(W.clock) || 0) % 1440 + 1440) % 1440;
    const mx = x + PADDING + sw2 * (mins / 1440);
    ctx.beginPath();
    ctx.arc(mx, sy + 3, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = light.night < 0.5 ? COLORS.gold : COLORS.blue;
    ctx.fill();
    ctx.strokeStyle = 'rgba(10, 18, 24, 0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    /* jobs + speed summary strip */
    rule(ctx, x + PADDING, y + 122, inner, 0.08);
    const jobs = Math.max(0, Math.round(W.jobsDone ?? 0));
    const pos = p.car && Number.isFinite(p.car.x) ? p.car : null;
    font(ctx, 10, '600');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`JOBS ${jobs}`, x + PADDING, y + 140);
    if (pos) {
      const kmh = Math.round(Math.abs(Number(pos.speed) || 0) / SPEED_SCALE);
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.cream;
      ctx.fillText(`${kmh} km/h \u00b7 ${gearFor(pos)}`, x + wid - PADDING, y + 140);
    } else {
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText('ON FOOT', x + wid - PADDING, y + 140);
    }

    /* wanted word under the strip, so the top-right panel reads at a glance */
    const wl = clamp(Math.round(Number(W.wanted ?? 0)), 0, MAX_WANTED);
    font(ctx, 9, '700');
    ctx.textAlign = 'left';
    ctx.fillStyle = wl <= 0 ? COLORS.green : COLORS.red;
    ctx.fillText(wl <= 0 ? 'NO HEAT' : `HEAT ${'\u2605'.repeat(wl)}`, x + PADDING, y + 156);
    void dt;
  }

  /* ---------------------------------------------------------------- */
  /* speedometer / movement gauge                                      */
  /* ---------------------------------------------------------------- */

  function drawSpeedo(ctx, W, w, h) {
    const p = W.player ?? {};
    const car = p.car && Number.isFinite(p.car.x) ? p.car : null;
    const cx = Math.round(w / 2);
    const pillTop = h - BOTTOM_GAP - 60;
    const cy = pillTop - 78;
    const r = 62;

    const kmh = car ? Math.abs(Number(car.speed) || 0) / SPEED_SCALE : 0;
    const frac = car
      ? clamp(kmh / SPEED_MAX_KMH, 0, 1)
      : clamp((Number(p.stamina ?? 100) / (Number(p.staminaMax) || 100)), 0, 1);
    const col = car ? speedColor(frac) : COLORS.cream;

    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;

    /* dial plate */
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 18, 24, 0.62)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 248, 230, 0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* track + value arc */
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.strokeStyle = 'rgba(247, 241, 226, 0.13)';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.stroke();

    if (frac > 0.002) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac);
      ctx.strokeStyle = col;
      ctx.lineWidth = 9;
      ctx.stroke();
    }

    /* ticks */
    for (let i = 0; i <= 8; i++) {
      const ang = a0 + ((a1 - a0) * i) / 8;
      const on = i / 8 <= frac + 0.001;
      const r1 = r - 9;
      const r2 = on ? r1 - 6 : r1 - 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
      ctx.strokeStyle = on ? 'rgba(247, 241, 226, 0.62)' : 'rgba(247, 241, 226, 0.20)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    /* needle */
    const na = a0 + (a1 - a0) * frac;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(na) * (r * 0.30), cy + Math.sin(na) * (r * 0.30));
    ctx.lineTo(cx + Math.cos(na) * (r - 12), cy + Math.sin(na) * (r - 12));
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    /* readout */
    font(ctx, 22, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.cream;
    ctx.fillText(car ? `${Math.round(kmh)}` : '--', cx, cy + 4);
    font(ctx, 9, '700');
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(car ? 'KM/H' : 'ON FOOT', cx, cy + 18);

    if (car) {
      const gear = gearFor(car);
      const badgeCol = gear === 'R' ? COLORS.red : (gear === 'H' ? COLORS.gold : COLORS.green);
      roundRect(ctx, cx - 11, cy - r * 0.62, 22, 18, 4);
      ctx.fillStyle = 'rgba(247, 241, 226, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      font(ctx, 11, '800');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = badgeCol;
      ctx.fillText(gear, cx, cy - r * 0.62 + 9.5);

      /* vehicle condition */
      const hpMax = Number.isFinite(car.maxHealth) && car.maxHealth > 0 ? car.maxHealth : 100;
      const chp = clamp(Number(car.health ?? hpMax) / hpMax, 0, 1);
      const bw = 74;
      bar(ctx, cx - bw / 2, cy + r - 4, bw, 5, chp,
        chp <= 0.3 ? COLORS.red : (chp <= 0.6 ? COLORS.gold : COLORS.green), null);
      if (car.wrecked) {
        font(ctx, 8, '800');
        ctx.fillStyle = COLORS.red;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('WRECKED', cx, cy + r + 16);
      }
    } else {
      /* on-foot stamina ring detail */
      font(ctx, 8, '600');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText('SHIFT TO RUN', cx, cy + r + 4);
    }
  }

  /* ---------------------------------------------------------------- */
  /* minimap                                                           */
  /* ---------------------------------------------------------------- */

  function drawMap(ctx, W, w, h) {
    const sz = MAP_SIZE;
    const x = w - RIGHT_GAP - sz;
    const y = h - BOTTOM_GAP - sz;
    const city = W.city;
    const pl = W.player ?? {};
    const view = W.view ?? {};
    const px = Number.isFinite(pl.x) ? pl.x : 0;
    const py = Number.isFinite(pl.y) ? pl.y : 0;
    roundRect(ctx, x, y, sz, sz, 10);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(28, 61, 74, 0.92)';
    ctx.fillRect(x, y, sz, sz);
    if (city) {
      const zoom = Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom : 1;
      const span = Number.isFinite(view.width) && view.width > 0 ? view.width : (Number.isFinite(view.w) && view.w > 0 ? view.w : 1280);
      const wpp = span / zoom / (sz * MAP_VIEW_RATIO);
      const sc = 1 / wpp;
      const mx = x + sz / 2;
      const my = y + sz / 2;
      const toX = (wx) => mx + (wx - px) * sc;
      const toY = (wy) => my + (wy - py) * sc;
      const cw = Number(city.width ?? city.shoreline ?? 0);
      const ch = Number(city.height ?? 0);
      const shore = Number(city.shoreline ?? cw);
      const sand = Number(city.beach?.w ?? city.beachWidth ?? CITY.beachWidth);
      const water = Number(city.water?.w ?? city.waterWidth ?? CITY.waterWidth);
      const block = Number(city.blockSize ?? city.block ?? CITY.block);
      const road = Number(city.roadWidth ?? city.road ?? CITY.road);
      const cols = Number(city.cols ?? CITY.cols);
      const rows = Number(city.rows ?? CITY.rows);
      if (ch > 0) {
        ctx.fillStyle = 'rgba(34, 127, 155, 0.95)';
        ctx.fillRect(toX(shore), toY(0), Math.max(1, water * sc), ch * sc);
        ctx.fillStyle = 'rgba(232, 208, 166, 0.95)';
        ctx.fillRect(toX(shore - sand), toY(0), Math.max(1, sand * sc), ch * sc);
        ctx.fillStyle = 'rgba(194, 187, 172, 0.92)';
        ctx.fillRect(toX(0), toY(0), Math.max(1, shore * sc), ch * sc);
      }
      if (ch > 0 && block > 0) {
        ctx.strokeStyle = 'rgba(61, 66, 75, 0.95)';
        ctx.lineWidth = Math.max(1, road * sc);
        ctx.beginPath();
        for (let c = 0; c <= cols; c++) {
          const wx = c * (block + road) + road / 2;
          ctx.moveTo(toX(wx), toY(-road));
          ctx.lineTo(toX(wx), toY(ch + road));
        }
        for (let r = 0; r <= rows; r++) {
          const wy = r * (block + road) + road / 2;
          ctx.moveTo(toX(-road), toY(wy));
          ctx.lineTo(toX(shore + road), toY(wy));
        }
        ctx.stroke();
      }
      if (W.traffic && Array.isArray(W.traffic.list)) {
        ctx.fillStyle = 'rgba(247, 241, 226, 0.72)';
        for (const c of W.traffic.list) {
          if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
          ctx.fillRect(toX(c.x) - 1, toY(c.y) - 1, 2, 2);
        }
      }
      if (Array.isArray(W.parked)) {
        ctx.fillStyle = 'rgba(242, 199, 92, 0.60)';
        for (const c of W.parked) {
          if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
          ctx.fillRect(toX(c.x) - 1, toY(c.y) - 1, 2, 2);
        }
      }
      if (Array.isArray(W.police?.cars)) {
        ctx.fillStyle = 'rgba(120, 170, 255, 0.85)';
        for (const u of W.police.cars) {
          const c = u?.car ?? u;
          if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
          ctx.fillRect(toX(c.x) - 1.5, toY(c.y) - 1.5, 3, 3);
        }
      }
      const obj = W.objective;
      if (obj && Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
        const ox = toX(obj.x), oy = toY(obj.y);
        const pulse = 5.5 + Math.sin((Number.isFinite(W.time) ? W.time : 0) * 3.4) * 1.4;
        ctx.strokeStyle = COLORS.gold;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(ox, oy, pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ox, oy, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.gold;
        ctx.fill();
        const dx = ox - mx, dy = oy - my;
        const len = Math.hypot(dx, dy);
        const reach = sz / 2 - 12;
        if (len > reach) {
          const n = reach / len;
          ctx.beginPath();
          ctx.moveTo(mx + dx * n, my + dy * n);
          ctx.lineTo(mx + dx * n * 0.72, my + dy * n * 0.72);
          ctx.strokeStyle = 'rgba(242, 199, 92, 0.55)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      const heading = Number.isFinite(pl.facing) ? pl.facing : 0;
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(heading);
      ctx.beginPath();
      ctx.moveTo(6.5, 0);
      ctx.lineTo(-4, 4.2);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, -4.2);
      ctx.closePath();
      ctx.fillStyle = COLORS.cream;
      ctx.fill();
      ctx.restore();
      const fade = ctx.createRadialGradient(mx, my, sz * 0.28, mx, my, sz * 0.72);
      fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
      fade.addColorStop(1, 'rgba(4, 9, 12, 0.42)');
      ctx.fillStyle = fade;
      ctx.fillRect(x, y, sz, sz);
      rose(ctx, x + sz - 18, y + 18, 12, heading);
    }
    ctx.restore();
    roundRect(ctx, x + 0.5, y + 0.5, sz - 1, sz - 1, 10);
    ctx.strokeStyle = COLORS.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* ---------------------------------------------------------------- */
  /* compass ribbon: mission + nearest-vehicle bearings                */
  /* ---------------------------------------------------------------- */

  function drawCompass(ctx, W, w, h) {
    const pl = W.player ?? {};
    const px = Number(pl.x), py = Number(pl.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;

    /* keep clear of the status panel on the left and the cash panel right */
    const leftLimit = EDGE + Math.min(STATUS_W, 320) + PANEL_GAP + 12;
    const rightLimit = w - RIGHT_GAP - CASH_W - PANEL_GAP - 12;
    const room = rightLimit - leftLimit;
    if (room < COMPASS_W * 0.7) return;

    const bw = Math.min(COMPASS_W, room);
    const bx = Math.round((leftLimit + rightLimit) / 2 - bw / 2);
    const by = EDGE - 4;
    const bh = 40;
    const half = bw / 2;
    const headDeg = (((playerHeading(pl) * 180) / Math.PI) + 90 + 360) % 360;

    /* plate */
    roundRect(ctx, bx, by, bw, bh, 9);
    ctx.fillStyle = 'rgba(10, 18, 24, 0.76)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 248, 230, 0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, bx, by, bw, bh, 9);
    ctx.clip();

    const pxPerDeg = half / COMPASS_FIELD;
    const centreX = bx + half;
    const axisY = by + bh - 12;

    /* ticks every 15 degrees across the visible arc */
    const first = Math.ceil((headDeg - COMPASS_FIELD) / 15) * 15;
    for (let d = first; d <= headDeg + COMPASS_FIELD; d += 15) {
      const rel = d - headDeg;
      const tx = centreX + rel * pxPerDeg;
      const major = ((d % 90) + 360) % 90 === 0;
      const mid = ((d % 45) + 360) % 45 === 0;
      const len = major ? 9 : (mid ? 6 : 3.5);
      const fade = 1 - Math.min(1, Math.abs(rel) / COMPASS_FIELD) * 0.55;
      ctx.beginPath();
      ctx.moveTo(tx, axisY);
      ctx.lineTo(tx, axisY - len);
      ctx.strokeStyle = major
        ? `rgba(247, 241, 226, ${0.78 * fade})`
        : `rgba(247, 241, 226, ${0.34 * fade})`;
      ctx.lineWidth = major ? 1.4 : 1;
      ctx.stroke();
    }

    /* cardinal letters */
    font(ctx, 11, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let d = Math.floor((headDeg - COMPASS_FIELD) / 45) * 45; d <= headDeg + COMPASS_FIELD; d += 45) {
      const rel = d - headDeg;
      if (Math.abs(rel) > COMPASS_FIELD - 4) continue;
      const tx = centreX + rel * pxPerDeg;
      const norm = ((d % 360) + 360) % 360;
      const name = cardinalOf(norm);
      const fade = 1 - Math.min(1, Math.abs(rel) / COMPASS_FIELD) * 0.5;
      ctx.fillStyle = name === 'N'
        ? `rgba(242, 199, 92, ${fade})`
        : `rgba(207, 214, 217, ${0.9 * fade})`;
      ctx.fillText(name, tx, by + 17);
    }

    /* bearing markers -------------------------------------------------- */
    const drawMarker = (targetDeg, color, glyph, label) => {
      const rel = ((targetDeg - headDeg + 540) % 360) - 180;   // signed, -180..180
      const off = Math.abs(rel) > COMPASS_FIELD;
      const clamped = clamp(rel, -COMPASS_FIELD, COMPASS_FIELD);
      const tx = centreX + clamped * pxPerDeg;
      const ty = by + 26;

      if (glyph === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(tx, ty - 5);
        ctx.lineTo(tx + 5, ty);
        ctx.lineTo(tx, ty + 5);
        ctx.lineTo(tx - 5, ty);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(10, 18, 24, 0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(tx, ty - 4.5);
        ctx.lineTo(tx + 4.5, ty + 3.5);
        ctx.lineTo(tx - 4.5, ty + 3.5);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }

      /* off-axis targets get a chevron so the player knows to turn */
      if (off) {
        const dir = rel > 0 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(tx + dir * 7, ty);
        ctx.lineTo(tx + dir * 2, ty - 4);
        ctx.lineTo(tx + dir * 2, ty + 4);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.75;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      if (label) {
        font(ctx, 8, '700');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = color;
        ctx.fillText(label, tx, by + 37);
      }
      return targetDeg;
    };

    const obj = W.objective;
    if (obj && Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
      const deg = bearing(obj.x, obj.y, px, py);
      const m = Math.max(0, Math.round(Math.hypot(obj.x - px, obj.y - py) / 10));
      drawMarker(deg, COLORS.gold, 'diamond', `${cardinalOf(deg)} ${m}m`);
    }

    const veh = nearestVehicle(W);
    if (veh) {
      const deg = bearing(veh.car.x, veh.car.y, px, py);
      drawMarker(deg, 'rgba(126, 190, 214, 0.95)', 'triangle', null);
    }

    /* centre needle + nose tint */
    ctx.beginPath();
    ctx.moveTo(centreX, by + bh - 2);
    ctx.lineTo(centreX - 4, by + bh - 9);
    ctx.lineTo(centreX + 4, by + bh - 9);
    ctx.closePath();
    ctx.fillStyle = 'rgba(247, 241, 226, 0.85)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(centreX, by + 1);
    ctx.lineTo(centreX - 5, by + 8);
    ctx.lineTo(centreX + 5, by + 8);
    ctx.closePath();
    ctx.fillStyle = 'rgba(242, 199, 92, 0.9)';
    ctx.fill();

    ctx.restore();

    /* heading readout, right-aligned inside the plate */
    font(ctx, 9, '700');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(169, 179, 184, 0.9)';
    ctx.fillText(`${String(Math.round(headDeg) % 360).padStart(3, '0')}\u00b0`,
      bx + bw - 8, by + bh - 4);
    void h;
  }

  /* ---------------------------------------------------------------- */
  /* side-job tracker (right edge, under the cash panel)               */
  /* ---------------------------------------------------------------- */

  function drawSideJob(ctx, W, w, dt) {
    const job = sideJobOf(W);
    const wid = Math.min(SIDE_W, Math.max(190, w - EDGE - RIGHT_GAP - 40));
    if (wid < 190) return;
    const x = w - RIGHT_GAP - wid;
    /* on narrow canvases the left column already owns this band; skip rather
       than draw one panel on top of another */
    if (x < EDGE + 236) return;
    const y = EDGE + CASH_H + PANEL_GAP;
    const inner = Math.max(0, wid - PADDING * 2);

    if (!job) {
      box(ctx, x, y, wid, SIDE_IDLE_H);
      tag(ctx, 'SIDE MISSIONS', x + PADDING, y + 22);
      font(ctx, 11, '600');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText('None active', x + PADDING, y + 42);
      font(ctx, 10, '600');
      ctx.fillStyle = 'rgba(169, 179, 184, 0.7)';
      ctx.fillText('Gigs appear as gold pins', x + PADDING, y + 60);
      return;
    }

    /* pulse the frame when a step is about to complete */
    const pulse = job.progress == null
      ? 0
      : clamp(0.32 + 0.28 * Math.sin((Number(W.time) || 0) * 3.2), 0, 1);

    box(ctx, x, y, wid, SIDE_H);
    roundRect(ctx, x + 0.5, y + 0.5, wid - 1, SIDE_H - 1, 10);
    ctx.strokeStyle = `rgba(242, 199, 92, ${0.22 + pulse * 0.25})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    /* accent stripe: reads as "optional content" next to the gold objective */
    roundRect(ctx, x, y + 10, 3, SIDE_H - 20, 1.5);
    ctx.fillStyle = 'rgba(242, 199, 92, 0.8)';
    ctx.fill();

    tag(ctx, 'SIDE MISSION', x + PADDING, y + 22);

    /* step counter on the header row */
    if (Number.isFinite(job.step) && Number.isFinite(job.steps)) {
      num(ctx, `${job.step}/${job.steps}`, x + wid - PADDING, y + 22, 10, COLORS.muted, 60, '700');
    }

    /* name */
    font(ctx, 14, '700');
    const nameW = inner - (Number.isFinite(job.reward) ? 78 : 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + PADDING, y + 28, Math.max(40, nameW), 22);
    ctx.clip();
    ctx.translate(x + PADDING, y + 46);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.gold;
    fit(ctx, job.name, Math.max(40, nameW));
    ctx.restore();

    /* reward */
    if (Number.isFinite(job.reward)) {
      num(ctx, formatMoney(job.reward), x + wid - PADDING, y + 46, 13, COLORS.green, 74, '800');
    }

    /* detail line */
    if (job.detail) {
      font(ctx, 11, '500');
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + PADDING, y + 52, inner, 18);
      ctx.clip();
      ctx.translate(x + PADDING, y + 64);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(247, 241, 226, 0.78)';
      fit(ctx, job.detail, inner);
      ctx.restore();
    }

    /* progress bar + distance to the side marker */
    const pl = W.player ?? {};
    const hasPt = Number.isFinite(job.x) && Number.isFinite(job.y)
      && Number.isFinite(pl.x) && Number.isFinite(pl.y);
    const dist = hasPt ? Math.round(Math.hypot(job.x - pl.x, job.y - pl.y) / 10) : null;
    const barW = inner - (dist != null ? 62 : 0);
    if (job.progress == null) {
      rule(ctx, x + PADDING, y + 84, barW, 0.10);
    } else {
      bar(ctx, x + PADDING, y + 78, barW, 7, job.progress, COLORS.gold, null);
      font(ctx, 9, '700');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`${Math.round(job.progress * 100)}%`, x + PADDING, y + 98);
    }
    if (dist != null) {
      font(ctx, 10, '700');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.cream;
      ctx.fillText(`${dist} m`, x + wid - PADDING, y + 87);
    }

    /* footer hint */
    font(ctx, 8, '700');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(169, 179, 184, 0.7)';
    ctx.fillText('OPTIONAL \u00b7 NO TIMER', x + PADDING, y + 110);
    void dt;
  }

  /* ---------------------------------------------------------------- */
  /* wanted surge: red breathing vignette around the frame              */
  /* ---------------------------------------------------------------- */

  function drawHeatPulse(ctx, W, w, h) {
    if (wantedTimer <= 0) return;
    const k = clamp(wantedTimer / 1.7, 0, 1);
    /* two beats per surge, easing out as the timer drains */
    const beat = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin((1.7 - wantedTimer) * 12), 2);
    const a = k * beat * 0.42;

    const band = Math.max(46, Math.min(w, h) * 0.11);
    const edge = (x0, y0, x1, y1, rx, ry, rw, rh) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(232, 102, 91, ${a})`);
      g.addColorStop(1, 'rgba(232, 102, 91, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    };

    ctx.save();
    edge(0, 0, 0, band, 0, 0, w, band);            // top
    edge(0, h, 0, h - band, 0, h - band, w, band); // bottom
    edge(0, 0, band, 0, 0, 0, band, h);            // left
    edge(w, 0, w - band, 0, w - band, 0, band, h); // right
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* hint strip                                                        */
  /* ---------------------------------------------------------------- */

  function drawHint(ctx, W, w, h) {
    const p = W.player ?? {};
    const car = p.car && Number.isFinite(p.car.x) ? p.car : null;
    const kmh = car ? Math.round(Math.abs(Number(car.speed) || 0) / SPEED_SCALE) : 0;
    let txt;
    if (car) {
      txt = `${kmh} km/h \u00b7 ${gearFor(car)} \u00b7 SPACE handbrake \u00b7 E to step out`;
    } else if (W.objective) {
      txt = `Objective active \u00b7 SHIFT to run \u00b7 E to take a car`;
    } else {
      txt = 'Shift to run \u00b7 E to take a car';
    }
    const room = Math.max(120, w - EDGE - RIGHT_GAP - MAP_SIZE - 40);
    font(ctx, 11, '600');
    ctx.save();
    ctx.beginPath();
    ctx.rect(EDGE + 4, h - BOTTOM_GAP - 14, room, 20);
    ctx.clip();
    ctx.translate(EDGE + 4, h - BOTTOM_GAP + 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(247, 241, 226, 0.62)';
    fit(ctx, txt, room);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* interaction prompt                                                */
  /* ---------------------------------------------------------------- */

  function drawPrompts(ctx, w, h, inter) {
    const cx = w / 2;
    const base = h - BOTTOM_GAP - 26;
    if (!inter || !inter.label) return;
    font(ctx, 13, '600');
    const lw = ctx.measureText(inter.label).width;
    const ph = 34;
    const pw = Math.min(w - EDGE - RIGHT_GAP - 24, Math.max(180, lw + 78));
    const px = cx - pw / 2;
    const py = base - ph;
    roundRect(ctx, px, py, pw, ph, 8);
    ctx.fillStyle = 'rgba(14, 22, 28, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(242, 199, 92, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    roundRect(ctx, px + 8, py + 7, 22, ph - 14, 5);
    ctx.fillStyle = 'rgba(242, 199, 92, 0.20)';
    ctx.fill();
    font(ctx, 11, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('E', px + 19, py + ph / 2);
    font(ctx, 13, '600');
    ctx.save();
    ctx.beginPath();
    ctx.rect(px + 38, py, pw - 46, ph);
    ctx.clip();
    ctx.translate(px + 38, py + ph / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.cream;
    fit(ctx, inter.label, pw - 46);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* notification stack (bottom-left)                                  */
  /* ---------------------------------------------------------------- */

  function drawNotifications(ctx, w, h) {
    if (!notes.length) return;
    const maxW = Math.max(190, Math.min(392, w - EDGE - RIGHT_GAP - MAP_SIZE - 60));
    const cx = EDGE + 4;
    const rowH = 36;
    const gapY = 8;
    const list = notes.slice(-TOAST_LIMIT);

    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const idx = list.length - 1 - i; // 0 = newest, sits lowest
      const y = h - BOTTOM_GAP - 30 - rowH - idx * (rowH + gapY);
      const inA = clamp((n.dur - n.left) / 0.18, 0, 1);
      const outA = clamp(n.left / 0.4, 0, 1);
      const a = Math.min(inA, outA);
      if (a <= 0.01) continue;

      const col = KIND_COLORS[n.kind] ?? COLORS.cream;
      const label = KIND_LABELS[n.kind] ?? 'NOTICE';
      font(ctx, 12, '600');
      const bw = Math.min(maxW, Math.max(200, ctx.measureText(n.text).width + 44));

      ctx.globalAlpha = a;
      roundRect(ctx, cx + 4, y + 2, bw, rowH, 8);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fill();
      roundRect(ctx, cx, y, bw, rowH, 8);
      ctx.fillStyle = 'rgba(14, 22, 28, 0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.14)';
      ctx.lineWidth = 1;
      ctx.stroke();

      /* accent stripe */
      roundRect(ctx, cx, y, 4, rowH, 2);
      ctx.fillStyle = col;
      ctx.fill();

      font(ctx, 8, '800');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = col;
      ctx.fillText(label, cx + 14, y + 13);

      font(ctx, 12, '600');
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx + 14, y + 14, bw - 26, 18);
      ctx.clip();
      ctx.translate(cx + 14, y + 28);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.cream;
      fit(ctx, n.text, bw - 26);
      ctx.restore();

      /* lifetime sliver */
      const rem = clamp(n.left / n.dur, 0, 1);
      roundRect(ctx, cx + 4, y + rowH - 2, (bw - 8) * rem, 2, 1);
      ctx.fillStyle = col;
      ctx.globalAlpha = a * 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------------------------------------------------------- */
  /* screens                                                           */
  /* ---------------------------------------------------------------- */

  function drawGame(ctx, world, interact = null) {
    const S = world ?? {};
    const dt = frameDt(S);
    canvasFrame(ctx, (w, h) => {
      drawStats(ctx, S, w, dt);
      drawObjective(ctx, S, w);
      drawCash(ctx, S, w, dt);
      drawSideJob(ctx, S, w, dt);
      drawCompass(ctx, S, w, h);
      drawSpeedo(ctx, S, w, h);
      drawMap(ctx, S, w, h);
      drawHint(ctx, S, w, h);
      drawPrompts(ctx, w, h, interact);
      drawNotifications(ctx, w, h);
      drawHeatPulse(ctx, S, w, h);
    });
    publish(S);
  }

  /*
   * Mirror the tracker state where DOM fallbacks can read it. index.html's
   * #hud-side block uses this when hud.js is the only HUD in play; when the
   * canvas frame owns the corners main.js keeps the DOM copy hidden, so this
   * never double-draws.
   */
  function publish(S) {
    if (typeof window === 'undefined') return;
    const job = sideJobOf(S);
    const light = daylight(S.clock ?? 0);
    window.solmarHud = {
      clock: formatClock(S.clock ?? 0),
      day: Math.max(1, Math.round(S.day ?? 1)),
      phase: light.label,
      night: light.night,
      wanted: clamp(Math.round(Number(S.wanted ?? 0)), 0, MAX_WANTED),
      side: job ? {
        name: job.name,
        detail: job.detail,
        reward: Number.isFinite(job.reward) ? formatMoney(job.reward) : null,
        progress: job.progress,
        step: job.step,
        steps: job.steps,
      } : null,
    };
  }

  function drawTitle(ctx, view, opts = {}) {
    const t = Number.isFinite(opts.time) ? opts.time : 0;
    const hasSave = !!opts.hasSave;
    canvasFrame(ctx, (w, h) => {
      const cx = w / 2;
      const safe = w - EDGE * 2;
      const top = Math.max(64, Math.min(h * 0.24, h - 300));
      shroud(ctx, w, h, 0.46);
      const ts = Math.min(96, Math.max(44, w * 0.075));
      font(ctx, ts, '800');
      const tw = ctx.measureText('SOLMAR').width;
      const f = tw > safe ? safe / tw : 1;
      font(ctx, Math.floor(ts * f), '800');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillText('SOLMAR', cx + 3, top + 3);
      ctx.fillStyle = COLORS.gold;
      ctx.fillText('SOLMAR', cx, top);
      headline(ctx, cx, top + 42, 'AN OPEN-WORLD CITY BY THE SEA', 12, COLORS.muted);
      const pulse = 0.62 + 0.38 * Math.sin(t * 2.6);
      font(ctx, 20, '700');
      ctx.fillStyle = COLORS.cream;
      ctx.globalAlpha = pulse;
      ctx.fillText('PRESS ENTER TO START', cx, top + 98);
      ctx.globalAlpha = 1;
      if (hasSave) {
        font(ctx, 13, '600');
        ctx.fillStyle = COLORS.muted;
        ctx.fillText('L continues your last session', cx, top + 124);
      }
      const rows = [
        [{ key: 'WASD', action: 'walk / drive' }, { key: 'SHIFT', action: 'run' }, { key: 'SPACE', action: 'handbrake' }, { key: 'E', action: 'in / out' }, { key: 'ESC', action: 'pause' }],
        [{ key: 'F5', action: 'save' }, { key: 'F9', action: 'load' }],
      ];
      let ry = top + 158;
      for (let i = 0; i < rows.length; i++) {
        const tot = capsWidth(ctx, rows[i]);
        const sx = tot > safe ? EDGE : cx - tot / 2;
        caps(ctx, sx, ry + i * 62, rows[i], safe);
      }
      font(ctx, 11, '600');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(169, 179, 184, 0.78)';
      ctx.fillText('Built from a seed, one street at a time.', cx, h - BOTTOM_GAP - 4);
    });
    void view;
  }

  function drawPause(ctx, view, world) {
    const S = world ?? {};
    canvasFrame(ctx, (w, h) => {
      shroud(ctx, w, h, 0.66);
      const cx = w / 2;
      const cw = Math.min(470, w - EDGE - RIGHT_GAP - 12);
      const ch = 330;
      const cx0 = cx - cw / 2;
      const cy0 = h / 2 - ch / 2;
      box(ctx, cx0, cy0, cw, ch, 14);
      font(ctx, 30, '800');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.cream;
      ctx.fillText('PAUSED', cx, cy0 + 52);
      const p = S.player ?? {};
      const car = p.car && Number.isFinite(p.car.x) ? p.car : null;
      const chp = car
        ? `${Math.max(0, Math.round(Number(car.health ?? 0)))} / ${Math.max(1, Math.round(Number(car.maxHealth ?? 100)))}`
        : '\u2014';
      const rows = [
        ['Cash', formatMoney(p.money ?? 0)],
        ['Health', `${Math.round(clamp(Number(p.health ?? 0), 0, 100))} / 100`],
        ['Stamina', `${Math.round(clamp(Number(p.stamina ?? 0), 0, Number(p.staminaMax) || 100))}`],
        ['Time', `${formatClock(S.clock ?? 0)} \u00b7 day ${Math.max(1, Math.round(S.day ?? 1))}`],
        ['Wanted', `${clamp(Math.round(S.wanted ?? 0), 0, MAX_WANTED)} / ${MAX_WANTED}`],
        ['Vehicle', car ? `${Math.round(Math.abs(Number(car.speed) || 0) / SPEED_SCALE)} km/h \u00b7 ${chp}` : 'on foot'],
        ['Jobs done', String(Math.max(0, Math.round(S.jobsDone ?? 0)))],
      ];
      const ix = cx0 + 24;
      const iw = cw - 48;
      for (let i = 0; i < rows.length; i++) pair(ctx, rows[i][0], rows[i][1], ix, cy0 + 88 + i * 24, iw);
      const ry = cy0 + 110 + (rows.length - 1) * 24;
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ix, ry);
      ctx.lineTo(ix + iw, ry);
      ctx.stroke();
      const keys = [{ key: 'ESC', action: 'resume' }, { key: 'F5', action: 'save' }, { key: 'F9', action: 'load' }];
      const tw = capsWidth(ctx, keys);
      caps(ctx, tw > iw ? ix : cx - tw / 2, cy0 + ch - 76, keys, iw);
    });
    void view;
  }

  function drawOver(ctx, view, world) {
    const S = world ?? {};
    canvasFrame(ctx, (w, h) => {
      shroud(ctx, w, h, 0.74);
      const cx = w / 2;
      const cy = h / 2;
      const p = S.player ?? {};
      const day = Math.max(1, Math.round(S.day ?? 1));
      const clk = formatClock(S.clock ?? 0);
      const jobs = Math.max(0, Math.round(S.jobsDone ?? 0));
      const safe = w - EDGE * 2;
      const sz = Math.min(62, Math.max(34, w * 0.052));
      headline(ctx, cx, cy - 42, 'WASTED', sz, COLORS.red);
      font(ctx, 14, '600');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.cream;
      ctx.fillText(`${formatMoney(p.money ?? 0)} earned \u00b7 ${jobs} jobs`, cx, cy + 4, safe);
      font(ctx, 12, '600');
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`Day ${day} \u00b7 ${clk}`, cx, cy + 28, safe);
      const pulse = 0.62 + 0.38 * Math.sin((Number.isFinite(S.time) ? S.time : 0) * 2.6);
      font(ctx, 16, '700');
      ctx.globalAlpha = pulse;
      ctx.fillStyle = COLORS.gold;
      ctx.fillText('PRESS ENTER TO TRY AGAIN', cx, cy + 74);
      ctx.globalAlpha = 1;
    });
    void view;
  }

  function drawFade(ctx, view, a) {
    const v = clamp(Number(a) || 0, 0, 1);
    if (v <= 0.001) return;
    canvasFrame(ctx, (w, h) => {
      ctx.fillStyle = `rgba(4, 8, 11, ${v})`;
      ctx.fillRect(0, 0, w, h);
    });
    void view;
  }

  return { say, notify: say, clearMessages, update, drawTitle, drawGame, drawPause, drawOver, drawFade };
}
