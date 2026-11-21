// The small arithmetic and geometry primitives that the rest of Solmar is built out of. Nothing in
// here has heard of a city, a car or a pedestrian — these are the bricks that the simulation, the
// renderer and the HUD are laid from. The seeded generator at the foot of the file is what lets one
// seed rebuild the same streets, the same crowd and the same screenshots on every run.

export const TAU = Math.PI * 2;

/** Hold `value` inside [min, max]. A reversed range collapses to `min` rather than misbehaving. */
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Plain blend from a to b. `t` is deliberately unclamped, since callers overshoot on purpose. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Ease `a` towards `b` at a rate that ignores how long the frame was: `lambda` is the closing speed
 * in 1/seconds, so one long frame and two short ones end up in the same place.
 */
export function damp(a, b, lambda, dt) {
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}

/** Hermite ramp: 0 at or below edge0, 1 at or above edge1, smooth in between. */
export function smoothstep(edge0, edge1, x) {
  const span = edge1 - edge0;
  const t = span === 0 ? (x < edge0 ? 0 : 1) : clamp((x - edge0) / span, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest signed turn from one angle to another, landing in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Turn from `from` towards `to` the short way round; `t` is clamped into [0, 1]. */
export function angleLerp(from, to, t) {
  return from + angleDelta(from, to) * clamp(t, 0, 1);
}

export function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Squared distance, for the range checks where a square root would be wasted work. */
export function distance2(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

/**
 * Lay a rounded-rectangle path onto a 2D context. Written out by hand instead of calling
 * ctx.roundRect, so the game still runs where that method never shipped; the corner radius is capped
 * so it can never overshoot the shorter side.
 */
export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** Does the point fall inside this axis-aligned {x, y, w, h} rectangle? Edges count as inside. */
export function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * Shove a circle clear of a rectangle. Returns the corrected centre, the outward unit normal and the
 * overlap depth, or null when the two never touch. A centre already buried inside the rectangle
 * escapes through its nearest face, so nothing can end up sealed permanently inside a wall.
 */
export function resolveCircleRect(cx, cy, r, rect) {
  const nearestX = clamp(cx, rect.x, rect.x + rect.w);
  const nearestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  const d2 = dx * dx + dy * dy;
  if (d2 > r * r) return null;

  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return {
      x: nearestX + (dx / d) * r,
      y: nearestY + (dy / d) * r,
      nx: dx / d,
      ny: dy / d,
      depth: r - d,
    };
  }

  // Dead centre: leave through whichever face is closest.
  const toLeft = cx - rect.x;
  const toRight = rect.x + rect.w - cx;
  const toTop = cy - rect.y;
  const toBottom = rect.y + rect.h - cy;
  const best = Math.min(toLeft, toRight, toTop, toBottom);
  if (best === toLeft) return { x: rect.x - r, y: cy, nx: -1, ny: 0, depth: toLeft + r };
  if (best === toRight) return { x: rect.x + rect.w + r, y: cy, nx: 1, ny: 0, depth: toRight + r };
  if (best === toTop) return { x: cx, y: rect.y - r, nx: 0, ny: -1, depth: toTop + r };
  return { x: cx, y: rect.y + rect.h + r, nx: 0, ny: 1, depth: toBottom + r };
}

/**
 * Mulberry32, a self-contained 32-bit PRNG. The returned function emits floats in [0, 1) and carries
 * the shorthands that the city builder, the crowd and the traffic all reach for. A given seed always
 * walks the same sequence, which is what keeps the screenshots reproducible.
 */
export function createRandom(seed) {
  let state = (seed >>> 0) || 1;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = () => next();
  rng.range = (min, max) => min + next() * (max - min);
  rng.int = (min, max) => Math.floor(min + next() * (max - min + 1));
  rng.pick = (list) => list[Math.floor(next() * list.length)];
  rng.chance = (p) => next() < p;
  rng.sign = () => (next() < 0.5 ? -1 : 1);
  rng.shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
    return out;
  };
  return rng;
}

/** Minutes after midnight written as a 24-hour clock, wrapping around a whole day. */
export function formatClock(minutes) {
  const total = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const mins = String(total % 60).padStart(2, '0');
  return `${hours}:${mins}`;
}

/** A whole-dollar sum with thousands separators, e.g. "$1,250". */
export function formatMoney(value) {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return `$${rounded.toLocaleString('en-US')}`;
}