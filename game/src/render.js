// Solmar — aerial renderer. Top-down coastal town with three districts,
// a baked static layer and a live overlay pass.
// Exports: SCREEN_* constants + createRenderer(canvas, city) ->
//   { view, camera, nudgeShake, draw, drawOverview, resize,
//     worldToScreen, screenToWorld, rebake }

import { CAMERA, CAR_COLORS, COLORS, VEHICLE } from './config.js';
import { TAU, clamp, damp, roundRect } from './utils.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_OVER = 'over';

const EXTRA_BAKE = 260;
const SKID_CAP = 400;
const DUST_CAP = 160;
const FLASH_CAP = 10;
const BAY_WIDTH = 30;
const BAY_HEIGHT = 54;
const MINIMAP_SIZE = 138;
const MINIMAP_MARGIN = 26;
// The HUD owns the bottom-right corner (its own map) and the cash panel sits
// at the very top-right, so the renderer's minimap lives under the cash panel.
const MINIMAP_TOP = 148;
/* Golden hour: the sun sits lowest while `night` sits near DUSK_PEAK, which
   is where the shadow stretch and the warm light pass both peak. */
const DUSK_PEAK = 0.45;
/* Below this speed a car on packed earth only trickles dust, not a plume. */
const DIRT_DUST_SPEED = 110;

/* Per-district art direction. The palettes are applied as a ground wash,
   a wall/glass tint and a window-lighting bias so the three areas of the
   town read differently at a glance. */
const DISTRICT_LOOK = Object.freeze({
  oldtown: {
    label: 'OLD TOWN',
    wash: 'rgba(196, 138, 84, 0.16)',
    washCool: 'rgba(120, 76, 44, 0.12)',
    tint: '#d9a05b',
    trim: '#8f5433',
    glass: 'rgba(46, 58, 70, 0.44)',
    glassLit: 'rgba(255, 214, 140, 0.62)',
    litChance: 0.30,
    court: '#cfc3ab',
    awning: 0.62,
  },
  downtown: {
    label: 'DOWNTOWN',
    wash: 'rgba(150, 160, 178, 0.14)',
    washCool: 'rgba(78, 88, 104, 0.12)',
    tint: '#a6b2c2',
    trim: '#6f7c8c',
    glass: 'rgba(38, 58, 78, 0.46)',
    glassLit: 'rgba(255, 226, 168, 0.58)',
    litChance: 0.34,
    court: '#c9c6bd',
    awning: 0.42,
  },
  modern: {
    label: 'MARINA DISTRICT',
    wash: 'rgba(126, 186, 196, 0.15)',
    washCool: 'rgba(48, 96, 112, 0.13)',
    tint: '#8fc0ca',
    trim: '#54707e',
    glass: 'rgba(28, 74, 96, 0.5)',
    glassLit: 'rgba(230, 244, 255, 0.6)',
    litChance: 0.40,
    court: '#cfd3ce',
    awning: 0.16,
  },
});
const DEFAULT_LOOK = DISTRICT_LOOK.downtown;
const lookOf = (district) => DISTRICT_LOOK[district] || DEFAULT_LOOK;

const RGB_LOOKUP = new Map();

function parseRGB(hex) {
  if (typeof hex !== 'string') return [255, 255, 255];
  const cached = RGB_LOOKUP.get(hex);
  if (cached) return cached;
  let body = hex.trim().replace('#', '');
  if (body.length === 3) body = body.split('').map(c => c + c).join('');
  const val = Number.parseInt(body, 16);
  const out = Number.isFinite(val)
    ? [(val >> 16) & 255, (val >> 8) & 255, val & 255]
    : [255, 255, 255];
  RGB_LOOKUP.set(hex, out);
  return out;
}

function shiftColor(hex, t) {
  const [r, g, b] = parseRGB(hex);
  const target = t < 0 ? 0 : 255;
  const k = clamp(Math.abs(t), 0, 1);
  return `rgb(${Math.round(r + (target - r) * k)}, ${Math.round(g + (target - g) * k)}, ${Math.round(b + (target - b) * k)})`;
}

function mixColor(a, b, t) {
  const [r1, g1, b1] = parseRGB(a);
  const [r2, g2, b2] = parseRGB(b);
  const k = clamp(t, 0, 1);
  return `rgb(${Math.round(r1 + (r2 - r1) * k)}, ${Math.round(g1 + (g2 - g1) * k)}, ${Math.round(b1 + (b2 - b1) * k)})`;
}

