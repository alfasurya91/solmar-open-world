/*
 * Pure math, geometry, RNG and formatting helpers.
 *
 * Nothing in here knows about the city, the player, or the renderer —
 * every function is a small, dependency-free utility that can be reused
 * from any system. Angles are radians, positions are world units,
 * rects are { x, y, w, h }, vectors are plain { x, y } objects.
 */

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

/* ------------------------------------------------------------------ */
/* angles                                                              */
/* ------------------------------------------------------------------ */

export const degToRad = (deg) => deg * DEG2RAD;
export const radToDeg = (rad) => rad * RAD2DEG;

// Wraps an angle into (-PI, PI].
export function clampAngle(angle) {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

// Wraps an angle into [0, TAU).
export function normalizeAngle(angle) {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

// Shortest signed rotation from `from` to `to`, in (-PI, PI].
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// Same semantics as angleDelta, for callers that read better this way.
export const shortestAngle = angleDelta;

export function angleLerp(from, to, t) {
  return from + angleDelta(from, to) * clamp(t, 0, 1);
}

// Frame-rate independent angle easing; keeps rotation on the short arc.
export function angleDamp(from, to, lambda, dt) {
  return from + angleDelta(from, to) * (1 - Math.exp(-lambda * dt));
}

// True when two headings point roughly the same way (within `tolerance`).
export function angleNear(a, b, tolerance = 0.1) {
  return Math.abs(angleDelta(a, b)) <= tolerance;
}

// Unit vector for a heading. Y grows downward, so +PI/2 points down.
export function fromAngle(angle, out = { x: 0, y: 0 }) {
  out.x = Math.cos(angle);
  out.y = Math.sin(angle);
  return out;
}

export const directionFromAngle = fromAngle;

// Heading of a direction vector, in (-PI, PI].
export function angleFrom(x, y) {
  return Math.atan2(y, x);
}

/* ------------------------------------------------------------------ */
/* interpolation                                                       */
/* ------------------------------------------------------------------ */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Inverse lerp: where does v sit between a and b? Unclamped.
export function inverseLerp(a, b, v) {
  return a === b ? 0 : (v - a) / (b - a);
}

// Maps v from [inLo, inHi] onto [outLo, outHi], clamped by default.
export function remap(v, inLo, inHi, outLo, outHi, clamped = true) {
  const t = inverseLerp(inLo, inHi, v);
  return lerp(outLo, outHi, clamped ? clamp(t, 0, 1) : t);
}

// Frame-rate independent easing toward b; lambda = responsiveness.
export function damp(a, b, lambda, dt) {
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}

// Hermite blend between e0 and e1; flat at both ends.
export function smoothstep(e0, e1, x) {
  const s = e1 - e0;
  const t = s === 0 ? (x < e0 ? 0 : 1) : clamp((x - e0) / s, 0, 1);
  return t * t * (3 - 2 * t);
}

// 0..1 -> 0..1 with zero velocity at both ends.
export function easeInOut(t) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

// Ease-out cubic: fast start, soft landing.
export function easeOut(t) {
  const c = clamp(t, 0, 1);
  return 1 - (1 - c) * (1 - c) * (1 - c);
}

// Ease-in cubic: soft start, fast finish.
export function easeIn(t) {
  const c = clamp(t, 0, 1);
  return c * c * c;
}

// Moves a toward b by at most `step`; never overshoots.
export function approach(a, b, step) {
  if (a < b) return Math.min(a + step, b);
  if (a > b) return Math.max(a - step, b);
  return b;
}

/* ------------------------------------------------------------------ */
/* distance                                                            */
/* ------------------------------------------------------------------ */

export function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

// Squared distance — cheaper, for comparisons only.
export function distance2(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

// L1 (taxicab) distance — grid / pathfinding metric.
export function manhattan(x1, y1, x2, y2) {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

// Chebyshev distance — 8-way grid metric.
export function chebyshev(x1, y1, x2, y2) {
  return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
}

// True when (x, y) lies within `r` of (cx, cy); cheaper than distance().
export function withinRadius(x, y, cx, cy, r) {
  return distance2(x, y, cx, cy) <= r * r;
}

/* ------------------------------------------------------------------ */
/* vectors ({ x, y })                                                  */
/* ------------------------------------------------------------------ */

export const vec = (x = 0, y = 0) => ({ x, y });
export const vclone = (v) => ({ x: v.x, y: v.y });
export const vzero = () => ({ x: 0, y: 0 });

export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const vscale = (v, s) => ({ x: v.x * s, y: v.y * s });
export const vneg = (v) => ({ x: -v.x, y: -v.y });
export const vdot = (a, b) => a.x * b.x + a.y * b.y;
// 2D cross product (z component of the 3D cross); sign gives turn direction.
export const vcross = (a, b) => a.x * b.y - a.y * b.x;
export const vlen = (v) => Math.hypot(v.x, v.y);
export const vlen2 = (v) => v.x * v.x + v.y * v.y;

export function vnorm(v) {
  const l = Math.hypot(v.x, v.y);
  return l > EPSILON ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

export function vdist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function vdist2(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

export function vlerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Rotates v around the origin by `angle` radians.
export function vrotate(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

// Unit perpendicular (90 deg counter-clockwise in screen space).
export const vperp = (v) => ({ x: -v.y, y: v.x });

// Clamps length to at most `max`.
export function vclampLen(v, max) {
  const l = Math.hypot(v.x, v.y);
  if (l <= max || l <= EPSILON) return { x: v.x, y: v.y };
  const s = max / l;
  return { x: v.x * s, y: v.y * s };
}

// Reflects v about a unit normal n.
export function vreflect(v, n) {
  const d = 2 * (v.x * n.x + v.y * n.y);
  return { x: v.x - d * n.x, y: v.y - d * n.y };
}

export const vfromAngle = fromAngle;

/* ------------------------------------------------------------------ */
/* rectangles                                                          */
/* ------------------------------------------------------------------ */

export function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// True when two axis-aligned rects share any area (touching counts).
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectCenter(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* circle vs rect collision                                            */
/* ------------------------------------------------------------------ */

/*
 * Pushes a circle out of a rect if they intersect. Returns null when
 * there is no overlap, otherwise the corrected centre plus the contact
 * normal and penetration depth.
 */
export function resolveCircleRect(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > r * r) return null;

  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return {
      x: nx + (dx / d) * r,
      y: ny + (dy / d) * r,
      nx: dx / d,
      ny: dy / d,
      depth: r - d,
    };
  }

  // Centre is inside the rect: escape through the nearest edge.
  const l = cx - rect.x;
  const rt = rect.x + rect.w - cx;
  const t = cy - rect.y;
  const b = rect.y + rect.h - cy;
  const m = Math.min(l, rt, t, b);
  if (m === l) return { x: rect.x - r, y: cy, nx: -1, ny: 0, depth: l + r };
  if (m === rt) return { x: rect.x + rect.w + r, y: cy, nx: 1, ny: 0, depth: rt + r };
  if (m === t) return { x: cx, y: rect.y - r, nx: 0, ny: -1, depth: t + r };
  return { x: cx, y: rect.y + rect.h + r, nx: 0, ny: 1, depth: b + r };
}

// True when a circle intersects a rect at all.
export function circleRectOverlap(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  return distance2(cx, cy, nx, ny) <= r * r;
}

/* ------------------------------------------------------------------ */
/* seeded RNG (mulberry32)                                             */
/* ------------------------------------------------------------------ */

/*
 * Mulberry32 core: returns a zero-argument function yielding floats in
 * [0, 1). Deterministic for a given seed; seed 0 is remapped to 1 so a
 * zero seed still produces a live stream.
 */
export function mulberry32(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * `createRandom(seed)` returns a callable that yields floats in [0, 1)
 * and carries extra helpers on the function object, so `rnd.int(1, 6)`
 * works directly. Built on mulberry32, so sequences are reproducible.
 */
export function createRandom(seed) {
  const next = mulberry32(seed);

  const rng = () => next();
  rng.range = (a, b) => a + next() * (b - a);
  rng.int = (a, b) => Math.floor(a + next() * (b - a + 1));
  rng.pick = (arr) => arr[Math.floor(next() * arr.length)];
  rng.chance = (p) => next() < p;
  rng.sign = () => (next() < 0.5 ? -1 : 1);
  rng.shuffle = (arr) => {
    const o = arr.slice();
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  };

  // --- extended helpers (additive; existing behaviour unchanged) ---
  // Float in [lo, hi); alias of range, named for intent.
  rng.float = rng.range;
  // Standard normal via Box–Muller; mean 0, sigma 1 by default.
  rng.gauss = (mean = 0, sigma = 1) => {
    const u = Math.max(next(), Number.MIN_VALUE);
    const v = next();
    return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  // Point uniformly distributed inside a circle of `radius`.
  rng.inCircle = (radius = 1) => {
    const a = next() * TAU;
    const d = Math.sqrt(next()) * radius;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d };
  };
  // Index in [0, arr.length), or -1 for an empty list.
  rng.index = (arr) => (arr.length ? Math.floor(next() * arr.length) : -1);
  // Weighted pick; weights need not be normalised.
  rng.weighted = (items, weights) => {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return rng.pick(items);
    let roll = next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  };
  // Draws a fresh 32-bit seed — use it to spawn independent sub-streams.
  rng.seed32 = () => (next() * 4294967296) >>> 0;

  return rng;
}

// One-shot deterministic float in [0, 1) for a seed — handy for hashing.
export function seededFloat(seed) {
  return mulberry32(seed)();
}

// Inclusive integer in [a, b] using Math.random.
export function randInt(a, b) {
  return Math.floor(a + Math.random() * (b - a + 1));
}

// Uniform random element; returns undefined for an empty list.
export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Uniform float in [a, b) using Math.random.
export function randRange(a, b) {
  return a + Math.random() * (b - a);
}

/* ------------------------------------------------------------------ */
/* number formatting                                                   */
/* ------------------------------------------------------------------ */

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

// Thousands separators without relying on ICU data.
export function formatNumber(val, decimals = 0) {
  const n = Number.isFinite(val) ? val : 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const parts = fixed.split('.');
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = n < 0 ? '-' : '';
  return parts.length > 1 ? `${sign}${grouped}.${parts[1]}` : `${sign}${grouped}`;
}

export function formatMoney(val) {
  const n = Math.round(Number.isFinite(val) ? val : 0);
  return `$${n.toLocaleString('en-US')}`;
}

// Compact money for HUDs: $1.2K, $3.4M, $5.6B.
export function formatMoneyShort(val) {
  const n = Number.isFinite(val) ? val : 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

// In-game minutes since midnight -> "HH:MM", wrapping over 24h.
export function formatClock(mins) {
  const total = ((Math.floor(mins) % 1440) + 1440) % 1440;
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// Seconds (may exceed an hour) -> "H:MM:SS" or "M:SS".
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

// Seconds -> "1h 04m", "12m 30s", "8s" for timers and cooldowns.
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

// World units -> "850 m" / "1.2 km", rounded for the HUD.
export function formatDistance(units, unit = 'm') {
  const n = Math.max(0, Number.isFinite(units) ? units : 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)} km` : `${Math.round(n)} ${unit}`;
}

// 0.427 -> "43%"; pass signed to keep a leading + for gains.
export function formatPercent(ratio, decimals = 0, signed = false) {
  const n = Number.isFinite(ratio) ? ratio * 100 : 0;
  const body = `${Math.abs(n).toFixed(decimals)}%`;
  if (n < 0) return `-${body}`;
  return signed ? `+${body}` : body;
}

// World units per second -> "85 km/h" or "12 m/s" for HUD speed readouts.
export function formatSpeed(unitsPerSecond, useKmh = true) {
  const n = Math.max(0, Number.isFinite(unitsPerSecond) ? unitsPerSecond : 0);
  if (useKmh) return `${Math.round(n * 3.6)} km/h`;
  return `${Math.round(n)} m/s`;
}

// Distance (world units) + speed (world units/sec) -> ETA string "2m 15s" / "0:45".
// Returns "—" when speed is zero or non-finite.
export function formatETA(distance, speed) {
  const d = Math.max(0, Number.isFinite(distance) ? distance : 0);
  const s = Number.isFinite(speed) ? speed : 0;
  if (s <= 0) return '—';
  const seconds = Math.max(0, Math.round(d / s));
  return formatDuration(seconds);
}

// Pads a value to a fixed width with leading zeros ("007").
export function padNumber(n, width = 2) {
  const s = String(Math.trunc(Math.abs(n)));
  const sign = n < 0 ? '-' : '';
  return sign + (s.length >= width ? s : '0'.repeat(width - s.length) + s);
}

/* ------------------------------------------------------------------ */
/* additive helpers (new exports; existing behaviour untouched)        */
/* ------------------------------------------------------------------ */

/**
 * Clamps a value into the unit interval [0, 1].
 * @param {number} x value to clamp (NaN yields 0)
 * @returns {number} x limited to [0, 1]
 */
export function clamp01(x) {
  const n = Number.isFinite(x) ? x : 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Heading from (x1, y1) toward (x2, y2), in (-PI, PI].
 * Y grows downward, so a target directly below gives +PI/2.
 * @param {number} x1 source x
 * @param {number} y1 source y
 * @param {number} x2 target x
 * @param {number} y2 target y
 * @returns {number} angle in radians
 */
export function angleTo(x1, y1, x2, y2) {
  return Math.atan2(y2 - y1, x2 - x1);
}

/**
 * Picks one element at random. Pass a createRandom() stream for
 * reproducible results, or omit it to use Math.random.
 * @param {Array<*>} arr source list (not mutated)
 * @param {() => number} [rand] float generator in [0, 1)
 * @returns {*} a random element, or undefined when the list is empty
 */
export function pickRandom(arr, rand = Math.random) {
  if (!arr || arr.length === 0) return undefined;
  const t = clamp01(typeof rand === 'function' ? rand() : 0);
  const i = Math.min(arr.length - 1, Math.floor(t * arr.length));
  return arr[i];
}

/**
 * Returns a shuffled copy of `arr` (Fisher-Yates); the input is never
 * mutated. Same `rand` contract as pickRandom.
 * @param {Array<*>} arr source list (not mutated)
 * @param {() => number} [rand] float generator in [0, 1)
 * @returns {Array<*>} a new shuffled array
 */
export function shuffleCopy(arr, rand = Math.random) {
  const out = Array.isArray(arr) ? arr.slice() : [];
  const rnd = typeof rand === 'function' ? rand : Math.random;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(clamp01(rnd()) * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Milliseconds -> "M:SS" (or "H:MM:SS" past an hour), via formatTime so
 * the output stays consistent with the rest of the HUD. Negative and
 * non-finite inputs read as "0:00". Distinct from formatDuration, which
 * takes seconds and renders "1h 04m".
 * @param {number} ms elapsed time in milliseconds
 * @returns {string} formatted duration, e.g. "2:05"
 */
export function formatDurationMs(ms) {
  const msSafe = Number.isFinite(ms) ? ms : 0;
  return formatTime(Math.max(0, Math.floor(msSafe / 1000)));
}