function alphaOf(hex, a) {
  const [r, g, b] = parseRGB(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(a, 0, 1)})`;
}

function stableHash(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const drawDisc = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); };
const drawEllipse = (g, x, y, rx, ry, rot = 0) => { g.beginPath(); g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, TAU); g.fill(); };
const drawRing = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke(); };
const drawSeg = (g, x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
const drawPoly = (g, pts) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); g.fill(); };
const gradLinear = (g, x0, y0, x1, y1, stops) => { const gr = g.createLinearGradient(x0, y0, x1, y1); for (const s of stops) gr.addColorStop(s[0], s[1]); return gr; };
const gradRadial = (g, x, y, r0, r1, stops) => { const gr = g.createRadialGradient(x, y, r0, x, y, r1); for (const s of stops) gr.addColorStop(s[0], s[1]); return gr; };

/* ------------------------------------------------------------------ */
/* sun                                                               */
/* ------------------------------------------------------------------ */

/* Golden-hour weight: a bump that is zero at midday (night 0), peaks at
   DUSK_PEAK and is gone again by full night, so the warm pass never shows up
   in a noon frame. This one number drives the shadow reach, the facade tint
   and the sky wash, so they can never disagree with each other. */
function duskAmount(night) {
  const n = clamp(Number.isFinite(night) ? night : 0, 0, 1);
  const rise = n / DUSK_PEAK;
  const fall = (0.92 - n) / (0.92 - DUSK_PEAK);
  const k = clamp(Math.min(rise, fall), 0, 1);
  /* smoothstep so the ramp has no visible kink at either end */
  return k * k * (3 - 2 * k);
}

/* One description of the light for a frame: which way shadows fall, how far
   they stretch and how warm the cast is. Baked art already assumes a
   down-right shadow, so the sun lives west and shadows reach east. */
function sunState(night) {
  const n = clamp(Number.isFinite(night) ? night : 0, 0, 1);
  const dusk = duskAmount(n);
  return {
    dusk,
    night: n,
    dirX: 0.46 + dusk * 0.74,
    dirY: 0.6 + dusk * 0.34,
    stretch: 1 + dusk * 1.2,
    alpha: 0.28 - dusk * 0.04,
  };
}

/* Cast shadow for a moving figure: a body that is still rooted at the feet,
   then a long soft tail that grows as the sun drops. `weight` scales the whole
   thing so vehicles can read heavier than walkers. `rot` turns only the body
   ellipse (a car's footprint), never the sun direction. */
function castShadow(g, x, y, rx, ry, sun, weight = 1, rot = 0) {
  const a = clamp(sun.alpha * weight, 0, 1);
  const stretch = sun.stretch;
  const ang = Math.atan2(sun.dirY, sun.dirX);
  g.fillStyle = `rgba(18, 21, 27, ${a})`;
  drawEllipse(g, x + rx * sun.dirX * 0.24, y + ry * sun.dirY * 0.24, rx * (0.62 + stretch * 0.3), ry * 0.92, rot || ang);
  g.fillStyle = `rgba(18, 21, 27, ${a * 0.46})`;
  drawEllipse(
    g,
    x + rx * sun.dirX * (0.55 + stretch * 0.26),
    y + ry * sun.dirY * (0.5 + stretch * 0.2),
    rx * stretch * 0.72,
    ry * 0.52,
    ang
  );
}

export function createRenderer(canvas, city) {
  const view = { width: 1280, height: 720, dpr: 1 };
  const camera = { x: city.spawn.x, y: city.spawn.y, zoom: CAMERA.zoomFoot, shake: 0, ox: 0, oy: 0 };
  const ctx = canvas.getContext('2d');

  let bakedLayer = null;
  let needsBake = true;
  let glowingWindows = [];
  let minimapCache = null;
  let minimapCacheKey = '';

  const skidPool = Array.from({ length: SKID_CAP }, () => ({ x1: 0, y1: 0, x2: 0, y2: 0, life: 0, max: 1, width: 3.6 }));
  const dustPool = Array.from({ length: DUST_CAP }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 0, tone: 0 }));
  const flashPool = Array.from({ length: FLASH_CAP }, () => ({ x: 0, y: 0, angle: 0, life: 0 }));
  let skidIdx = 0, dustIdx = 0, flashIdx = 0;

  let lastCarState = null;
  let lastWanted = 0;
  let walkCycle = 0;
  let walkOrigin = { x: city.spawn.x, y: city.spawn.y };
  let globalTime = 0;
  /* Refreshed once per frame from the clock; read by every shadow helper. */
  let sun = sunState(0);
  let dustClock = 0;
  let vignetteCache = null;
  let vignetteKey = '';
  let dayTintCache = null;
  let dayTintKey = '';

  const districtList = (() => {
    const src = city.districts ?? {};
    const order = ['oldtown', 'downtown', 'modern'];
    const out = [];
    for (const key of order) {
      const d = src[key];
      if (!d) continue;
      out.push({
        key,
        name: d.name ?? d.label ?? lookOf(key).label,
        x: d.x ?? 0,
        y: d.y ?? 0,
        w: d.w ?? city.width,
        h: d.h ?? city.height,
      });
    }
    if (out.length) return out;
    return [
      { key: 'oldtown', name: 'Old Town', x: 0, y: 0, w: city.width * 0.42, h: city.height },
      { key: 'downtown', name: 'Downtown', x: city.width * 0.42, y: 0, w: city.width * 0.58, h: city.height },
    ];
  })();

  function districtAt(px, py) {
    if (typeof city.districtOf === 'function') {
      const d = city.districtOf(px, py);
      if (d && DISTRICT_LOOK[d]) return d;
    }
    for (const d of districtList) if (px >= d.x && px <= d.x + d.w) return d.key;
    return 'downtown';
  }

  /* ------------------------------------------------------------------ */
  /* unpaved ground                                                    */
  /* ------------------------------------------------------------------ */

  /* Surfaces that throw dust instead of grip: the service alleys between
     parcels, the parking lots, the gravel gutter each side of a carriageway
     and the beach sand. Precomputed rects keep the per-frame test cheap. */
  const looseGround = (() => {
    const out = [];
    for (const a of city.alleys ?? []) out.push({ x: a.x, y: a.y, w: a.w, h: a.h });
    for (const l of city.lots ?? []) out.push({ x: l.x + 5, y: l.y + 5, w: l.w - 10, h: l.h - 10 });
    return out;
  })();

  function isLoose(px, py) {
    for (const r of looseGround) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return true;
    }
    const half = city.roadWidth / 2;
    for (const y of city.hy) {
      const d = Math.abs(py - y);
      if (d > half + 1 && d < half + 11) return true;
    }
    for (const x of city.vx) {
      const d = Math.abs(px - x);
      if (d > half + 1 && d < half + 11) return true;
    }
    if (city.beach) {
      const sandX = city.beach.x + (city.promenade ? city.promenade.w : 0);
      if (px > sandX && px < city.shoreline - 6 && py >= 0 && py <= city.beach.h) return true;
    }
    return false;
  }

  /* Facade band shared by the bake and the dusk pass so the warm light lands
     on exactly the wall the windows were drawn into. */
  const facadeBand = (lift, floors) => Math.max(18, Math.min(78, lift * 2.1 + floors * 4.2));

  function readSize() {
    const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2.5);
    const getBox = () => typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { width: canvas.clientWidth || 0, height: canvas.clientHeight || 0 };
    let { width: cw, height: ch } = getBox();

    if ((!cw || !ch) && canvas.style) {
      if (!cw && !canvas.style.width) canvas.style.width = '100%';
      if (!ch && !canvas.style.height) canvas.style.height = '100%';
      const again = getBox();
      cw = cw || again.width;
      ch = ch || again.height;
    }
    if (!cw) cw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    if (!ch) ch = (typeof window !== 'undefined' && window.innerHeight) || 720;
    cw = Math.max(320, Math.round(cw));
    ch = Math.max(240, Math.round(ch));

    view.width = cw;
    view.height = ch;
    view.dpr = dpr;

    const w = Math.round(cw * dpr);
    const h = Math.round(ch * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    vignetteCache = null;
    return dpr;
  }

  readSize();
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', readSize);
    window.addEventListener('orientationchange', readSize);
  }

  let warmupFrames = 12;
  function settleSize() {
    if (warmupFrames <= 0) return;
    warmupFrames--;
    readSize();
  }

  function viewBounds(pad = 80) {
    const hw = view.width / (2 * camera.zoom) + pad;
    const hh = view.height / (2 * camera.zoom) + pad;
    return { x0: camera.x - hw, y0: camera.y - hh, x1: camera.x + hw, y1: camera.y + hh };
  }

  const dropShadow = (g, x, y, rx, ry, a = 0.18) => {
    g.fillStyle = `rgba(28, 30, 34, ${a})`;
    drawEllipse(g, x + rx * 0.28, y + ry * 0.38, rx, ry);
  };

  /* ---------------------------------------------------------------- */
  /* small props                                                       */
  /* ---------------------------------------------------------------- */

  function drawTree(g, t, seed) {
    const r = t.r ?? 15;
    if (t.kind === 'palm') {
      dropShadow(g, t.x, t.y, r * 0.72, r * 0.5, 0.16);
      const cx = t.x + r * 0.1, cy = t.y - r * 0.15;
      g.strokeStyle = '#8a6a45'; g.lineWidth = Math.max(2.4, r * 0.15); g.lineCap = 'round';
      drawSeg(g, t.x, t.y + 3, cx, cy);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + seed * 0.6;
        const len = r * (0.9 + (i % 2) * 0.2);
        g.strokeStyle = i % 2 ? '#6f9d57' : COLORS.grassDark;
        g.lineWidth = Math.max(2, r * 0.14);
        g.beginPath(); g.moveTo(cx, cy);
        g.quadraticCurveTo(cx + Math.cos(a) * len * 0.6, cy + Math.sin(a) * len * 0.55, cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.95);
        g.stroke();
      }
      g.fillStyle = '#7fa865'; drawDisc(g, cx, cy, Math.max(1.6, r * 0.15));
      g.lineCap = 'butt';
      return;
    }
    dropShadow(g, t.x, t.y, r * 0.92, r * 0.68, 0.2);
    g.fillStyle = '#6b5136'; drawDisc(g, t.x, t.y, Math.max(2, r * 0.19));
    const blobs = [
      [0, 0, r, COLORS.grassDark],
      [-r * 0.44, -r * 0.26, r * 0.66, COLORS.grass],
      [r * 0.4, -r * 0.3, r * 0.6, COLORS.grass],
      [r * 0.14, r * 0.42, r * 0.54, COLORS.grassDark],
    ];
    for (const [ox, oy, rr, col] of blobs) { g.fillStyle = col; drawDisc(g, t.x + ox, t.y + oy, rr); }
    g.fillStyle = 'rgba(255, 255, 220, 0.26)'; drawDisc(g, t.x - r * 0.3, t.y - r * 0.34, r * 0.34);
  }

  function drawBench(g, b) {
    g.save(); g.translate(b.x, b.y); g.rotate(b.angle ?? 0);
    g.fillStyle = 'rgba(26, 24, 22, 0.18)'; g.fillRect(-13, 4, 26, 6);
    g.fillStyle = '#9a6d43'; roundRect(g, -13, -4, 26, 7, 2); g.fill();
    g.fillStyle = '#7d5734'; g.fillRect(-13, -7, 26, 3);
    g.fillStyle = '#4e4034'; g.fillRect(-9, 3, 3, 4); g.fillRect(6, 3, 3, 4);
    g.restore();
  }

  function drawUmbrella(g, u) {
    const col = u.color ?? '#e2604f';
    dropShadow(g, u.x, u.y, 15, 9, 0.18);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#f2ede2' : col;
      g.beginPath(); g.moveTo(u.x, u.y); g.arc(u.x, u.y, 15, (i / 8) * TAU, ((i + 1) / 8) * TAU); g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(90, 76, 58, 0.35)'; g.lineWidth = 1; drawRing(g, u.x, u.y, 15);
    g.fillStyle = '#6a5c48'; drawDisc(g, u.x, u.y, 2.2);
  }

  function drawLamp(g, l) {
    g.fillStyle = 'rgba(20, 22, 26, 0.22)'; drawEllipse(g, l.x + 2.4, l.y + 3, 5, 3.6);
    g.fillStyle = '#6a6f74'; drawDisc(g, l.x, l.y, 3.4);
    g.fillStyle = '#8d939a'; drawDisc(g, l.x - 0.8, l.y - 0.8, 2.2);
    g.strokeStyle = '#6a6f74'; g.lineWidth = 2; drawSeg(g, l.x, l.y, l.x + 7, l.y - 9);
    g.fillStyle = '#f2d79d'; drawDisc(g, l.x + 7, l.y - 9, 2.6);
  }

  function drawTowel(g, t) {
    if (!t) return;
    g.save(); g.translate(t.x, t.y); g.rotate(t.angle ?? 0);
    g.fillStyle = 'rgba(140, 112, 76, 0.2)'; g.fillRect(-t.w / 2 + 1.5, -t.h / 2 + 2, t.w, t.h);
    g.fillStyle = t.color ?? '#e8887d'; g.fillRect(-t.w / 2, -t.h / 2, t.w, t.h);
    g.fillStyle = 'rgba(255, 255, 255, 0.34)'; g.fillRect(-t.w / 2, -t.h / 2, t.w, 2.4);
    g.restore();
  }

  function drawStall(g, s) {
    if (!s) return;
    g.fillStyle = 'rgba(32, 28, 22, 0.2)'; g.fillRect(s.x + 2, s.y + 3, s.w, s.h);
    g.fillStyle = '#8a6c4c'; g.fillRect(s.x, s.y + s.h * 0.45, s.w, s.h * 0.55);
    g.fillStyle = s.color ?? '#d9605c'; g.fillRect(s.x, s.y, s.w, s.h * 0.5);
    g.fillStyle = 'rgba(255, 255, 255, 0.3)';
    for (let x = s.x + 4; x < s.x + s.w - 4; x += 9) g.fillRect(x, s.y, 4.5, s.h * 0.5);
    g.strokeStyle = 'rgba(60, 44, 28, 0.35)'; g.lineWidth = 1; g.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
  }

  function drawFountain(g, f, time = 0) {
    const r = f.r ?? 18;
    g.fillStyle = 'rgba(30, 34, 38, 0.16)'; drawEllipse(g, f.x + 3, f.y + 4, r + 3, r * 0.86);
    g.fillStyle = '#c3b6a0'; drawDisc(g, f.x, f.y, r + 3);
    g.strokeStyle = 'rgba(120, 108, 92, 0.5)'; g.lineWidth = 1.6; drawRing(g, f.x, f.y, r + 3);
    g.fillStyle = '#5aa6b4'; drawDisc(g, f.x, f.y, r);
    g.fillStyle = 'rgba(255, 255, 255, 0.2)'; drawDisc(g, f.x - r * 0.28, f.y - r * 0.3, r * 0.42);
    g.fillStyle = '#9fc8cf'; drawDisc(g, f.x, f.y, Math.max(2, r * 0.2));
    if (time > 0) {
      g.strokeStyle = 'rgba(230, 250, 255, 0.5)'; g.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const a = time * 1.4 + (i / 3) * TAU;
        const rr = r * (0.42 + 0.12 * Math.sin(time * 2 + i));
        drawEllipse(g, f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr, 1.6, 1.6);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* buildings — district palette, floor-aware windows, roof clutter    */
  /* ---------------------------------------------------------------- */

  function drawBuilding(g, bld, seed) {
    const look = lookOf(bld.district);
    const lift = clamp(bld.lift ?? 4, 2, 16);
    const style = bld.style ?? { wall: '#c8b9a6', roof: '#a99a86' };
    // District tint pulled into the shared style so each quarter reads apart.
    const wall = mixColor(style.wall, look.tint, 0.22);
    const roof = mixColor(style.roof, look.tint, 0.18);
    const ox = -lift * 0.26, oy = -lift * 1.15;
    const R = bld.x + bld.w, B = bld.y + bld.h;
    const floors = Math.max(1, bld.floors ?? 1);
    const tall = floors >= 4;

    /* The facade is an extruded band above the footprint. City data keeps
       `lift` low (2..16) which leaves only a few pixels per storey, so the
       band is expanded to a minimum that can actually carry window rows
       while still scaling with the true lift for the tallest towers. */
    const bandPx = facadeBand(lift, floors);
    const faceTop = B - bandPx;

    /* ground contact + soft cast shadow, longer for taller buildings */
    g.fillStyle = `rgba(38, 34, 30, ${0.16 + Math.min(0.14, lift * 0.016)})`;
    g.fillRect(bld.x + 4 + lift * 0.42, bld.y + 6 + lift * 0.88, bld.w, bld.h);
    g.fillStyle = 'rgba(38, 34, 30, 0.1)';
    g.fillRect(bld.x + 3, bld.y + 4, bld.w, bld.h);

    /* south + east facades, shaded darker with height */
    const wallShade = clamp(0.3 - floors * 0.022, 0.12, 0.34);
    g.fillStyle = gradLinear(g, 0, faceTop, 0, B, [[0, shiftColor(wall, -0.06)], [1, shiftColor(wall, -wallShade)]]);
    drawPoly(g, [bld.x, B, R, B, R + ox, faceTop + oy, bld.x + ox, faceTop + oy]);
    g.fillStyle = shiftColor(wall, -wallShade - 0.08);
    drawPoly(g, [R, faceTop, R, B, R + ox, faceTop + oy, R + ox, faceTop + oy]);

    /* roof slab */
    g.fillStyle = roof;
    drawPoly(g, [bld.x + ox, faceTop + oy, R + ox, faceTop + oy, R + ox, B + oy, bld.x + ox, B + oy]);
    g.strokeStyle = shiftColor(roof, -0.32); g.lineWidth = 1.4; g.stroke();
    g.fillStyle = shiftColor(roof, 0.18);
    g.fillRect(bld.x + ox, faceTop + oy, bld.w, 2.6);
    g.fillRect(bld.x + ox, faceTop + oy, 2.6, bandPx);

    /* Modern towers set back above a podium: draw the slimmer shaft. */
    const sb = bld.setback;
    if (sb && sb.w > 12 && sb.h > 12) {
      const sy = faceTop + oy + 3;
      const sx = sb.x + ox, sw = sb.w, sh = Math.max(10, bandPx - 6);
      g.fillStyle = shiftColor(roof, 0.1);
      g.fillRect(sx, sy, sw, sh);
      g.fillStyle = shiftColor(roof, 0.26);
      g.fillRect(sx, sy, sw, 2.4);
      g.fillRect(sx, sy, 2.4, sh);
      g.strokeStyle = shiftColor(roof, -0.28); g.lineWidth = 1.2;
      g.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      g.fillStyle = alphaOf(look.glass, 0.5);
      for (let y = sy + 6; y < sy + sh - 4; y += 9) g.fillRect(sx + 4, y, Math.max(1, sw - 8), 3);
    } else {
      g.strokeStyle = shiftColor(roof, -0.14); g.lineWidth = 1;
      g.strokeRect(bld.x + ox + 5.5, faceTop + oy + 5.5, Math.max(1, bld.w - 11), Math.max(1, bandPx - 11));
    }

    /* roof seam lines */
    g.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    for (let sx = bld.x + ox + 30; sx < R + ox - 10; sx += 46) drawSeg(g, sx, faceTop + oy + 7, sx, B + oy - 7);

    /* Windows: one row of panes per storey on the south facade. Lit panes
       are collected so the night pass can re-emit them as warm light. */
    const winH = Math.max(3, Math.min(7, bandPx / (floors + 1) * 0.55));
    const rowGap = bandPx / (floors + 0.6);
    const step = tall ? 13 : 15;
    const winW = tall ? 5 : 6.5;
    for (let f = 0; f < floors; f++) {
      const wy = B - bandPx + 5 + f * rowGap;
      if (wy + winH > B - 3) continue;
      /* floor separator line between storeys */
      if (f > 0) {
        g.strokeStyle = alphaOf(look.trim, 0.3);
        g.lineWidth = 1;
        drawSeg(g, bld.x + 1, wy - 3.4, R - 1, wy - 3.4);
      }
      for (let wx = bld.x + 6; wx < R - 8; wx += step) {
        const lit = stableHash(seed >>> 0, f, (wx * 0.37) | 0) < look.litChance;
        g.fillStyle = lit ? look.glassLit : look.glass;
        g.fillRect(wx, wy, winW, winH);
        if (lit) glowingWindows.push({ x: wx, y: wy, w: winW, h: winH });
      }
    }
    /* corner pilasters on mid-rise blocks */
    if (floors >= 3) {
      g.fillStyle = alphaOf(look.trim, 0.34);
      g.fillRect(bld.x, B - bandPx + 2, 3, bandPx - 4);
      g.fillRect(R - 3, B - bandPx + 2, 3, bandPx - 4);
    }

    /* entrance canopy */
    g.fillStyle = 'rgba(32, 38, 46, 0.6)';
    g.fillRect(bld.x + bld.w / 2 - 7, B - 5, 14, 5);

    /* roof clutter — tanks, HVAC units, stair huts, antennas, gardens */
    for (const item of bld.roof ?? []) {
      const ix = bld.x + ox + clamp(item.x, 3, Math.max(3, bld.w - item.w - 3));
      const iy = faceTop + oy + clamp(item.y, 3, Math.max(3, bandPx - item.h - 3));
      g.fillStyle = 'rgba(40, 34, 26, 0.22)';
      g.fillRect(ix + 2, iy + 2.5, item.w, item.h);
      if (item.kind === 'tank') {
        const cx = ix + item.w / 2, cy = iy + item.h / 2, rad = Math.min(item.w, item.h) / 2;
        g.fillStyle = '#9aa1a3'; drawDisc(g, cx, cy, rad);
        g.strokeStyle = '#6f7678'; g.lineWidth = 1.1; drawRing(g, cx, cy, rad);
        g.fillStyle = '#7d8486'; drawDisc(g, cx, cy, Math.min(item.w, item.h) * 0.22);
        g.fillStyle = 'rgba(255, 255, 255, 0.18)'; drawDisc(g, cx - rad * 0.3, cy - rad * 0.32, rad * 0.34);
      } else if (item.kind === 'garden') {
        g.fillStyle = '#6f9d5c'; g.fillRect(ix, iy, item.w, item.h);
        g.fillStyle = COLORS.grassDark;
        for (let k = 0; k < 4; k++) {
          drawDisc(g, ix + 4 + stableHash(ix + k, iy, 1) * Math.max(1, item.w - 8), iy + 4 + stableHash(iy + k, ix, 2) * Math.max(1, item.h - 8), 2.4 + stableHash(k, ix, 3) * 1.8);
        }
        g.strokeStyle = 'rgba(40, 60, 36, 0.3)'; g.lineWidth = 1; g.strokeRect(ix + 0.5, iy + 0.5, item.w - 1, item.h - 1);
      } else {
        g.fillStyle = shiftColor(roof, -0.14); g.fillRect(ix, iy, item.w, item.h);
        g.fillStyle = shiftColor(roof, 0.24); g.fillRect(ix, iy, item.w, 2);
        g.strokeStyle = 'rgba(30, 34, 40, 0.14)'; g.lineWidth = 1;
        for (let k = iy + 4; k < iy + item.h - 2; k += 4) drawSeg(g, ix + 1, k, ix + item.w - 1, k);
        if (item.kind === 'antenna') {
          g.strokeStyle = '#8a9096'; g.lineWidth = 1.2;
          drawSeg(g, ix + item.w / 2, iy + item.h / 2, ix + item.w / 2, iy + item.h / 2 - 7);
        }
      }
    }

    /* rooftop antenna with a red aviation lamp on tall towers */
    if (floors >= 5 && stableHash(seed, 9, 4) < 0.55) {
      const ax = bld.x + ox + bld.w * (0.62 + stableHash(seed, 3, 7) * 0.24);
      const ay = faceTop + oy + bandPx * 0.4;
      g.strokeStyle = shiftColor(roof, -0.5); g.lineWidth = 1.4;
      drawSeg(g, ax, ay, ax, ay - 14 - floors);
      g.fillStyle = COLORS.red;
      drawDisc(g, ax, ay - 15 - floors, 1.7);
    }

    /* awning: the district sets how often one is expected to appear */
    if (bld.awning) {
      const ac = bld.awning.color ?? '#d9605c';
      const side = bld.awning.side ?? 's';
      const vertical = side === 'e' || side === 'w';
      g.save();
      g.fillStyle = 'rgba(20, 24, 30, 0.2)';
      if (vertical) {
        const ax = side === 'e' ? bld.x + bld.w : bld.x;
        g.fillRect(ax + (side === 'e' ? 3 : -8), bld.y + 5, 8, Math.max(1, bld.h - 10));
        g.fillStyle = ac; g.fillRect(ax + (side === 'e' ? 2 : -7), bld.y + 4, 7, Math.max(1, bld.h - 8));
        g.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let y = bld.y + 6; y < bld.y + bld.h - 6; y += 13) g.fillRect(ax + (side === 'e' ? 2 : -7), y, 7, 6);
      } else {
        const ay = side === 'n' ? bld.y : B;
        g.fillRect(bld.x + 5, ay + 6, Math.max(1, bld.w - 8), 5);
        g.fillStyle = ac; g.fillRect(bld.x + 3, ay - (side === 'n' ? 7 : 1), Math.max(1, bld.w - 6), 8);
        g.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let x = bld.x + 5; x < R - 8; x += 13) g.fillRect(x, ay - (side === 'n' ? 7 : 1), 6, 8);
      }
      g.restore();
    }

    /* sky-reflecting glass panels on the wide roofs */
    if (bld.w > 96 || bld.h > 96) {
      for (let i = 0; i < 2; i++) {
        if (stableHash(seed + i, 2.2, 1) < 0.4) continue;
        const sx = bld.x + ox + 16 + stableHash(seed + i, 5.1, 2) * Math.max(1, bld.w - 50);
        const sy = faceTop + oy + 12 + stableHash(seed + i, 7.3, 3) * Math.max(1, bandPx - 32);
        g.fillStyle = 'rgba(150, 200, 220, 0.45)'; g.fillRect(sx, sy, 12, 8);
        g.strokeStyle = 'rgba(30, 40, 50, 0.35)'; g.lineWidth = 1; g.strokeRect(sx, sy, 12, 8);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* ground, roads, beach, pier                                        */
  /* ---------------------------------------------------------------- */

  function drawDistrictWash(g) {
    for (const d of districtList) {
      const look = lookOf(d.key);
      g.save();
      g.beginPath(); g.rect(d.x, d.y, d.w, d.h); g.clip();
      // A wide diagonal wash so the district's colour is felt, not banded.
      g.fillStyle = gradLinear(g, d.x, d.y, d.x + d.w, d.y + d.h, [[0, look.wash], [0.55, 'rgba(255, 255, 255, 0)'], [1, look.washCool]]);
      g.fillRect(d.x, d.y, d.w, d.h);
      // Paving hue shift on the pedestrian surface.
      g.globalAlpha = 0.1;
      g.fillStyle = look.court;
      g.fillRect(d.x, d.y, d.w, d.h);
      g.globalAlpha = 1;
      g.restore();
      // District boundary: a faint dash down the seam.
      g.strokeStyle = alphaOf(look.trim, 0.18);
      g.lineWidth = 2; g.setLineDash([10, 14]);
      drawSeg(g, d.x, d.y, d.x, d.y + d.h);
      g.setLineDash([]);
    }
  }

  function drawStreetPaint(g) {
    const half = city.roadWidth / 2;
    const inset = half + 8;
    g.lineCap = 'butt';

    for (let r = 0; r < city.hy.length; r++) {
      const y = city.hy[r];
      for (let c = 0; c < city.vx.length - 1; c++) {
        const from = city.vx[c] + inset, to = city.vx[c + 1] - inset;
        if (to - from < 12) continue;
        g.strokeStyle = COLORS.lineWarm; g.lineWidth = 1.8; g.setLineDash([]); drawSeg(g, from, y, to, y);
        g.strokeStyle = 'rgba(231, 225, 207, 0.34)'; g.lineWidth = 1.4; g.setLineDash([16, 20]);
        drawSeg(g, from, y - half + 12, to, y - half + 12);
        drawSeg(g, from, y + half - 12, to, y + half - 12);
      }
    }
    for (let c = 0; c < city.vx.length; c++) {
      const x = city.vx[c];
      for (let r = 0; r < city.hy.length - 1; r++) {
        const from = city.hy[r] + inset, to = city.hy[r + 1] - inset;
        if (to - from < 12) continue;
        g.strokeStyle = COLORS.lineWarm; g.lineWidth = 1.8; g.setLineDash([]); drawSeg(g, x, from, x, to);
        g.strokeStyle = 'rgba(231, 225, 207, 0.34)'; g.lineWidth = 1.4; g.setLineDash([16, 20]);
        drawSeg(g, x - half + 12, from, x - half + 12, to);
        drawSeg(g, x + half - 12, from, x + half - 12, to);
      }
    }
    g.setLineDash([]);
  }

  function drawCrosswalk(g, x, y) {
    const half = city.roadWidth / 2, inner = 26;
    g.fillStyle = 'rgba(238, 233, 216, 0.42)';
    for (let b = x - half + inner; b < x + half - inner - 7; b += 15) {
      g.fillRect(b, y - half + 8, 7, 13);
      g.fillRect(b, y + half - 21, 7, 13);
    }
    for (let b = y - half + inner; b < y + half - inner - 7; b += 15) {
      g.fillRect(x - half + 8, b, 13, 7);
      g.fillRect(x + half - 21, b, 13, 7);
    }
  }

  function drawJunctionWear(g, x, y) {
    const road = city.roadWidth;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = `rgba(255, 255, 255, ${0.012 + stableHash(x + i, y, i) * 0.02})`;
      drawEllipse(
        g,
        x + (stableHash(x + i, 1.2, i) - 0.5) * road * 0.8,
        y + (stableHash(y + i, 3.4, i) - 0.5) * road * 0.8,
        stableHash(i, 2.1, 1) * 18 + 10,
        stableHash(i, 5.6, 2) * 10 + 6,
        stableHash(i, 7.7, 3) * TAU
      );
    }
  }

  function drawSignal(g, s) {
    if (!s) return;
    const red = stableHash(s.x | 0, s.y | 0, 11) > 0.5;
    g.fillStyle = 'rgba(24, 26, 30, 0.28)'; drawDisc(g, s.x + 1.5, s.y + 2, 3.4);
    g.fillStyle = '#4d545c'; drawDisc(g, s.x, s.y, 3.2);
    g.fillStyle = red ? COLORS.red : COLORS.green; drawDisc(g, s.x, s.y, 1.8);
    g.fillStyle = 'rgba(255, 255, 255, 0.3)'; drawDisc(g, s.x - 0.6, s.y - 0.6, 0.8);
  }

  function drawPark(g, p, seed) {
    const look = lookOf(p.district ?? districtAt(p.x + p.w / 2, p.y + p.h / 2));
    g.fillStyle = COLORS.grass; g.fillRect(p.x, p.y, p.w, p.h);
    g.fillStyle = alphaOf(look.tint, 0.06);
    g.fillRect(p.x, p.y, p.w, p.h);
    g.fillStyle = 'rgba(255, 255, 255, 0.045)';
    for (let y = p.y; y < p.y + p.h; y += 26) g.fillRect(p.x, y, p.w, 12);
    g.strokeStyle = COLORS.path; g.lineWidth = 15;
    g.beginPath();
    g.moveTo(p.x + p.w / 2, p.y); g.lineTo(p.x + p.w / 2, p.y + p.h);
    g.moveTo(p.x, p.y + p.h / 2); g.lineTo(p.x + p.w, p.y + p.h / 2);
    g.stroke();
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    if (stableHash(seed, 4, 2) < 0.45) {
      drawFountain(g, { x: cx, y: cy, r: 16 }, 0);
    } else {
      g.fillStyle = '#c7b89b'; drawDisc(g, cx, cy, 19);
      g.fillStyle = '#79b3ba'; drawDisc(g, cx, cy, 14.5);
      g.fillStyle = 'rgba(255, 255, 255, 0.4)'; drawDisc(g, cx - 3.5, cy - 3.5, 4.5);
    }
    g.fillStyle = '#5d8a4c';
    g.fillRect(p.x, p.y, p.w, 6); g.fillRect(p.x, p.y + p.h - 6, p.w, 6);
    g.fillRect(p.x, p.y, 6, p.h); g.fillRect(p.x + p.w - 6, p.y, 6, p.h);
    const spots = [
      [p.x + 32, p.y + 32], [p.x + p.w - 34, p.y + 34],
      [p.x + 34, p.y + p.h - 34], [p.x + p.w - 36, p.y + p.h - 36],
      [p.x + p.w * 0.5, p.y + 26], [p.x + p.w * 0.5, p.y + p.h - 26],
    ];
    spots.forEach(([tx, ty], i) => drawTree(g, { x: tx, y: ty, r: 12 + stableHash(p.x + i, p.y, 5) * 7 }, i));
    for (let i = 0; i < 2; i++) {
      drawBench(g, {
        x: p.x + 26 + stableHash(p.x, i, 8) * (p.w - 52),
        y: p.y + p.h / 2 + (i === 0 ? -22 : 22),
        angle: 0,
      });
    }
  }

  function drawLot(g, lot) {
    const look = lookOf(lot.district ?? districtAt(lot.x + lot.w / 2, lot.y + lot.h / 2));
    g.fillStyle = COLORS.asphaltLight; g.fillRect(lot.x, lot.y, lot.w, lot.h);
    g.fillStyle = alphaOf(look.court, 0.1); g.fillRect(lot.x, lot.y, lot.w, lot.h);
    g.strokeStyle = 'rgba(232, 227, 210, 0.42)'; g.lineWidth = 1.6;
    for (let row = 0; row < 2; row++) {
      const by = lot.y + 22 + row * 92;
      for (let x = lot.x + 18; x + BAY_WIDTH < lot.x + lot.w - 14; x += BAY_WIDTH + 5) {
        drawSeg(g, x, by, x, by + BAY_HEIGHT);
      }
      g.fillStyle = 'rgba(214, 206, 186, 0.5)';
      for (let x = lot.x + 22; x + 24 < lot.x + lot.w - 16; x += BAY_WIDTH + 5) g.fillRect(x, by + 4, 22, 4);
    }
    g.strokeStyle = COLORS.lineWarm; g.lineWidth = 2; g.setLineDash([12, 10]);
    g.strokeRect(lot.x + 6, lot.y + 6, Math.max(1, lot.w - 12), Math.max(1, lot.h - 12));
    g.setLineDash([]);
    g.fillStyle = 'rgba(232, 227, 210, 0.5)';
    g.font = '700 15px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('P', lot.x + 20, lot.y + 20);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  function drawPromenade(g) {
    const prom = city.promenade;
    g.fillStyle = COLORS.courtyard; g.fillRect(prom.x, 0, prom.w, city.height);
    g.strokeStyle = COLORS.sidewalkLine; g.globalAlpha = 0.4; g.lineWidth = 1;
    for (let y = 0; y < city.height; y += 24) drawSeg(g, prom.x, y, prom.x + prom.w, y);
    for (let x = prom.x + 10; x < prom.x + prom.w; x += 10) drawSeg(g, x, 0, x, city.height);
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255, 255, 255, 0.12)'; g.fillRect(prom.x, 0, 3, city.height);
    g.fillStyle = COLORS.grassDark; g.fillRect(prom.x + prom.w - 6, 0, 6, city.height);
    for (const b of city.bollards ?? []) {
      g.fillStyle = 'rgba(24, 26, 30, 0.24)'; drawDisc(g, b.x + 1, b.y + 1.4, b.r ?? 3);
      g.fillStyle = '#8e949a'; drawDisc(g, b.x, b.y, b.r ?? 3);
    }
  }

  function drawBeach(g) {
    const bch = city.beach;
    const sandX = bch.x + (city.promenade ? city.promenade.w : 0);
    const sandW = city.shoreline - sandX;
    g.fillStyle = gradLinear(g, sandX, 0, city.shoreline, 0, [[0, COLORS.sandDark], [0.35, COLORS.sand], [1, COLORS.sandLight]]);
    g.fillRect(sandX, 0, sandW, bch.h);
    for (const s of city.speckles) { g.fillStyle = `rgba(122, 98, 64, ${s.a})`; drawDisc(g, s.x, s.y, s.r); }
    for (let i = 0; i < 3; i++) {
      g.strokeStyle = `rgba(150, 122, 84, ${0.11 + i * 0.03})`; g.lineWidth = 2;
      g.beginPath();
      for (let y = 0; y <= bch.h; y += 24) {
        const x = city.shoreline - 88 - i * 46 + Math.sin(y * 0.02 + i) * 12;
        if (y === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    const wetFrom = city.shoreline - 62;
    g.fillStyle = COLORS.wetSand;
    g.beginPath(); g.moveTo(wetFrom, 0);
    for (let y = 0; y <= bch.h; y += 16) g.lineTo(wetFrom + Math.sin(y * 0.045) * 4 + Math.sin(y * 0.013) * 7, y);
    g.lineTo(city.shoreline, bch.h); g.lineTo(city.shoreline, 0);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.2)'; g.fillRect(city.shoreline - 70, 0, 14, bch.h);
    for (let i = 0; i < 130; i++) {
      g.fillStyle = stableHash(i, 1.9, 2) > 0.5 ? 'rgba(176, 152, 118, 0.5)' : 'rgba(250, 242, 222, 0.65)';
      drawEllipse(
        g,
        sandX + 22 + stableHash(i, 3.3, 3) * Math.max(1, sandW - 38),
        stableHash(i, 6.6, 4) * bch.h,
        1.2 + stableHash(i, 8.1, 5) * 1.8,
        0.9 + stableHash(i, 4.2, 6) * 1.2,
        stableHash(i, 5.5, 7) * 3
      );
    }
    for (const t of city.towels ?? []) drawTowel(g, t);
  }

  function drawPier(g, from = city.pier.x, to = city.pier.x + city.pier.w) {
    const pier = city.pier;
    const x0 = Math.max(pier.x, from), x1 = Math.min(pier.x + pier.w, to);
    if (x1 <= x0) return;
    const wet = Math.max(x0, city.shoreline);
    if (x1 > wet) { g.fillStyle = 'rgba(8, 34, 46, 0.34)'; g.fillRect(wet, pier.y + 14, x1 - wet, pier.h + 4); }
    g.fillStyle = 'rgba(22, 48, 60, 0.26)';
    drawEllipse(g, x0 + (x1 - x0) / 2, pier.y + pier.h / 2 + 10, (x1 - x0) / 2, pier.h / 2);
    g.fillStyle = '#8f6f4e'; g.fillRect(x0, pier.y, x1 - x0, pier.h);
    g.strokeStyle = 'rgba(72, 54, 38, 0.4)'; g.lineWidth = 1;
    for (let x = x0; x < x1; x += 13) drawSeg(g, x, pier.y, x, pier.y + pier.h);
    g.fillStyle = 'rgba(255, 224, 180, 0.09)';
    for (let y = pier.y + 10; y < pier.y + pier.h - 6; y += 18) g.fillRect(x0, y, x1 - x0, 2);
    g.fillStyle = 'rgba(255, 232, 196, 0.16)'; g.fillRect(x0, pier.y, x1 - x0, 4);
    g.fillStyle = 'rgba(50, 36, 24, 0.22)'; g.fillRect(x0, pier.y + pier.h - 4, x1 - x0, 4);
    for (let x = wet + 10; x < x1 - 6; x += 34) {
      g.fillStyle = '#3d2f20'; g.fillRect(x, pier.y + pier.h - 3, 6, 13); g.fillRect(x, pier.y - 9, 6, 12);
      g.fillStyle = 'rgba(214, 176, 126, 0.5)'; g.fillRect(x, pier.y - 9, 2, 12); g.fillRect(x, pier.y + pier.h - 3, 2, 13);
      g.fillStyle = 'rgba(6, 28, 38, 0.4)'; g.fillRect(x - 1, pier.y + pier.h + 9, 8, 4); g.fillRect(x - 1, pier.y - 13, 8, 4);
    }
    g.strokeStyle = '#6d553b'; g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x0, pier.y + 4); g.lineTo(x1, pier.y + 4);
    g.moveTo(x0, pier.y + pier.h - 4); g.lineTo(x1, pier.y + pier.h - 4);
    g.stroke();
    for (const p of city.pierProps ?? []) {
      if (p.x < x0 || p.x > x1) continue;
      g.fillStyle = 'rgba(50, 38, 26, 0.3)'; drawDisc(g, p.x + 2, p.y + 2, 3);
      g.fillStyle = '#5c452e'; g.fillRect(p.x - 1.5, p.y - 5, 3, 10);
      g.fillStyle = '#f2d79d'; drawDisc(g, p.x, p.y, 2.2);
    }
    const endX = pier.x + pier.w - 22;
    if (endX >= x0 && endX <= x1) {
      g.fillStyle = '#6a6f74'; drawDisc(g, endX, pier.y + pier.h / 2, 4);
      g.fillStyle = '#f7e0a8'; drawDisc(g, endX, pier.y + pier.h / 2, 2.2);
    }
  }

  function drawDocks(g) {
    for (const d of city.docks ?? []) {
      g.fillStyle = 'rgba(10, 36, 48, 0.28)';
      g.fillRect(d.x + 3, d.y + 5, d.w, d.h);
      g.fillStyle = '#8a6a48'; g.fillRect(d.x, d.y, d.w, d.h);
      g.strokeStyle = 'rgba(66, 48, 32, 0.38)'; g.lineWidth = 1;
      for (let x = d.x; x < d.x + d.w; x += 12) drawSeg(g, x, d.y, x, d.y + d.h);
      g.fillStyle = 'rgba(255, 230, 190, 0.14)'; g.fillRect(d.x, d.y, d.w, 3);
    }
    for (const b of city.boats ?? []) {
      if (b.moored === false && (!b.x || b.x < city.shoreline)) continue;
      g.save(); g.translate(b.x, b.y); g.rotate(b.angle ?? 0);
      const len = b.len ?? 50, beam = b.beam ?? 18;
      g.fillStyle = 'rgba(6, 28, 38, 0.3)';
      drawEllipse(g, 2, 3, len / 2, beam / 2);
      g.fillStyle = b.color ?? '#f1eee4';
      g.beginPath(); g.ellipse(0, 0, len / 2, beam / 2, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255, 255, 255, 0.4)';
      g.beginPath(); g.ellipse(-len * 0.05, -beam * 0.16, len * 0.3, beam * 0.16, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(40, 52, 62, 0.6)';
      g.beginPath(); g.ellipse(len * 0.06, 0, len * 0.16, beam * 0.24, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(24, 34, 42, 0.4)'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(0, 0, len / 2, beam / 2, 0, 0, TAU); g.stroke();
      g.restore();
    }
  }

  /* ---------------------------------------------------------------- */
  /* static bake                                                       */
  /* ---------------------------------------------------------------- */

  function buildBake() {
    const w = Math.ceil(city.shoreline + EXTRA_BAKE);
    const h = Math.ceil(city.height);
    const layer = document.createElement('canvas');
    layer.width = w; layer.height = h;
    const g = layer.getContext('2d');
    glowingWindows = [];

    /* base ground */
    g.fillStyle = '#4c5246'; g.fillRect(0, 0, city.shoreline, h);
    g.fillStyle = COLORS.asphalt; g.fillRect(0, 0, city.width, h);
    g.fillStyle = COLORS.asphaltDark; g.fillRect(city.width, 0, Math.max(0, city.shoreline - city.width), h);

    for (let i = 0; i < 320; i++) {
      g.fillStyle = stableHash(i, 1.1, 1) > 0.45
        ? `rgba(0, 0, 0, ${0.02 + stableHash(i, 2.2, 2) * 0.03})`
        : `rgba(255, 255, 255, ${0.008 + stableHash(i, 3.3, 3) * 0.016})`;
      drawEllipse(
        g,
        stableHash(i, 4.4, 4) * city.width,
        stableHash(i, 5.5, 5) * h,
        40 + stableHash(i, 6.6, 6) * 120,
        25 + stableHash(i, 7.7, 7) * 70,
        stableHash(i, 8.8, 8) * TAU
      );
    }

    /* district ground wash — before blocks so sidewalks stay clean */
    drawDistrictWash(g);

    g.fillStyle = 'rgba(255, 255, 255, 0.02)';
    for (const y of city.hy) { g.fillRect(0, y - 31, city.width, 8); g.fillRect(0, y + 23, city.width, 8); }
    for (const x of city.vx) { g.fillRect(x - 31, 0, 8, city.height); g.fillRect(x + 23, 0, 8, city.height); }

    /* manholes */
    for (let i = 0; i < 44; i++) {
      const mx = 40 + stableHash(i, 1.3, 1) * (city.width - 80);
      const my = 40 + stableHash(i, 2.4, 2) * (city.height - 80);
      g.fillStyle = 'rgba(24, 27, 32, 0.5)'; drawDisc(g, mx, my, 6.5);
      g.strokeStyle = 'rgba(140, 146, 152, 0.24)'; g.lineWidth = 1.4; drawRing(g, mx, my, 6.5);
    }

    /* blocks: sidewalk band, courtyard floor, curbs, a random utility box */
    for (const block of city.blocks) {
      const look = lookOf(block.district);
      g.fillStyle = (block.c + block.r) % 2 === 0 ? COLORS.sidewalk : COLORS.sidewalkAlt;
      g.fillRect(block.x, block.y, block.w, block.h);
      g.save();
      g.beginPath(); g.rect(block.x, block.y, block.w, block.h); g.clip();
      g.strokeStyle = 'rgba(140, 132, 118, 0.22)'; g.lineWidth = 1;
      for (let x = block.x; x <= block.x + block.w; x += 26) drawSeg(g, x, block.y, x, block.y + block.h);
      for (let y = block.y; y <= block.y + block.h; y += 26) drawSeg(g, block.x, y, block.x + block.w, y);
      g.restore();

      const inset = city.sidewalk;
      g.fillStyle = mixColor(COLORS.courtyard, look.court, 0.5);
      g.fillRect(block.x + inset, block.y + inset, block.w - inset * 2, block.h - inset * 2);
      g.strokeStyle = 'rgba(150, 142, 124, 0.4)'; g.lineWidth = 1.4;
      g.strokeRect(block.x + inset, block.y + inset, block.w - inset * 2, block.h - inset * 2);
      g.strokeStyle = 'rgba(24, 26, 30, 0.26)'; g.lineWidth = 3;
      g.strokeRect(block.x + 1.5, block.y + 1.5, block.w - 3, block.h - 3);
      g.strokeStyle = COLORS.curb; g.lineWidth = 1.6;
      g.strokeRect(block.x + 3, block.y + 3, block.w - 6, block.h - 6);

      if (stableHash(block.x + block.y, 9.1, 1) > 0.7) {
        const px = block.x + 22 + stableHash(block.x, block.y, 2) * Math.max(1, block.w - 60);
        const py = block.y + 22 + stableHash(block.y, block.x, 3) * Math.max(1, block.h - 60);
        g.fillStyle = 'rgba(30, 34, 38, 0.18)'; g.fillRect(px + 2, py + 3, 14, 10);
        g.fillStyle = '#7d6a52'; g.fillRect(px, py, 14, 10);
        g.fillStyle = '#9c8768'; g.fillRect(px, py, 14, 3);
      }
    }

    /* alleys between building slices */
    for (const a of city.alleys ?? []) {
      g.fillStyle = 'rgba(58, 56, 52, 0.32)';
      g.fillRect(a.x, a.y, a.w, a.h);
      g.strokeStyle = 'rgba(24, 26, 30, 0.12)'; g.lineWidth = 1;
      if (a.axis === 'v') drawSeg(g, a.x + a.w / 2, a.y, a.x + a.w / 2, a.y + a.h);
      else drawSeg(g, a.x, a.y + a.h / 2, a.x + a.w, a.y + a.h / 2);
    }

    /* courtyards and plazas */
    for (const c of city.courtyards ?? []) {
      g.fillStyle = mixColor(COLORS.courtyard, lookOf(c.district).court, 0.6);
      g.fillRect(c.x, c.y, c.w, c.h);
      g.strokeStyle = 'rgba(140, 132, 116, 0.3)'; g.lineWidth = 1;
      g.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
    }
    for (const p of city.plazas ?? []) {
      g.fillStyle = '#c9c0ad'; g.fillRect(p.x, p.y, p.w, p.h);
      g.strokeStyle = 'rgba(255, 255, 255, 0.16)'; g.lineWidth = 1.2;
      for (let x = p.x + 10; x < p.x + p.w; x += 20) drawSeg(g, x, p.y, x, p.y + p.h);
      g.strokeStyle = 'rgba(120, 110, 96, 0.3)';
      for (let y = p.y + 10; y < p.y + p.h; y += 20) drawSeg(g, p.x, y, p.x + p.w, y);
    }

    /* garden paths */
    for (const gp of city.gardenPaths ?? []) {
      g.fillStyle = gp.kind === 'park' ? alphaOf(COLORS.path, 0.55) : 'rgba(214, 205, 186, 0.5)';
      g.fillRect(gp.x, gp.y, gp.w, gp.h);
      g.strokeStyle = 'rgba(150, 140, 122, 0.28)'; g.lineWidth = 1;
      g.strokeRect(gp.x + 0.5, gp.y + 0.5, Math.max(1, gp.w - 1), Math.max(1, gp.h - 1));
    }

    for (let i = 0; i < city.parks.length; i++) drawPark(g, city.parks[i], i);
    for (const lot of city.lots) drawLot(g, lot);

    /* buildings, sorted so taller ones overlap correctly */
    const ordered = city.buildings
      .map((b, i) => ({ b, i }))
      .sort((p, q) => (p.b.y + p.b.h) - (q.b.y + q.b.h) || p.b.x - q.b.x);
    for (const { b, i } of ordered) drawBuilding(g, b, (city.seed + i * 7919) >>> 0);

    drawStreetPaint(g);
    for (const y of city.hy) for (const x of city.vx) drawCrosswalk(g, x, y);
    for (const y of city.hy) for (const x of city.vx) drawJunctionWear(g, x, y);
    for (const s of city.signals ?? []) drawSignal(g, s);
    if (city.promenade) drawPromenade(g);
    if (city.beach) drawBeach(g);
    if (city.pier) drawPier(g, city.pier.x, city.shoreline + 2);
    drawDocks(g);
    for (const f of city.fountains ?? []) drawFountain(g, f, 0);
    for (const s of city.stalls ?? []) drawStall(g, s);
    for (const l of city.lamps) drawLamp(g, l);
    for (const t of city.trees) drawTree(g, t, 1);
    for (const b of city.benches) drawBench(g, b);
    for (const u of city.umbrellas) drawUmbrella(g, u);

    /* lights layer: lit windows + awning spill, used by the night pass */
    const lights = document.createElement('canvas');
    lights.width = w; lights.height = h;
    const lg = lights.getContext('2d');
    for (const p of glowingWindows) { lg.fillStyle = 'rgba(255, 208, 132, 0.55)'; lg.fillRect(p.x, p.y, p.w, p.h); }
    for (const b of city.buildings) {
      if (!b.awning) continue;
      lg.fillStyle = 'rgba(255, 202, 128, 0.16)';
      lg.fillRect(b.x - 6, b.y + b.h - 2, b.w + 12, 16);
    }
    for (const f of city.fountains ?? []) {
      lg.fillStyle = 'rgba(150, 226, 240, 0.14)';
      drawDisc(lg, f.x, f.y, (f.r ?? 16) + 6);
    }

    /* Dusk layer: baked once, blitted warm. Every facade gets a raking gold
       wash that dies out toward the shadowed (east) edge, plus a lit rim along
       the parapet, so the whole skyline catches the same sinking sun. */
    const dusk = document.createElement('canvas');
    dusk.width = w; dusk.height = h;
    const dg = dusk.getContext('2d');
    for (const b of city.buildings) {
      const lift = clamp(b.lift ?? 4, 2, 16);
      const floors = Math.max(1, b.floors ?? 1);
      const band = facadeBand(lift, floors);
      const top = b.y + b.h - band;
      const R = b.x + b.w;
      dg.fillStyle = gradLinear(dg, b.x, 0, R, 0, [
        [0, `rgba(255, 186, 108, ${0.34 + Math.min(0.16, floors * 0.018)})`],
        [0.55, 'rgba(255, 158, 92, 0.16)'],
        [1, 'rgba(120, 74, 96, 0.1)'],
      ]);
      dg.fillRect(b.x, top, b.w, band);
      /* parapet catches the most direct light */
      dg.fillStyle = 'rgba(255, 214, 150, 0.4)';
      dg.fillRect(b.x, top, b.w, 2.6);
      /* warm bounce onto the pavement at the foot of the wall */
      dg.fillStyle = gradLinear(dg, 0, b.y + b.h, 0, b.y + b.h + 14, [
        [0, 'rgba(255, 176, 104, 0.22)'],
        [1, 'rgba(255, 176, 104, 0)'],
      ]);
      dg.fillRect(b.x - 2, b.y + b.h, b.w + 6, 14);
    }

    bakedLayer = { layer, lights, dusk, w, h };
    needsBake = false;
    minimapCache = null;
  }

  /* ---------------------------------------------------------------- */
  /* water                                                             */
  /* ---------------------------------------------------------------- */

  function drawSea(time) {
    const b = viewBounds(240), shore = city.shoreline;
    const x0 = Math.max(shore - 60, b.x0), x1 = Math.max(b.x1, shore + 60);
    ctx.fillStyle = gradLinear(ctx, shore, 0, shore + 520, 0, [[0, '#8fd6d4'], [0.1, COLORS.waterShallow], [0.34, COLORS.waterMid], [1, COLORS.waterDeep]]);
    ctx.fillRect(x0, b.y0, x1 - x0, b.y1 - b.y0);
    ctx.fillStyle = gradLinear(ctx, shore + 620, 0, shore + 1400, 0, [[0, 'rgba(6, 40, 60, 0)'], [1, 'rgba(6, 40, 60, 0.42)']]);
    const farX = Math.max(b.x0, shore + 620);
    if (x1 > farX) ctx.fillRect(farX, b.y0, x1 - farX, b.y1 - b.y0);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'; ctx.lineWidth = 2;
    const step = 46;
    for (let y = Math.floor(b.y0 / step) * step - step; y < b.y1 + step; y += step) {
      const phase = time * 0.5 + y * 0.02;
      ctx.beginPath();
      for (let x = x0 + 20; x < x1; x += 26) {
        const wy = y + Math.sin(x * 0.012 + phase) * 4.5;
        if (x === x0 + 20) ctx.moveTo(x, wy); else ctx.lineTo(x, wy);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let y = Math.floor(b.y0 / 96) * 96 + 24; y < b.y1; y += 96) {
      for (let x = x0 + 60; x < x1; x += 152) {
        const sx = x + Math.sin(time * 0.8 + y * 0.03 + x * 0.01) * 24;
        ctx.beginPath(); ctx.moveTo(sx, y); ctx.quadraticCurveTo(sx + 18, y - 5, sx + 36, y); ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }

  function drawSurf(time) {
    const b = viewBounds(120), shore = city.shoreline;
    if (b.x1 < shore - 120) return;
    const step = 22;
    for (let y = Math.floor(b.y0 / step) * step - step; y < b.y1 + step; y += step) {
      const phase = y * 0.062 + time * 1.5;
      const depth = 8 + Math.sin(phase) * 5 + Math.sin(y * 0.021 + time * 0.6) * 3.5;
      const drift = Math.sin(phase * 0.8) * 3.5;
      const wide = 5 + 4 * Math.abs(Math.sin(y * 0.017 + 1.3));
      ctx.fillStyle = `rgba(246, 255, 253, ${0.32 + 0.16 * Math.abs(Math.sin(phase))})`;
      drawEllipse(ctx, shore + 3 + drift, y + step / 2, Math.max(3, depth + wide), step * 0.62, 0);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
      drawEllipse(ctx, shore + 7 + drift, y + step / 2, Math.max(2, depth * 0.7), step * 0.3, 0);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'; ctx.fillRect(shore - 4, b.y0, 6, b.y1 - b.y0);
    ctx.fillStyle = gradLinear(ctx, shore - 4, 0, shore + 74, 0, [[0, 'rgba(255, 255, 255, 0.28)'], [1, 'rgba(255, 255, 255, 0)']]);
    ctx.fillRect(shore - 4, b.y0, 78, b.y1 - b.y0);
    ctx.lineCap = 'round';
    for (let row = 0; row < 4; row++) {
      const alpha = 0.26 - row * 0.055;
      if (alpha <= 0.02) continue;
      ctx.strokeStyle = `rgba(240, 253, 252, ${alpha})`;
      ctx.lineWidth = 2.4 - row * 0.3;
      const spacing = 82 + row * 26;
      for (let y = Math.floor(b.y0 / spacing) * spacing; y < b.y1; y += spacing) {
        const fromX = shore + 44 + row * 96 + ((y * 7 + row * 31) % 130) + Math.sin(y * 0.043 + time * 0.7 + row) * 10;
        const len = 74 + row * 26;
        ctx.beginPath(); ctx.moveTo(fromX, y); ctx.quadraticCurveTo(fromX + len * 0.45, y - 7 - row, fromX + len, y + 1); ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    ctx.fillStyle = 'rgba(255, 252, 232, 0.4)';
    for (let i = 0; i < 46; i++) {
      const gx = shore + 90 + ((i * 173) % 640) + Math.sin(time * 0.9 + i) * 6;
      if (gx > b.x1 - 20 || gx < b.x0) continue;
      ctx.globalAlpha = 0.1 + 0.16 * Math.abs(Math.sin(time * 2.1 + i * 1.7));
      ctx.fillRect(gx, b.y0 + ((i * 271) % Math.max(1, b.y1 - b.y0)), 9 + (i % 5) * 3, 1.6);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- */
  /* traffic                                                           */
  /* ---------------------------------------------------------------- */

  function drawVehicle(v, time, night) {
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return;
    const len = v.length ?? VEHICLE.length;
    const wid = v.width ?? VEHICLE.width;
    const ang = v.angle ?? 0;
    const police = v.kind === 'police' || v.kind === 'cop';
    const lit = night > 0.32 || (v.lightsOn === true);

    ctx.save();
    ctx.translate(v.x, v.y);

    /* cast shadow: an ellipse seated under the chassis, aligned to the body,
       plus a tail that points away from the sun and stretches at dusk */
    castShadow(ctx, 0, 0, len * 0.52, wid * 0.62, sun, 0.92, ang);

    ctx.rotate(ang);

    /* headlight cone before the body so the body sits on top */
    if (lit) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gradLinear(ctx, len / 2, 0, len / 2 + 165, 0, [
        [0, `rgba(255, 238, 186, ${0.3 * Math.max(0.4, night)})`],
        [0.5, `rgba(255, 228, 160, ${0.1 * Math.max(0.4, night)})`],
        [1, 'rgba(255, 220, 150, 0)'],
      ]);
      drawPoly(ctx, [len / 2 - 2, -wid * 0.34, len / 2 - 2, wid * 0.34, len / 2 + 165, wid * 1.5, len / 2 + 165, -wid * 1.5]);
      ctx.restore();
    }

    /* tyres */
    ctx.fillStyle = '#1d2229';
    for (const wx of [-len * 0.31, len * 0.31]) {
      roundRect(ctx, wx - 4.75, -wid / 2 - 1.2, 9.5, 5, 1.8); ctx.fill();
      roundRect(ctx, wx - 4.75, wid / 2 - 6.2, 9.5, 5, 1.8); ctx.fill();
    }

    /* body */
    ctx.fillStyle = police ? '#eef1f4' : v.color ?? CAR_COLORS[0];
    roundRect(ctx, -len / 2, -wid / 2, len, wid, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(18, 22, 28, 0.34)'; ctx.lineWidth = 1.2; ctx.stroke();

    /* top-light gradient across the roof */
    ctx.fillStyle = gradLinear(ctx, 0, -wid / 2, 0, wid / 2, [
      [0, 'rgba(255, 255, 255, 0.2)'],
      [0.42, 'rgba(255, 255, 255, 0.02)'],
      [1, 'rgba(0, 0, 0, 0.16)'],
    ]);
    roundRect(ctx, -len / 2, -wid / 2, len, wid, 6); ctx.fill();

    /* windscreen + rear window */
    ctx.fillStyle = 'rgba(24, 34, 44, 0.64)';
    roundRect(ctx, len * 0.06, -wid / 2 + 3.5, len * 0.17, wid - 7, 2.6); ctx.fill();
    roundRect(ctx, -len * 0.35, -wid / 2 + 4, len * 0.14, wid - 8, 2.6); ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    roundRect(ctx, -len * 0.2, -wid / 2 + 4.5, len * 0.26, wid - 9, 2); ctx.fill();

    /* police livery + strobes */
    if (police) {
      ctx.fillStyle = 'rgba(32, 60, 120, 0.8)';
      ctx.fillRect(-len * 0.3, -wid / 2 + 4, len * 0.32, 2.2);
      ctx.fillRect(-len * 0.3, wid / 2 - 6.2, len * 0.32, 2.2);
      const flash = Math.sin(time * 13) > 0;
      ctx.fillStyle = flash ? 'rgba(255, 86, 74, 0.95)' : 'rgba(96, 150, 255, 0.95)';
      ctx.fillRect(-len * 0.1, -wid / 2 + 7, len * 0.085, 3.4);
      ctx.fillStyle = flash ? 'rgba(96, 150, 255, 0.95)' : 'rgba(255, 86, 74, 0.95)';
      ctx.fillRect(-len * 0.01, -wid / 2 + 7, len * 0.085, 3.4);
    }

    /* head + tail lamps */
    ctx.fillStyle = lit ? '#fff6ce' : '#fff2c4';
    ctx.fillRect(len / 2 - 7, -wid / 2 + 3.5, 4.5, 3);
    ctx.fillRect(len / 2 - 7, wid / 2 - 6.5, 4.5, 3);
    const braking = (v.occupied && Math.abs(v.speed ?? 0) < 26) || v.handbrake;
    ctx.fillStyle = braking ? '#ff6a58' : '#d9503f';
    ctx.fillRect(-len / 2 + 2.5, -wid / 2 + 3.5, 4.5, 3);
    ctx.fillRect(-len / 2 + 2.5, wid / 2 - 6.5, 4.5, 3);

    /* driver blob */
    if (v.occupied) {
      ctx.fillStyle = 'rgba(20, 24, 30, 0.55)';
      drawDisc(ctx, len * 0.02, 0, 3.6);
    }
    ctx.restore();

    /* brake glow on the road behind the car */
    if (braking) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bx = v.x - Math.cos(ang) * (len * 0.5 + 8);
      const by = v.y - Math.sin(ang) * (len * 0.5 + 8);
      ctx.fillStyle = gradRadial(ctx, bx, by, 1, 30, [[0, 'rgba(255, 96, 72, 0.34)'], [1, 'rgba(255, 80, 60, 0)']]);
      drawDisc(ctx, bx, by, 30);
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- */
  /* people                                                            */
  /* ---------------------------------------------------------------- */

  function drawPed(p, time) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const s = p.scale ?? 1;
    ctx.save();
    ctx.translate(p.x, p.y);

    /* contact shadow + a cast shadow whose length follows the sun */
    ctx.fillStyle = 'rgba(20, 22, 28, 0.24)';
    drawEllipse(ctx, 1.6, 3, 6.8 * s, 5 * s);
    castShadow(ctx, 0, 2.4, 7.6 * s, 4.6 * s, sun, 0.8);

    ctx.rotate((p.facing ?? 0) + Math.PI / 2);
    const down = p.down === true || (p.down ?? 0) > 0;
    if (down) {
      ctx.fillStyle = p.shirt ?? '#e8604c';
      roundRect(ctx, -9 * s, -4 * s, 18 * s, 8 * s, 3.4 * s); ctx.fill();
      ctx.fillStyle = p.skin ?? '#e8bc93';
      drawDisc(ctx, 11 * s, 0, 3.4 * s);
      ctx.fillStyle = '#40465a';
      ctx.fillRect(-13 * s, -3.4 * s, 5 * s, 2.4 * s);
      ctx.fillRect(-13 * s, 1 * s, 5 * s, 2.4 * s);
      ctx.restore();
      return;
    }
    const hurt = (p.hurt ?? 0) > 0;
    const phase = (p.walkPhase ?? p.phase ?? 0) + p.x * 0.05 + p.y * 0.03 + time * 1.6;
    const bob = Math.sin(phase) * 0.9;
    const swing = Math.sin(phase) * (hurt ? 4.4 : 2.8);

    ctx.fillStyle = '#40465a';
    roundRect(ctx, -4.2 * s, -1 + swing * 0.5, 3 * s, 7.4 * s, 1.4 * s); ctx.fill();
    roundRect(ctx, 1.2 * s, -1 - swing * 0.5, 3 * s, 7.4 * s, 1.4 * s); ctx.fill();
    ctx.fillStyle = p.shirt ?? '#e8604c';
    roundRect(ctx, -5 * s, (-7 + bob * 0.2) * s, 10 * s, 12 * s, 3.4 * s); ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    roundRect(ctx, 1.4 * s, (-7 + bob * 0.2) * s, 3.6 * s, 12 * s, 2 * s); ctx.fill();
    ctx.fillStyle = p.skin ?? '#e8bc93';
    drawDisc(ctx, 0, -9.4 * s + bob * 0.3, 3.5 * s);
    if (p.hat) {
      ctx.fillStyle = '#3a4250';
      ctx.beginPath(); ctx.arc(0, -9.6 * s + bob * 0.3, 3.9 * s, Math.PI, TAU); ctx.fill();
      ctx.fillRect(-4.2 * s, -10 * s + bob * 0.3, 8.4 * s, 1.4 * s);
    } else {
      ctx.fillStyle = 'rgba(48, 38, 32, 0.7)';
      ctx.beginPath(); ctx.arc(0, -10.2 * s + bob * 0.3, 3 * s, Math.PI, TAU); ctx.fill();
    }
    if (hurt) {
      ctx.fillStyle = `rgba(232, 102, 91, ${0.4 + Math.sin(time * 14) * 0.25})`;
      drawDisc(ctx, 0, -6 * s, 1.8 * s);
    }
    ctx.restore();
  }

  function drawOfficer(o, time = 0) {
    if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return;
    const s = o.scale ?? 1;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.26)';
    drawEllipse(ctx, 1.6, 3, 7 * s, 5.2 * s);
    castShadow(ctx, 0, 2.6, 7.8 * s, 4.8 * s, sun, 0.85);
    ctx.rotate((o.facing ?? 0) + Math.PI / 2);
    const swing = Math.sin((o.walkPhase ?? 0) + o.x * 0.05 + time * 0.4) * 3;
    ctx.fillStyle = '#1c2331';
    roundRect(ctx, -4.4 * s, -1 + swing * 0.5, 3.2 * s, 7.4 * s, 1.4 * s); ctx.fill();
    roundRect(ctx, 1.2 * s, -1 - swing * 0.5, 3.2 * s, 7.4 * s, 1.4 * s); ctx.fill();
    ctx.fillStyle = '#2b3a5c';
    roundRect(ctx, -5.2 * s, -7.2 * s, 10.4 * s, 12.4 * s, 3.4 * s); ctx.fill();
    ctx.fillStyle = 'rgba(230, 230, 210, 0.5)';
    ctx.fillRect(-5.2 * s, -3.4 * s, 10.4 * s, 1.6 * s);
    ctx.fillStyle = COLORS.gold;
    ctx.fillRect(-1.2 * s, -6.6 * s, 2.4 * s, 2.4 * s);
    ctx.fillStyle = '#e8bc93';
    drawDisc(ctx, 0, -9.4 * s, 3.5 * s);
    ctx.fillStyle = '#1c2331';
    ctx.beginPath(); ctx.arc(0, -9.8 * s, 4 * s, Math.PI, TAU); ctx.fill();
    ctx.fillRect(-4.4 * s, -10.2 * s, 8.8 * s, 1.6 * s);
    ctx.restore();
  }

  function drawPlayer(p, time = 0) {
    if (!p || !Number.isFinite(p.x)) return;
    const moved = Math.hypot(p.x - walkOrigin.x, p.y - walkOrigin.y);
    walkCycle += moved * 0.2;
    walkOrigin = { x: p.x, y: p.y };
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.28)';
    drawEllipse(ctx, 1.6, 3, 8, 5.8);
    castShadow(ctx, 0, 3, 9.2, 5.6, sun, 1);
    ctx.rotate((p.facing ?? 0) + Math.PI / 2);
    if (p.down === true) {
      ctx.fillStyle = '#2f7f8f';
      roundRect(ctx, -9, -4.4, 18, 8.8, 3.6); ctx.fill();
      ctx.fillStyle = '#f4d9b8'; drawDisc(ctx, 11, 0, 3.8);
      ctx.restore();
      return;
    }
    const stride = Math.sin(walkCycle) * 2.6;
    ctx.fillStyle = '#2f3646';
    roundRect(ctx, -4.6, -1 + stride * 0.4, 3.4, 7.6, 1.6); ctx.fill();
    roundRect(ctx, 1.2, -1 - stride * 0.4, 3.4, 7.6, 1.6); ctx.fill();
    ctx.fillStyle = '#2f7f8f';
    roundRect(ctx, -5.8, -7.8, 11.6, 13.4, 3.8); ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    roundRect(ctx, -5.8, -7.8, 3.2, 13.4, 2); ctx.fill();
    ctx.fillStyle = 'rgba(255, 240, 214, 0.7)';
    roundRect(ctx, -2.4, -7.6, 4.8, 3, 1.4); ctx.fill();
    ctx.strokeStyle = '#2f7f8f'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-5.4, -3); ctx.lineTo(-6.6, 1.6 - stride * 0.5);
    ctx.moveTo(5.4, -3); ctx.lineTo(6.6, 1.6 + stride * 0.5);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#f4d9b8'; drawDisc(ctx, 0, -10.2, 4);
    ctx.fillStyle = '#2b3140';
    ctx.beginPath(); ctx.arc(0, -10.7, 4.1, Math.PI, TAU); ctx.fill();
    ctx.fillRect(-1, -14.4, 2, 1.6);
    if ((p.hurtFlash ?? 0) > 0) {
      ctx.strokeStyle = `rgba(232, 102, 91, ${Math.min(0.55, p.hurtFlash * 1.6)})`;
      ctx.lineWidth = 1.6; drawRing(ctx, 0, -2, 12);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* particles                                                         */
  /* ---------------------------------------------------------------- */

  function emitSkid(x, y, ang, str) {
    const m = skidPool[skidIdx]; skidIdx = (skidIdx + 1) % SKID_CAP;
    m.x1 = x - Math.cos(ang) * 5; m.y1 = y - Math.sin(ang) * 5;
    m.x2 = x + Math.cos(ang) * 5; m.y2 = y + Math.sin(ang) * 5;
    m.life = 1; m.max = 1; m.width = 2.6 + str * 2;
  }

  function emitDust(x, y, vx, vy, tone = 0) {
    const p = dustPool[dustIdx]; dustIdx = (dustIdx + 1) % DUST_CAP;
    p.x = x; p.y = y; p.vx = vx * 0.16; p.vy = vy * 0.16;
    p.life = 0.72; p.max = 0.72;
    p.size = 3 + stableHash(x | 0, y | 0, dustIdx) * 3.4;
    p.tone = tone;
  }

  /* A puff that kicks up and to the side of the wheel, used for the dirt-road
     trails. Bigger and slower than the skid dust so the plume reads as a
     cloud rather than a chip of grit. */
  function emitPlume(x, y, vx, vy, scale = 1, tone = 0) {
    const p = dustPool[dustIdx]; dustIdx = (dustIdx + 1) % DUST_CAP;
    const spread = (stableHash(x | 0, y | 0, dustIdx + 7) - 0.5) * 46;
    p.x = x; p.y = y;
    p.vx = vx * 0.24 + spread * 0.02;
    p.vy = vy * 0.24 - 8;
    p.life = 1.15; p.max = 1.15;
    p.size = (2.6 + stableHash(y | 0, x | 0, dustIdx) * 3) * scale;
    p.tone = tone;
  }

  function emitFlash(x, y, ang) {
    const f = flashPool[flashIdx]; flashIdx = (flashIdx + 1) % FLASH_CAP;
    f.x = x; f.y = y; f.angle = ang; f.life = 0.16;
  }

  function stepEffects(dt, world) {
    for (const m of skidPool) if (m.life > 0) m.life = Math.max(0, m.life - dt / 4.4);
    for (const p of dustPool) {
      if (p.life <= 0) continue;
      p.life = Math.max(0, p.life - dt);
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 2.4 * dt; p.vy *= 1 - 2.4 * dt;
    }
    for (const f of flashPool) if (f.life > 0) f.life = Math.max(0, f.life - dt);

    const car = world.player?.car;
    const wanted = world.wanted ?? 0;
    if (car && Number.isFinite(car.x)) {
      const spd = Math.abs(car.speed ?? 0), ang = car.angle ?? 0;
      const onSand = city.beach ? car.x > city.beach.x + 10 && car.x < city.shoreline - 8 : false;
      const seen = lastCarState && lastCarState.car === car ? lastCarState : null;
      const drift = seen ? Math.abs(ang - seen.angle) : 0;
      const decel = seen ? seen.speed - spd : 0;
      const sliding = (world.player.handbrake && spd > 40) || (drift > 0.035 && spd > 150) || (decel > 70 && spd > 120);
      if (sliding) {
        const c = Math.cos(ang), s = Math.sin(ang);
        const rx = car.x - c * (car.length ?? VEHICLE.length) * 0.36;
        const ry = car.y - s * (car.length ?? VEHICLE.length) * 0.36;
        emitSkid(rx - s * 7.5, ry + c * 7.5, ang, 1);
        emitSkid(rx + s * 7.5, ry - c * 7.5, ang, 1);
        emitDust(rx, ry, -c * 40, -s * 40, 1);
        if (spd > 150) emitDust(rx, ry, -c * 60, -s * 60, 1);
      }
      if (onSand && spd > 70 && stableHash(car.x | 0, car.y | 0, (dt * 1000) | 0) < 0.45) {
        const c = Math.cos(ang), s = Math.sin(ang);
        emitDust(car.x - c * 24, car.y - s * 24, -c * 50, -s * 50, 2);
      }

      /* Dirt-road plume: wheels on packed earth throw a trail that scales with
         speed, and the trail is emitted at the rear axle so it hangs behind
         the car instead of under it. */
      dustClock += dt;
      if (isLoose(car.x, car.y) && spd > DIRT_DUST_SPEED) {
        const c = Math.cos(ang), s = Math.sin(ang);
        const hard = clamp((spd - DIRT_DUST_SPEED) / 180, 0, 1);
        /* Faster car → tighter interval → denser trail, but capped so the
           shared dust pool still has room for skid puffs. */
        const rate = 0.05 - hard * 0.02;
        const rear = (car.length ?? VEHICLE.length) * 0.42;
        while (dustClock > rate) {
          dustClock -= rate;
          const halfW = (car.width ?? VEHICLE.width) * 0.34;
          const side = stableHash(car.x | 0, car.y | 0, dustIdx) > 0.5 ? 1 : -1;
          emitPlume(
            car.x - c * rear - s * halfW * side,
            car.y - s * rear + c * halfW * side,
            -c * 70, -s * 70,
            0.85 + hard * 0.9,
            3
          );
        }
      }
      if (seen && decel > 90 && seen.speed > 140) {
        const nose = (car.length ?? VEHICLE.length) * 0.5;
        const nx = car.x + Math.cos(ang) * nose, ny = car.y + Math.sin(ang) * nose;
        emitFlash(nx, ny, ang);
        for (let i = 0; i < 6; i++) {
          emitDust(nx, ny, (stableHash(i, nx | 0, 1) - 0.5) * 220, (stableHash(i, ny | 0, 2) - 0.5) * 220, 1);
        }
        camera.shake = Math.min(3.2, camera.shake + 0.35);
      }
      lastCarState = { car, x: car.x, y: car.y, angle: ang, speed: spd };
    } else {
      lastCarState = null;
    }

    if (wanted > lastWanted) {
      const police = Array.isArray(world.police?.cars)
        ? world.police.cars.map(u => u?.car ?? u).filter(Boolean)
        : [];
      const shooter = police[0] ?? car;
      if (shooter && Number.isFinite(shooter.x)) {
        emitFlash(shooter.x + Math.cos(shooter.angle ?? 0) * 26, shooter.y + Math.sin(shooter.angle ?? 0) * 26, shooter.angle ?? 0);
      }
    }
    lastWanted = wanted;
  }

  function drawSkids() {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#22262c';
    for (const m of skidPool) {
      if (m.life <= 0) continue;
      ctx.globalAlpha = Math.min(0.34, m.life * m.life * 0.4);
      ctx.lineWidth = m.width ?? 3.6;
      drawSeg(ctx, m.x1, m.y1, m.x2, m.y2);
    }
    ctx.restore();
  }

  function drawDust() {
    for (const p of dustPool) {
      if (p.life <= 0) continue;
      const t = p.life / p.max;
      if (p.tone === 3) {
        /* Dirt-road plume: a pale earth cloud that spreads and fades wide. */
        const grow = 1.9 - t * 0.9;
        ctx.globalAlpha = t * t * 0.3;
        ctx.fillStyle = '#cdbb9a';
        drawEllipse(ctx, p.x, p.y, p.size * grow, p.size * grow * 0.78, 0);
        ctx.globalAlpha = t * 0.16;
        ctx.fillStyle = '#efe0c2';
        drawDisc(ctx, p.x - p.size * 0.2, p.y - p.size * 0.3, p.size * grow * 0.55);
        continue;
      }
      ctx.globalAlpha = t * 0.34;
      ctx.fillStyle = p.tone === 2 ? '#e6d2a8' : '#d8cbb2';
      drawDisc(ctx, p.x, p.y, p.size * (2 - t));
    }
    ctx.globalAlpha = 1;
  }

  function drawFlashes() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flashPool) {
      if (f.life <= 0) continue;
      const t = clamp(f.life / 0.16, 0, 1);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle);
      ctx.strokeStyle = `rgba(255, 226, 150, ${t})`;
      ctx.lineWidth = 1.8;
      const r = 4 + (1 - t) * 12;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 246, 208, ${t * 0.7})`;
      drawDisc(ctx, Math.cos(f.angle) * 6, Math.sin(f.angle) * 6, 3 + t * 3);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawCombat(combat, player, time) {
    if (!combat) return;
    for (const s of combat.bullets ?? []) {
      if (!Number.isFinite(s.x)) continue;
      const life = clamp(s.life ?? 0.1, 0, 1);
      ctx.strokeStyle = s.hostile
        ? `rgba(255, 170, 120, ${0.85 * Math.min(1, life * 2)})`
        : `rgba(255, 236, 176, ${0.9 * Math.min(1, life * 2)})`;
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      drawSeg(ctx, s.px ?? s.x, s.py ?? s.y, s.x, s.y);
    }
    ctx.lineCap = 'butt';
    for (const p of combat.particles ?? []) {
      const t = clamp((p.life ?? 0) / (p.max ?? 1), 0, 1);
      if (t <= 0) continue;
      ctx.globalAlpha = t * 0.8;
      ctx.fillStyle = p.colour ?? '#f6e2ae';
      drawDisc(ctx, p.x, p.y, Math.max(0.5, (p.r ?? 2) * (0.5 + t)));
    }
    ctx.globalAlpha = 1;
    for (const sp of combat.sparks ?? []) {
      const t = clamp((sp.life ?? 0) / (sp.max ?? 1), 0, 1);
      if (t <= 0) continue;
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(t * 2.4);
      ctx.globalAlpha = t;
      ctx.strokeStyle = sp.kind === 'gun' ? '#ffd9a0' : '#fff3c9';
      ctx.lineWidth = 1.8;
      const r = 3 + (1 - t) * 9;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        ctx.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if ((combat.muzzle ?? 0) > 0 && player && !player.car) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(player.x + Math.cos(player.facing ?? 0) * 18, player.y + Math.sin(player.facing ?? 0) * 18);
      ctx.fillStyle = gradRadial(ctx, 0, 0, 1, 26, [[0, 'rgba(255, 246, 208, 0.85)'], [1, 'rgba(255, 210, 120, 0)']]);
      drawDisc(ctx, 0, 0, 26);
      ctx.restore();
    }
    if (combat.fists && player && !player.car) {
      ctx.save();
      ctx.translate(player.x, player.y);
      ctx.rotate((player.facing ?? 0) + Math.PI / 2);
      ctx.fillStyle = '#f4d9b8';
      roundRect(ctx, -2, -20, 4, 13, 2); ctx.fill();
      ctx.restore();
    }
    for (const it of combat.pickups ?? []) {
      if (!it || it.taken) continue;
      ctx.save();
      ctx.translate(it.x, it.y + Math.sin(time * 2.6 + (it.bob ?? 0)) * 1.6);
      ctx.fillStyle = 'rgba(16, 20, 26, 0.3)';
      drawEllipse(ctx, 2, 6, 9, 3.4);
      ctx.fillStyle = gradRadial(ctx, 0, 0, 1, 22, [[0, 'rgba(242, 199, 92, 0.26)'], [1, 'rgba(242, 199, 92, 0)']]);
      drawDisc(ctx, 0, 0, 22);
      ctx.rotate(0.42);
      ctx.fillStyle = '#3b4148'; roundRect(ctx, -8, -3, 16, 5, 1.6); ctx.fill();
      ctx.fillStyle = '#5a6068'; roundRect(ctx, -3, 1, 5, 7, 1.4); ctx.fill();
      ctx.restore();
    }
  }

  function drawMarker(m) {
    if (!m || !Number.isFinite(m.x)) return;
    const bob = Math.sin(globalTime * 2.4) * 2.6, pulse = (globalTime * 0.9) % 1;
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gradRadial(ctx, 0, 0, 2, 54, [[0, 'rgba(242, 199, 92, 0.3)'], [1, 'rgba(242, 199, 92, 0)']]);
    drawDisc(ctx, 0, 0, 54);
    ctx.fillStyle = gradLinear(ctx, 0, 0, 0, -110, [[0, 'rgba(242, 199, 92, 0.22)'], [1, 'rgba(242, 199, 92, 0)']]);
    drawPoly(ctx, [-8, 0, 8, 0, 3, -110, -3, -110]);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(242, 199, 92, 0.75)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 12, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(242, 199, 92, ${0.5 * (1 - pulse)})`;
    ctx.beginPath(); ctx.ellipse(0, 0, 20 + pulse * 26, 12 + pulse * 16, 0, 0, TAU); ctx.stroke();
    const pinY = -24 + bob;
    ctx.fillStyle = 'rgba(242, 199, 92, 0.96)';
    drawPoly(ctx, [0, pinY + 12, 8.5, pinY - 4, -8.5, pinY - 4]);
    ctx.strokeStyle = 'rgba(52, 40, 16, 0.5)'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = '#3a2c10'; drawDisc(ctx, 0, pinY + 1, 2.4);
    const label = m.title ?? m.label;
    if (label) {
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      const val = m.pay ? `${label} \u00b7 $${m.pay}` : label;
      const w = Math.min(240, ctx.measureText(val).width + 18);
      ctx.fillStyle = 'rgba(12, 18, 24, 0.9)';
      roundRect(ctx, -w / 2, pinY - 30, w, 18, 5); ctx.fill();
      ctx.strokeStyle = 'rgba(242, 199, 92, 0.4)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#f7f1e2';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(val, 0, pinY - 20.5, w - 10);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* dusk                                                              */
  /* ---------------------------------------------------------------- */

  /* Warm light raking across the town. Two halves: the baked facade layer
     (drawn in world space, so it slides with the city) and a screen-space sky
     wash with a low sun over the water. Both are driven by `sun.dusk`, the same
     number that stretches the shadows, so nothing can drift out of step. */
  function drawDusk() {
    const dusk = sun.dusk;
    if (dusk <= 0.01) return;

    if (bakedLayer?.dusk) {
      const b = viewBounds(60);
      const sx = Math.max(0, Math.floor(b.x0));
      const sy = Math.max(0, Math.floor(b.y0));
      const sw = Math.min(bakedLayer.w, Math.ceil(b.x1)) - sx;
      const sh = Math.min(bakedLayer.h, Math.ceil(b.y1)) - sy;
      if (sw > 0 && sh > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = dusk * 0.92;
        ctx.drawImage(bakedLayer.dusk, sx, sy, sw, sh, sx, sy, sw, sh);
        ctx.restore();
      }
    }

    /* The sun sinking behind the western blocks, seen through the haze: a
       broad glow sitting on the town, plus its involuntary shimmer on the
       water to the east. */
    const sunX = city.width * 0.16;
    const sunY = city.height * 0.52;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = dusk * 0.5;
    ctx.fillStyle = gradRadial(ctx, sunX, sunY, 8, 520, [
      [0, 'rgba(255, 214, 150, 0.72)'],
      [0.35, 'rgba(255, 158, 96, 0.24)'],
      [1, 'rgba(255, 120, 80, 0)'],
    ]);
    drawDisc(ctx, sunX, sunY, 520);
    if (city.beach) {
      /* backlit sea: warm streaks lying across the swell */
      for (let i = 0; i < 14; i++) {
        const y = city.height * (0.16 + (i / 14) * 0.7);
        const x = city.shoreline + 24 + stableHash(i, 3.7, 1) * 240;
        const w = 90 + stableHash(i, 5.3, 2) * 220;
        ctx.globalAlpha = dusk * (0.1 + stableHash(i, 7.1, 3) * 0.14) * (0.5 + Math.sin(globalTime * 0.4 + i) * 0.5);
        ctx.fillStyle = 'rgba(255, 206, 150, 0.5)';
        ctx.fillRect(x, y, w, 2.2);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }


  /* A gentle golden wash that warms the town as the clock approaches dusk,
     then hands over to the night pass once `night` climbs past 0.1. */
  function drawDaylight(night, time) {
    const day = clamp(1 - night, 0, 1);
    if (day <= 0.02) return;
    const key = `${view.width}x${view.height}|${Math.round(night * 20)}`;
    if (!dayTintKey || dayTintKey !== key) {
      dayTintKey = key;
      dayTintCache = gradLinear(ctx, 0, 0, view.width, view.height, [
        [0, `rgba(255, 214, 150, ${0.1 * day})`],
        [0.5, 'rgba(255, 228, 180, 0)'],
        [1, `rgba(96, 140, 170, ${0.06 * day})`],
      ]);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = dayTintCache;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();

    /* Sun glint on the water, drifting with the clock. */
    if (time > 0 && city.beach) {
      const b = viewBounds(0);
      if (b.x1 > city.shoreline) {
        ctx.save();
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        const sx = (city.shoreline + 140 - camera.x) * camera.zoom + view.width / 2;
        const sy = (city.height * 0.34 - camera.y) * camera.zoom + view.height / 2;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.16 * day;
        ctx.fillStyle = gradRadial(ctx, sx, sy, 2, 260, [
          [0, 'rgba(255, 246, 214, 0.85)'],
          [1, 'rgba(255, 240, 200, 0)'],
        ]);
        drawDisc(ctx, sx, sy, 260);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
  }

  function drawNight(night, cars) {
    if (night <= 0.01) return;
    const b = viewBounds(0);
    if (bakedLayer) {
      const sx = Math.max(0, Math.floor(b.x0));
      const sy = Math.max(0, Math.floor(b.y0));
      const sw = Math.min(bakedLayer.w, Math.ceil(b.x1)) - sx;
      const sh = Math.min(bakedLayer.h, Math.ceil(b.y1)) - sy;
      if (sw > 0 && sh > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = night * 0.85;
        ctx.drawImage(bakedLayer.lights, sx, sy, sw, sh, sx, sy, sw, sh);
        ctx.restore();
      }
    }
    /* Midnight blue settles over everything, deeper in the marina. */
    ctx.fillStyle = `rgba(10, 20, 44, ${night * 0.6})`;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    if (night > 0.15) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const l of city.lamps) {
        if (l.x < b.x0 - 100 || l.x > b.x1 + 100 || l.y < b.y0 - 100 || l.y > b.y1 + 100) continue;
        ctx.fillStyle = gradRadial(ctx, l.x, l.y, 2, 96, [
          [0, `rgba(255, 214, 138, ${0.3 * night})`],
          [0.55, `rgba(255, 196, 112, ${0.11 * night})`],
          [1, 'rgba(255, 180, 90, 0)'],
        ]);
        drawDisc(ctx, l.x, l.y, 96);
      }
      for (const c of cars) {
        if (!c || c.x < b.x0 - 90 || c.x > b.x1 + 90 || c.y < b.y0 - 90 || c.y > b.y1 + 90) continue;
        const hx = c.x + Math.cos(c.angle ?? 0) * (c.length ?? VEHICLE.length) * 0.55;
        const hy = c.y + Math.sin(c.angle ?? 0) * (c.length ?? VEHICLE.length) * 0.55;
        ctx.fillStyle = gradRadial(ctx, hx, hy, 4, 128, [
          [0, `rgba(255, 236, 180, ${0.2 * night})`],
          [1, 'rgba(255, 226, 160, 0)'],
        ]);
        drawDisc(ctx, hx, hy, 128);
      }
      ctx.restore();
    }
  }

  function drawGrade(night) {
    ctx.save();
    const warm = 0.05 * (1 - night);
    if (warm > 0.002) {
      ctx.fillStyle = `rgba(255, 198, 126, ${warm})`;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    /* Sky band: as the sun sinks, the top of the frame goes peach and the
       horizon line under it goes rose, which is what sells the golden hour on
       a flat top-down view. Weighted by dusk so it is absent at noon. */
    const dusk = sun.dusk;
    if (dusk > 0.02) {
      ctx.fillStyle = gradLinear(ctx, 0, 0, 0, view.height * 0.62, [
        [0, `rgba(255, 158, 104, ${0.3 * dusk})`],
        [0.4, `rgba(255, 186, 130, ${0.16 * dusk})`],
        [0.72, `rgba(246, 176, 158, ${0.06 * dusk})`],
        [1, 'rgba(246, 176, 158, 0)'],
      ]);
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillRect(0, 0, view.width, view.height * 0.62);
      ctx.globalCompositeOperation = 'source-over';
    }
    const key = `${view.width}x${view.height}`;
    if (!vignetteCache || vignetteKey !== key) {
      vignetteCache = gradRadial(
        ctx, view.width / 2, view.height * 0.48,
        Math.min(view.width, view.height) * 0.35,
        Math.max(view.width, view.height) * 0.72,
        [[0, 'rgba(8, 14, 20, 0)'], [1, 'rgba(8, 14, 20, 0.4)']]
      );
      vignetteKey = key;
    }
    ctx.fillStyle = vignetteCache;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* minimap                                                           */
  /* ---------------------------------------------------------------- */

  /* Baked once per size and night flag: a tiny abstract of the town — sea,
     sand, per-district block colours and the pier. Player and traffic are
     stamped on top each frame so the map itself stays cheap. */
  function buildMinimap(size, night) {
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const g = cv.getContext('2d');
    const spanX = Math.max(1, city.shoreline);
    const spanY = Math.max(1, city.height);
    const kx = size / spanX, ky = size / spanY;
    const dark = night ? 0.34 : 0;

    g.fillStyle = night ? '#12303f' : '#26505f';
    g.fillRect(0, 0, size, size);

    /* water body, with a lighter shallows band */
    const shorePx = city.shoreline * kx;
    if (city.beach) {
      const sandX = city.beach.x * kx;
      const sandW = Math.max(1, shorePx - sandX);
      g.fillStyle = night ? '#4a4a3a' : '#e0c79a';
      g.fillRect(sandX, Math.min(size, city.beach.y * ky), sandW, size);
      g.fillStyle = night ? '#1d4453' : '#2f7f93';
      g.fillRect(shorePx, 0, size - shorePx, size);
    } else {
      g.fillStyle = night ? '#1d4453' : '#2f7f93';
      g.fillRect(shorePx, 0, size - shorePx, size);
    }

    /* parkland */
    for (const p of city.parks ?? []) {
      g.fillStyle = night ? '#2c4432' : '#6f9d5c';
      g.fillRect(p.x * kx, p.y * ky, Math.max(1, p.w * kx), Math.max(1, p.h * ky));
    }

    /* parking lots */
    for (const l of city.lots ?? []) {
      g.fillStyle = night ? '#2a3038' : '#565c66';
      g.fillRect(l.x * kx, l.y * ky, Math.max(1, l.w * kx), Math.max(1, l.h * ky));
    }

    /* city blocks, tinted by district */
    for (const block of city.blocks ?? []) {
      const look = lookOf(block.district);
      const base = mixColor(look.trim, '#ffffff', night ? 0.1 : 0.45);
      g.fillStyle = night ? alphaOf(base, 0.35) : base;
      g.fillRect(block.x * kx, block.y * ky, Math.max(1, block.w * kx), Math.max(1, block.h * ky));
      g.fillStyle = night ? alphaOf(look.tint, 0.4) : alphaOf(look.tint, 0.55);
      const i = city.sidewalk ?? 6;
      g.fillRect((block.x + i) * kx, (block.y + i) * ky, Math.max(1, (block.w - i * 2) * kx), Math.max(1, (block.h - i * 2) * ky));
    }

    /* streets read as thin gaps between blocks: draw the centre lines */
    g.strokeStyle = night ? 'rgba(150, 170, 190, 0.28)' : 'rgba(240, 236, 220, 0.24)';
    g.lineWidth = 1;
    for (const y of city.hy ?? []) drawSeg(g, 0, y * ky, Math.min(size, city.width * kx), y * ky);
    for (const x of city.vx ?? []) drawSeg(g, x * kx, 0, x * kx, size);

    /* pier */
    if (city.pier) {
      g.fillStyle = night ? '#5a4a34' : '#9a7a52';
      g.fillRect(city.pier.x * kx, city.pier.y * ky, Math.max(1, city.pier.w * kx), Math.max(1, city.pier.h * ky));
    }

    /* promenade strip + district seams */
    if (city.promenade) {
      g.fillStyle = night ? 'rgba(120, 140, 150, 0.3)' : 'rgba(226, 220, 204, 0.5)';
      g.fillRect(city.promenade.x * kx, 0, Math.max(1, city.promenade.w * kx), size);
    }
    for (const d of districtList) {
      g.strokeStyle = alphaOf(lookOf(d.key).tint, 0.4);
      g.lineWidth = 1;
      drawSeg(g, d.x * kx, 0, d.x * kx, size);
    }

    /* frame the shore edge so the waterline is legible */
    g.strokeStyle = night ? 'rgba(130, 200, 220, 0.4)' : 'rgba(255, 255, 255, 0.5)';
    g.lineWidth = 1;
    drawSeg(g, shorePx, 0, shorePx, size);

    if (dark > 0) {
      g.fillStyle = `rgba(8, 16, 28, ${dark})`;
      g.fillRect(0, 0, size, size);
    }
    return cv;
  }

  function drawMinimap(world, night) {
    const w = Math.min(MINIMAP_SIZE, Math.max(88, Math.round(view.width * 0.14)));
    const x = view.width - w - MINIMAP_MARGIN;
    const y = MINIMAP_TOP;
    const nighty = night > 0.35;
    const key = `${w}|${city.seed}|${nighty ? 1 : 0}`;
    if (!minimapCache || minimapCacheKey !== key) {
      minimapCache = buildMinimap(w, nighty);
      minimapCacheKey = key;
    }
    const spanX = Math.max(1, city.shoreline);
    const spanY = Math.max(1, city.height);
    const toX = (wx) => x + clamp(wx / spanX, 0, 1) * w;
    const toY = (wy) => y + clamp(wy / spanY, 0, 1) * w;

    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    ctx.fillStyle = 'rgba(10, 16, 22, 0.74)';
    roundRect(ctx, x - 4, y - 4, w + 8, w + 8, 9); ctx.fill();
    ctx.strokeStyle = 'rgba(242, 199, 92, 0.36)'; ctx.lineWidth = 1.2; ctx.stroke();

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, w, w, 6);
    ctx.clip();
    if (minimapCache) ctx.drawImage(minimapCache, x, y, w, w);

    /* parked cars, then live traffic */
    ctx.fillStyle = 'rgba(238, 234, 224, 0.42)';
    for (const v of world.parked ?? []) {
      if (!Number.isFinite(v?.x)) continue;
      ctx.fillRect(toX(v.x) - 0.9, toY(v.y) - 0.9, 1.8, 1.8);
    }
    for (const v of world.traffic?.list ?? []) {
      if (!Number.isFinite(v?.x)) continue;
      ctx.fillStyle = 'rgba(255, 238, 190, 0.75)';
      ctx.fillRect(toX(v.x) - 1.2, toY(v.y) - 1.2, 2.4, 2.4);
    }

    /* police cruisers */
    ctx.fillStyle = 'rgba(120, 170, 255, 0.92)';
    for (const u of world.police?.cars ?? []) {
      const c = u?.car ?? u;
      if (!Number.isFinite(c?.x)) continue;
      ctx.fillRect(toX(c.x) - 1.6, toY(c.y) - 1.6, 3.2, 3.2);
    }

    /* police officers on foot */
    ctx.fillStyle = 'rgba(150, 190, 255, 0.8)';
    for (const o of world.police?.officers ?? []) {
      if (!Number.isFinite(o?.x) || (o.hp ?? 1) <= 0) continue;
      ctx.fillRect(toX(o.x) - 0.8, toY(o.y) - 0.8, 1.6, 1.6);
    }

    /* player blip with a facing wedge */
    const p = world.player?.car ?? world.player;
    if (p && Number.isFinite(p.x)) {
      const px = toX(p.x), py = toY(p.y);
      const ang = p.angle ?? p.facing ?? 0;
      ctx.fillStyle = 'rgba(242, 199, 92, 0.22)';
      drawDisc(ctx, px, py, 6.5);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = '#f2c75c';
      drawPoly(ctx, [4, 0, -2.6, 2.6, -2.6, -2.6]);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 250, 235, 0.75)'; ctx.lineWidth = 1;
      drawRing(ctx, px, py, 3.6);
    }
    ctx.restore();

    /* camera footprint */
    const vw = view.width / camera.zoom, vh = view.height / camera.zoom;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'; ctx.lineWidth = 1;
    ctx.strokeRect(
      x + clamp((camera.x - vw / 2) / spanX, 0, 1) * w,
      y + clamp((camera.y - vh / 2) / spanY, 0, 1) * w,
      Math.max(2, (vw / spanX) * w),
      Math.max(2, (vh / spanY) * w)
    );

    /* compass tick */
    ctx.fillStyle = 'rgba(242, 199, 92, 0.7)';
    drawPoly(ctx, [x + w - 11, y + 4, x + w - 6.5, y + 12, x + w - 15.5, y + 12]);

    /* district caption */
    const look = lookOf(districtAt(camera.x, camera.y));
    ctx.font = '700 9px "Segoe UI", system-ui, sans-serif';
    const tw = ctx.measureText(look.label).width;
    ctx.fillStyle = 'rgba(10, 16, 22, 0.68)';
    roundRect(ctx, x + w / 2 - tw / 2 - 6, y + w + 6, tw + 12, 14, 4); ctx.fill();
    ctx.fillStyle = alphaOf(mixColor(look.tint, '#ffffff', 0.35), 0.85);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(look.label, x + w / 2, y + w + 13);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* camera + frame assembly                                           */
  /* ---------------------------------------------------------------- */

  function followCamera(dt, target, driving) {
    if (target) {
      const spd = driving ? Math.abs(target.speed ?? 0) : Math.hypot(target.vx ?? 0, target.vy ?? 0);
      const h = driving ? target.angle ?? 0 : target.facing ?? 0;
      const ahead = clamp(spd * 0.34, 0, CAMERA.lookAhead * 2.4);
      camera.x = damp(camera.x, target.x + Math.cos(h) * ahead, CAMERA.follow, dt);
      camera.y = damp(camera.y, target.y + Math.sin(h) * ahead, CAMERA.follow, dt);
      camera.zoom = damp(
        camera.zoom,
        (driving ? CAMERA.zoomCar : CAMERA.zoomFoot) - Math.min(0.06, (spd / 325) * 0.06),
        CAMERA.zoomRate,
        dt
      );
    }
    camera.shake = Math.max(0, camera.shake - CAMERA.shakeDecay * dt);
    if (!Number.isFinite(camera.x)) camera.x = city.downtown.x;
    if (!Number.isFinite(camera.y)) camera.y = city.downtown.y;
  }

  /* ------------------------------------------------------------------ */
  /* deterministic staging (?shot=)                                     */
  /* ------------------------------------------------------------------ */

  /*
   * Pins the camera exactly on the pose it would otherwise ease toward.
   *
   * Both draw paths damp the camera a little closer to its target every
   * frame. That is right for play, but a ?shot= frame is meant to be the same
   * picture on every reload: without this the camera is still converging when
   * the frame is captured, so two runs differ by a pixel of drift forever.
   *
   * Landing on clamp(target) makes the next damp a no-op — the value either
   * equals the target, or sits on the bound the target lies beyond, where
   * damping toward it and re-clamping returns the same bound.
   */
  function snapCamera(target, driving = false) {
    if (target) {
      const spd = driving ? Math.abs(target.speed ?? 0) : Math.hypot(target.vx ?? 0, target.vy ?? 0);
      const h = driving ? target.angle ?? 0 : target.facing ?? 0;
      const ahead = clamp(spd * 0.34, 0, CAMERA.lookAhead * 2.4);
      camera.x = target.x + Math.cos(h) * ahead;
      camera.y = target.y + Math.sin(h) * ahead;
      camera.zoom = (driving ? CAMERA.zoomCar : CAMERA.zoomFoot) - Math.min(0.06, (spd / 325) * 0.06);
    }
    camera.shake = 0;
    camera.ox = 0;
    camera.oy = 0;
    clampCamera();
  }

  /* The title/overview pose at time 0 — the one drawOverview() eases toward. */
  function snapOverview() {
    const pivotX = city.downtown.x + (city.shoreline - city.downtown.x) * 0.18;
    camera.x = pivotX + Math.cos(0) * 250;
    camera.y = city.downtown.y + Math.sin(0) * 170;
    camera.zoom = 0.5 + Math.sin(0) * 0.03;
    camera.shake = 0;
    camera.ox = 0;
    camera.oy = 0;
    clampCamera();
  }

  function clampCamera() {
    const hw = view.width / 2 / camera.zoom, hh = view.height / 2 / camera.zoom;
    const minX = Math.min(hw, city.width / 2), minY = Math.min(hh, city.height / 2);
    const maxX = Math.max(city.water.x + city.water.w * 0.22 - hw, minX);
    camera.x = clamp(camera.x, minX, maxX);
    camera.y = clamp(camera.y, minY, Math.max(city.height - hh, minY));
    if (!Number.isFinite(camera.x)) camera.x = city.downtown.x;
    if (!Number.isFinite(camera.y)) camera.y = city.downtown.y;
  }

  function pushWorld() {
    const sh = camera.shake;
    camera.ox = sh > 0.001 ? (stableHash(camera.x * 13 + globalTime * 60, camera.y, 1) - 0.5) * sh * 10 : 0;
    camera.oy = sh > 0.001 ? (stableHash(camera.y * 13 + globalTime * 60, camera.x, 2) - 0.5) * sh * 10 : 0;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.save();
    ctx.translate(view.width / 2 + camera.ox, view.height / 2 + camera.oy);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
  }

  function blitBaked() {
    if (!bakedLayer) return;
    const b = viewBounds(60);
    const sx = Math.max(0, Math.floor(b.x0));
    const sy = Math.max(0, Math.floor(b.y0));
    const sw = Math.min(bakedLayer.w, Math.ceil(b.x1)) - sx;
    const sh = Math.min(bakedLayer.h, Math.ceil(b.y1)) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(bakedLayer.layer, sx, sy, sw, sh, sx, sy, sw, sh);
  }

  function drawVehicles(world, night, b) {
    const skip = world.player?.car;
    const one = (v) => {
      if (!v || v === skip || !Number.isFinite(v.x)) return;
      if (v.x < b.x0 || v.x > b.x1 || v.y < b.y0 || v.y > b.y1) return;
      drawVehicle(v, globalTime, night);
    };
    for (const v of world.parked ?? []) one(v);
    for (const v of world.traffic?.list ?? []) one(v);
    for (const u of world.police?.cars ?? []) one(u?.car ?? u);
  }

  /* Crowd drawn back-to-front so near pedestrians overlap far ones, and
     parked cars on the far kerb sit behind the walkers. */
  function drawCrowd(world, b) {
    const walkers = [];
    for (const p of world.pedestrians?.list ?? []) {
      if (!p || p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
      walkers.push({ p, officer: false });
    }
    for (const o of world.police?.officers ?? []) {
      if (!o || (o.hp ?? 1) <= 0) continue;
      if (o.x < b.x0 || o.x > b.x1 || o.y < b.y0 || o.y > b.y1) continue;
      walkers.push({ p: o, officer: true });
    }
    walkers.sort((q, r) => q.p.y - r.p.y);
    for (const entry of walkers) {
      if (entry.officer) drawOfficer(entry.p, globalTime);
      else drawPed(entry.p, globalTime);
    }
  }

  function paintCore(world, night, pad) {
    pushWorld();
    drawSea(globalTime);
    blitBaked();
    drawSurf(globalTime);
    if (city.pier) drawPier(ctx, city.shoreline, city.pier.x + city.pier.w);
    drawSkids();
    const b = viewBounds(pad);
    drawVehicles(world, night, b);
    drawCrowd(world, b);
    return b;
  }

  function drawMarkerArrow(m) {
    if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const sx = (m.x - camera.x) * camera.zoom + view.width / 2;
    const sy = (m.y - camera.y) * camera.zoom + view.height / 2;
    const pad = 74;
    if (sx > pad && sx < view.width - pad && sy > pad && sy < view.height - pad) return;
    const cx = view.width / 2, cy = view.height / 2;
    const ang = Math.atan2(sy - cy, sx - cx);
    const rad = Math.min(view.width, view.height) / 2 - 46;
    const pulse = 0.6 + 0.4 * Math.sin(globalTime * 3);
    ctx.save();
    ctx.translate(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
    ctx.rotate(ang);
    ctx.fillStyle = `rgba(242, 199, 92, ${0.55 + pulse * 0.35})`;
    drawPoly(ctx, [12, 0, -7, 8, -3, 0, -7, -8]);
    ctx.strokeStyle = 'rgba(42, 32, 10, 0.45)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  function collectCars(world) {
    const all = [];
    const car = world.player?.car;
    for (const v of world.parked ?? []) all.push(v);
    for (const v of world.traffic?.list ?? []) all.push(v);
    for (const u of world.police?.cars ?? []) all.push(u?.car ?? u);
    if (car) all.push(car);
    return all;
  }

  function draw(world, opts) {
    if (needsBake || !bakedLayer) buildBake();
    settleSize();
    const {
      time = 0, night = 0, target = world.player,
      driving = !!world.player?.car, marker = null, dt = 1 / 60,
      minimap = true,
    } = opts ?? {};
    globalTime = time;
    world.time = time;
    sun = sunState(night);
    followCamera(dt, target, driving);
    clampCamera();
    stepEffects(dt, world);

    paintCore(world, night, 90);
    const car = world.player?.car;
    if (car) drawVehicle(car, time, night);
    else if (world.player) drawPlayer(world.player, time);

    drawDust();
    drawFlashes();
    drawCombat(world.combat, world.player, time);
    drawMarker(marker);
    drawDusk();
    drawNight(night, collectCars(world));

    ctx.restore();
    drawDaylight(night, time);
    drawGrade(night);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawMarkerArrow(marker);
    if (minimap) drawMinimap(world, night);
  }

  function drawOverview(world, time = 0, night = 0) {
    if (needsBake || !bakedLayer) buildBake();
    settleSize();
    globalTime = time;
    world.time = time;
    sun = sunState(night);
    const pivotX = city.downtown.x + (city.shoreline - city.downtown.x) * 0.18;
    camera.x = damp(camera.x, pivotX + Math.cos(time * 0.055) * 250, 1.6, 1 / 60);
    camera.y = damp(camera.y, city.downtown.y + Math.sin(time * 0.043) * 170, 1.6, 1 / 60);
    camera.zoom = damp(camera.zoom, 0.5 + Math.sin(time * 0.031) * 0.03, 1.2, 1 / 60);
    camera.shake = 0;
    camera.ox = 0;
    camera.oy = 0;
    clampCamera();
    stepEffects(1 / 60, world);
    paintCore(world, night, 120);
    ctx.fillStyle = gradLinear(ctx, view.width * 0.55, 0, view.width, view.height * 0.9, [
      [0, 'rgba(255, 206, 138, 0)'],
      [1, `rgba(255, 206, 138, ${0.1 * (1 - night)})`],
    ]);
    ctx.fillRect(-city.width, -city.height, city.width * 2, city.height * 2);
    drawDusk();
    ctx.restore();
    drawDaylight(night, time);
    drawGrade(night);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawMinimap(world, night);
  }

  function toScreen(x, y) {
    return {
      x: (x - camera.x) * camera.zoom + view.width / 2,
      y: (y - camera.y) * camera.zoom + view.height / 2,
    };
  }

  function toWorld(x, y) {
    return {
      x: (x - view.width / 2) / camera.zoom + camera.x,
      y: (y - view.height / 2) / camera.zoom + camera.y,
    };
  }

  function nudgeShake(amt) {
    camera.shake = clamp(camera.shake + Math.abs(Number(amt) || 0), 0, 3.2);
  }

  return {
    draw,
    drawOverview,
    resize: readSize,
    nudgeShake,
    snapCamera,
    snapOverview,
    camera,
    view,
    worldToScreen: toScreen,
    screenToWorld: toWorld,
    rebake() { needsBake = true; minimapCache = null; minimapCacheKey = ''; },
  };
}
