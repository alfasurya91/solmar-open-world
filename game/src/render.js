// Solmar seen from the air: a town on the coast, drawn top-down.
//
// The town itself never moves, so the entire still layer — streets with their paint and crossings,
// kerbs, the paving rings and courtyards, the lifted roofs and the clutter on them, the parks, the
// car parks, the promenade, the sand, and the landward half of the pier — is painted once into an
// offscreen canvas at world scale. A frame then only copies the slice of that canvas the camera can
// see. The live pass is reserved for what genuinely changes: the sea and its surf, the traffic, the
// crowd, the player, rubber and dust, the objective pin, the glow that arrives after dark, and a
// closing grade over the whole frame.
//
// The camera trails whatever is being driven or walked, leans into that heading, widens slightly
// behind the wheel, and jolts when nudgeShake is called. drawOverview is the slow aerial drift that
// sits behind the title card. Anything drawn above the world in screen space is the HUD's business;
// this module always hands the context back at CSS-pixel scale and leaves no transform behind.
//
// main.js expects: createRenderer(canvas, city) -> { view, camera, nudgeShake, draw, drawOverview,
// resize, worldToScreen, screenToWorld, rebake }. The screen names are exported from here because the
// screenshot runner imports them from this module.

import { CAMERA, CAR_COLORS, COLORS, VEHICLE } from './config.js';
import { TAU, clamp, damp, roundRect } from './utils.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_OVER = 'over';

/** The baked layer reaches this far past the shoreline so the pier's far end is covered too. */
const BAKE_MARGIN = 220;

/** Effect pools have a fixed size: no amount of driving may make them grow. */
const SKID_MAX = 400;
const DUST_MAX = 160;
const FLASH_MAX = 10;

/** Bay geometry, matching the measurements the city generator parked cars against. */
const BAY_W = 30;
const BAY_H = 54;

// --- colour -------------------------------------------------------------------------------------

const RGB_CACHE = new Map();

/** '#rrggbb' (or '#rgb') to [r, g, b]. Only a handful of palette entries, so results are memoised. */
function rgb(hex) {
  if (typeof hex !== 'string') return [255, 255, 255];
  const hit = RGB_CACHE.get(hex);
  if (hit) return hit;
  let body = hex.trim().replace('#', '');
  if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
  const value = Number.parseInt(body, 16);
  const out = Number.isFinite(value) ? [(value >> 16) & 255, (value >> 8) & 255, value & 255] : [255, 255, 255];
  RGB_CACHE.set(hex, out);
  return out;
}

/** Move a colour towards white (t > 0) or black (t < 0) by that fraction of the remaining gap. */
function shade(hex, t) {
  const [r, g, b] = rgb(hex);
  const to = t < 0 ? 0 : 255;
  const k = clamp(Math.abs(t), 0, 1);
  return `rgb(${Math.round(r + (to - r) * k)}, ${Math.round(g + (to - g) * k)}, ${Math.round(b + (to - b) * k)})`;
}

/**
 * Stable pseudo-random in [0, 1) from three integers. Baked texture only — grain, speckles, window
 * lights — never anything the simulation could observe.
 */
function hash01(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// --- paint primitives ---------------------------------------------------------------------------

const fillDisc = (g, x, y, r) => {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
};

const fillEllipse = (g, x, y, rx, ry, rot = 0) => {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, TAU);
  g.fill();
};

const strokeRing = (g, x, y, r) => {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.stroke();
};

const strokeSegment = (g, x1, y1, x2, y2) => {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
};

/** Fill a closed polygon given as a flat [x0, y0, x1, y1, ...] list. */
const fillPoly = (g, pts) => {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  g.fill();
};

const gradientAlong = (g, x0, y0, x1, y1, stops) => {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const stop of stops) gr.addColorStop(stop[0], stop[1]);
  return gr;
};

const gradientAround = (g, x, y, r0, r1, stops) => {
  const gr = g.createRadialGradient(x, y, r0, x, y, r1);
  for (const stop of stops) gr.addColorStop(stop[0], stop[1]);
  return gr;
};

// --- the renderer -------------------------------------------------------------------------------

export function createRenderer(canvas, city) {
  const view = { width: 1280, height: 720, dpr: 1 };
  const camera = { x: city.spawn.x, y: city.spawn.y, zoom: CAMERA.zoomFoot, shake: 0, ox: 0, oy: 0 };
  const ctx = canvas.getContext('2d');

  /** The baked world layer and its night-light twin, both built lazily. */
  let baked = null;
  let bakeDirty = true;

  /** Panes that glow after dark, gathered while the facades are painted. */
  let litWindows = [];

  /** Pre-allocated effect pools: tyre marks, dust, and short flashes. */
  const skids = Array.from({ length: SKID_MAX }, () => ({ x1: 0, y1: 0, x2: 0, y2: 0, life: 0, max: 1, width: 3.6 }));
  const dust = Array.from({ length: DUST_MAX }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 0, tone: 0 }));
  const flashes = Array.from({ length: FLASH_MAX }, () => ({ x: 0, y: 0, angle: 0, life: 0 }));
  let skidCursor = 0;
  let dustCursor = 0;
  let flashCursor = 0;

  /** The last pose of the driven car, so a slide can be told from a straight line. */
  let prevCar = null;
  let prevWanted = 0;
  let walkPhase = 0;
  let walkFrom = { x: city.spawn.x, y: city.spawn.y };
  let clockTime = 0;
  let vignette = null;
  let vignetteKey = '';

  // --- sizing ---------------------------------------------------------------------------------

  /** Read the CSS box and the pixel ratio; the backing store always follows the CSS box. */
  function measure() {
    const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2.5);

    const readBox = () => {
      if (typeof canvas.getBoundingClientRect === 'function') {
        const box = canvas.getBoundingClientRect();
        return { w: box.width, h: box.height };
      }
      return { w: canvas.clientWidth || 0, h: canvas.clientHeight || 0 };
    };

    let { w: cssW, h: cssH } = readBox();

    // A page that gave the element no box at all would otherwise have its backing store size the
    // element in device pixels, halving the view on HiDPI. Let it fill its container instead.
    if ((!cssW || !cssH) && canvas.style) {
      if (!cssW && !canvas.style.width) canvas.style.width = '100%';
      if (!cssH && !canvas.style.height) canvas.style.height = '100%';
      const again = readBox();
      cssW = cssW || again.w;
      cssH = cssH || again.h;
    }

    if (!cssW) cssW = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    if (!cssH) cssH = (typeof window !== 'undefined' && window.innerHeight) || 720;
    cssW = Math.max(320, Math.round(cssW));
    cssH = Math.max(240, Math.round(cssH));

    view.width = cssW;
    view.height = cssH;
    view.dpr = dpr;

    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    vignette = null;
    return dpr;
  }

  measure();
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
  }

  /**
   * The canvas box may only settle a frame or two after boot — a late stylesheet, a web font, a
   * flex layout. No resize event necessarily follows, so re-measure for the first dozen frames and
   * then leave it to the listener, which keeps the steady state free of layout reads.
   */
  let warmup = 12;
  function settleSize() {
    if (warmup <= 0) return;
    warmup -= 1;
    measure();
  }

  /** The visible world rectangle, padded so anything just outside never pops in. */
  function bounds(pad = 80) {
    const hw = view.width / (2 * camera.zoom) + pad;
    const hh = view.height / (2 * camera.zoom) + pad;
    return { x0: camera.x - hw, y0: camera.y - hh, x1: camera.x + hw, y1: camera.y + hh };
  }

  // --- baked furniture ------------------------------------------------------------------------

  const castShadow = (g, x, y, rx, ry, a = 0.18) => {
    g.fillStyle = `rgba(28, 30, 34, ${a})`;
    fillEllipse(g, x + rx * 0.28, y + ry * 0.38, rx, ry);
  };

  /** A tree from above: shadow, trunk, and a canopy of offset blobs so it never reads as a lollipop. */
  function paintTree(g, tree, seed) {
    const r = tree.r ?? 15;
    if (tree.kind === 'palm') {
      castShadow(g, tree.x, tree.y, r * 0.72, r * 0.5, 0.16);
      const cx = tree.x + r * 0.1;
      const cy = tree.y - r * 0.15;
      g.strokeStyle = '#8a6a45';
      g.lineWidth = Math.max(2.4, r * 0.15);
      g.lineCap = 'round';
      strokeSegment(g, tree.x, tree.y + 3, cx, cy);
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * TAU + seed * 0.6;
        const len = r * (0.9 + (i % 2) * 0.2);
        g.strokeStyle = i % 2 ? '#6f9d57' : COLORS.grassDark;
        g.lineWidth = Math.max(2, r * 0.14);
        g.beginPath();
        g.moveTo(cx, cy);
        g.quadraticCurveTo(cx + Math.cos(a) * len * 0.6, cy + Math.sin(a) * len * 0.55, cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.95);
        g.stroke();
      }
      g.fillStyle = '#7fa865';
      fillDisc(g, cx, cy, Math.max(1.6, r * 0.15));
      g.lineCap = 'butt';
      return;
    }

    castShadow(g, tree.x, tree.y, r * 0.92, r * 0.68, 0.2);
    g.fillStyle = '#6b5136';
    fillDisc(g, tree.x, tree.y, Math.max(2, r * 0.19));
    const blobs = [
      [0, 0, r, COLORS.grassDark],
      [-r * 0.44, -r * 0.26, r * 0.66, COLORS.grass],
      [r * 0.4, -r * 0.3, r * 0.6, COLORS.grass],
      [r * 0.14, r * 0.42, r * 0.54, COLORS.grassDark],
    ];
    for (const [ox, oy, rr, colour] of blobs) {
      g.fillStyle = colour;
      fillDisc(g, tree.x + ox, tree.y + oy, rr);
    }
    g.fillStyle = 'rgba(255, 255, 220, 0.26)';
    fillDisc(g, tree.x - r * 0.3, tree.y - r * 0.34, r * 0.34);
  }

  function paintBench(g, bench) {
    g.save();
    g.translate(bench.x, bench.y);
    g.rotate(bench.angle ?? 0);
    g.fillStyle = 'rgba(26, 24, 22, 0.18)';
    g.fillRect(-13, 4, 26, 6);
    g.fillStyle = '#9a6d43';
    roundRect(g, -13, -4, 26, 7, 2);
    g.fill();
    g.fillStyle = '#7d5734';
    g.fillRect(-13, -7, 26, 3);
    g.fillStyle = '#4e4034';
    g.fillRect(-9, 3, 3, 4);
    g.fillRect(6, 3, 3, 4);
    g.restore();
  }

  /** A beach parasol: eight alternating wedges, a shadow, and a pole cap at the centre. */
  function paintUmbrella(g, umbrella) {
    const colour = umbrella.color ?? '#e2604f';
    castShadow(g, umbrella.x, umbrella.y, 15, 9, 0.18);
    for (let i = 0; i < 8; i += 1) {
      g.fillStyle = i % 2 ? '#f2ede2' : colour;
      g.beginPath();
      g.moveTo(umbrella.x, umbrella.y);
      g.arc(umbrella.x, umbrella.y, 15, (i / 8) * TAU, ((i + 1) / 8) * TAU);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = 'rgba(90, 76, 58, 0.35)';
    g.lineWidth = 1;
    strokeRing(g, umbrella.x, umbrella.y, 15);
    g.fillStyle = '#6a5c48';
    fillDisc(g, umbrella.x, umbrella.y, 2.2);
  }

  /** A lamp standard from above: base pad, pole, arm and the warm head that lights up at night. */
  function paintLamp(g, lamp) {
    g.fillStyle = 'rgba(20, 22, 26, 0.22)';
    fillEllipse(g, lamp.x + 2.4, lamp.y + 3, 5, 3.6);
    g.fillStyle = '#6a6f74';
    fillDisc(g, lamp.x, lamp.y, 3.4);
    g.fillStyle = '#8d939a';
    fillDisc(g, lamp.x - 0.8, lamp.y - 0.8, 2.2);
    g.strokeStyle = '#6a6f74';
    g.lineWidth = 2;
    strokeSegment(g, lamp.x, lamp.y, lamp.x + 7, lamp.y - 9);
    g.fillStyle = '#f2d79d';
    fillDisc(g, lamp.x + 7, lamp.y - 9, 2.6);
  }

  /**
   * One building, painted as a block seen from above: the cast shadow, the sunlit south wall with
   * its window grid, the east return turning away, the roof plate lifted clear of the walls, its
   * parapet and its clutter, and — where the generator said so — a striped awning over the door.
   */
  function paintBuilding(g, building, seed) {
    const lift = clamp(building.lift ?? 4, 2, 14);
    const style = building.style ?? { wall: '#c8b9a6', roof: '#a99a86' };
    const wall = style.wall;
    const roof = style.roof;
    const ox = -lift * 0.26;
    const oy = -lift * 1.15;
    const R = building.x + building.w;
    const B = building.y + building.h;

    g.fillStyle = `rgba(38, 34, 30, ${0.16 + Math.min(0.14, lift * 0.016)})`;
    g.fillRect(building.x + 4 + lift * 0.42, building.y + 6 + lift * 0.88, building.w, building.h);
    g.fillStyle = 'rgba(38, 34, 30, 0.1)';
    g.fillRect(building.x + 3, building.y + 4, building.w, building.h);

    // South wall first, then the east wall falling away from the light.
    g.fillStyle = gradientAlong(g, 0, B + oy, 0, B, [[0, shade(wall, -0.06)], [1, shade(wall, -0.3)]]);
    fillPoly(g, [building.x, B, R, B, R + ox, B + oy, building.x + ox, B + oy]);
    g.fillStyle = shade(wall, -0.38);
    fillPoly(g, [R, building.y, R, B, R + ox, B + oy, R + ox, building.y + oy]);

    // Roof plate.
    g.fillStyle = roof;
    fillPoly(g, [building.x + ox, building.y + oy, R + ox, building.y + oy, R + ox, B + oy, building.x + ox, B + oy]);
    g.strokeStyle = shade(roof, -0.32);
    g.lineWidth = 1.4;
    g.stroke();
    g.fillStyle = shade(roof, 0.18);
    g.fillRect(building.x + ox, building.y + oy, building.w, 2.6);
    g.fillRect(building.x + ox, building.y + oy, 2.6, building.h);
    g.strokeStyle = shade(roof, -0.14);
    g.lineWidth = 1;
    g.strokeRect(building.x + ox + 5.5, building.y + oy + 5.5, Math.max(1, building.w - 11), Math.max(1, building.h - 11));

    // Tar seams across the roof.
    g.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    for (let sx = building.x + ox + 30; sx < R + ox - 10; sx += 46) strokeSegment(g, sx, building.y + oy + 7, sx, B + oy - 7);

    // Floor bands on the visible wall, with a mix of lit and dark panes.
    const floors = Math.max(1, Math.min(building.floors ?? 1, 6));
    if (lift > 4.5) {
      const band = (lift - 4.5) / floors;
      const winH = Math.max(1.6, band * 0.46);
      for (let f = 0; f < floors; f += 1) {
        const wy = B + oy + 3.5 + f * band;
        if (wy + winH > B - 3) continue;
        for (let wx = building.x + 6; wx < R - 10; wx += 13) {
          const lit = hash01(seed >>> 0, f, (wx * 0.37) | 0) < 0.33;
          g.fillStyle = lit ? 'rgba(255, 226, 158, 0.4)' : 'rgba(44, 60, 76, 0.38)';
          g.fillRect(wx, wy, 6, winH);
          if (lit) litWindows.push({ x: wx, y: wy, w: 6, h: winH });
        }
      }
    }

    // The doorway, always at the foot of the street-facing wall.
    g.fillStyle = 'rgba(32, 38, 46, 0.6)';
    g.fillRect(building.x + building.w / 2 - 7, B - 5, 14, 5);

    for (const item of building.roof ?? []) {
      const ix = building.x + ox + clamp(item.x, 3, Math.max(3, building.w - item.w - 3));
      const iy = building.y + oy + clamp(item.y, 3, Math.max(3, building.h - item.h - 3));
      g.fillStyle = 'rgba(40, 34, 26, 0.22)';
      g.fillRect(ix + 2, iy + 2.5, item.w, item.h);
      if (item.kind === 'tank') {
        const cx = ix + item.w / 2;
        const cy = iy + item.h / 2;
        const rad = Math.min(item.w, item.h) / 2;
        g.fillStyle = '#9aa1a3';
        fillDisc(g, cx, cy, rad);
        g.strokeStyle = '#6f7678';
        g.lineWidth = 1.1;
        strokeRing(g, cx, cy, rad);
        g.fillStyle = '#7d8486';
        fillDisc(g, cx, cy, Math.min(item.w, item.h) * 0.22);
      } else {
        g.fillStyle = shade(roof, -0.14);
        g.fillRect(ix, iy, item.w, item.h);
        g.fillStyle = shade(roof, 0.24);
        g.fillRect(ix, iy, item.w, 2);
        g.strokeStyle = 'rgba(30, 34, 40, 0.14)';
        g.lineWidth = 1;
        for (let k = iy + 4; k < iy + item.h - 2; k += 4) strokeSegment(g, ix + 1, k, ix + item.w - 1, k);
      }
    }

    // Tall blocks get the occasional antenna, so the skyline is never uniform.
    if ((building.floors ?? 1) >= 5 && hash01(seed, 9, 4) < 0.5) {
      const ax = building.x + ox + building.w * 0.7;
      g.strokeStyle = shade(roof, -0.5);
      g.lineWidth = 1.4;
      strokeSegment(g, ax, building.y + oy + building.h * 0.55, ax, building.y + oy + building.h * 0.55 - 16);
      g.fillStyle = COLORS.red;
      fillDisc(g, ax, building.y + oy + building.h * 0.55 - 17, 1.7);
    }

    if (building.awning) {
      g.fillStyle = 'rgba(20, 24, 30, 0.2)';
      g.fillRect(building.x + 5, B + 6, Math.max(1, building.w - 8), 5);
      g.fillStyle = building.awning.color;
      g.fillRect(building.x + 3, B - 1, Math.max(1, building.w - 6), 8);
      g.fillStyle = 'rgba(255, 255, 255, 0.3)';
      for (let x = building.x + 5; x < R - 8; x += 13) g.fillRect(x, B - 1, 6, 8);
    }

    // Skylights, on the deeper roofs only.
    if (building.h > 110) {
      for (let i = 0; i < 2; i += 1) {
        if (hash01(seed + i, 2.2, 1) < 0.4) continue;
        const sx = building.x + ox + 16 + hash01(seed + i, 5.1, 2) * Math.max(1, building.w - 50);
        const sy = building.y + oy + 16 + hash01(seed + i, 7.3, 3) * Math.max(1, building.h - 50);
        g.fillStyle = 'rgba(150, 200, 220, 0.45)';
        g.fillRect(sx, sy, 12, 8);
        g.strokeStyle = 'rgba(30, 40, 50, 0.35)';
        g.lineWidth = 1;
        g.strokeRect(sx, sy, 12, 8);
      }
    }
  }

  // --- baked street paint ---------------------------------------------------------------------

  /** Centre line and gutter paint on every street, stopped short of each junction. */
  function paintStreetLines(g) {
    const half = city.roadWidth / 2;
    const inset = half + 8;
    g.lineCap = 'butt';

    for (let r = 0; r < city.hy.length; r += 1) {
      const y = city.hy[r];
      for (let c = 0; c < city.vx.length - 1; c += 1) {
        const from = city.vx[c] + inset;
        const to = city.vx[c + 1] - inset;
        if (to - from < 12) continue;
        g.strokeStyle = COLORS.lineWarm;
        g.lineWidth = 1.8;
        g.setLineDash([]);
        strokeSegment(g, from, y, to, y);
        g.strokeStyle = 'rgba(231, 225, 207, 0.34)';
        g.lineWidth = 1.4;
        g.setLineDash([16, 20]);
        strokeSegment(g, from, y - half + 12, to, y - half + 12);
        strokeSegment(g, from, y + half - 12, to, y + half - 12);
      }
    }

    for (let c = 0; c < city.vx.length; c += 1) {
      const x = city.vx[c];
      for (let r = 0; r < city.hy.length - 1; r += 1) {
        const from = city.hy[r] + inset;
        const to = city.hy[r + 1] - inset;
        if (to - from < 12) continue;
        g.strokeStyle = COLORS.lineWarm;
        g.lineWidth = 1.8;
        g.setLineDash([]);
        strokeSegment(g, x, from, x, to);
        g.strokeStyle = 'rgba(231, 225, 207, 0.34)';
        g.lineWidth = 1.4;
        g.setLineDash([16, 20]);
        strokeSegment(g, x - half + 12, from, x - half + 12, to);
        strokeSegment(g, x + half - 12, from, x + half - 12, to);
      }
    }
    g.setLineDash([]);
  }

  /** Zebra stripes on all four approaches to a junction. */
  function paintCrosswalk(g, x, y) {
    const half = city.roadWidth / 2;
    const inner = 26;
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

  /** Faint wear across a junction: the smear a thousand turning cars would leave. */
  function paintJunctionWear(g, x, y) {
    const road = city.roadWidth;
    for (let i = 0; i < 4; i += 1) {
      g.fillStyle = `rgba(255, 255, 255, ${0.012 + hash01(x + i, y, i) * 0.02})`;
      fillEllipse(
        g,
        x + (hash01(x + i, 1.2, i) - 0.5) * road * 0.8,
        y + (hash01(y + i, 3.4, i) - 0.5) * road * 0.8,
        hash01(i, 2.1, 1) * 18 + 10,
        hash01(i, 5.6, 2) * 10 + 6,
        hash01(i, 7.7, 3) * TAU,
      );
    }
  }

  function paintPark(g, park, seed) {
    g.fillStyle = COLORS.grass;
    g.fillRect(park.x, park.y, park.w, park.h);
    g.fillStyle = 'rgba(255, 255, 255, 0.045)';
    for (let y = park.y; y < park.y + park.h; y += 26) g.fillRect(park.x, y, park.w, 12);

    g.strokeStyle = COLORS.path;
    g.lineWidth = 15;
    g.beginPath();
    g.moveTo(park.x + park.w / 2, park.y);
    g.lineTo(park.x + park.w / 2, park.y + park.h);
    g.moveTo(park.x, park.y + park.h / 2);
    g.lineTo(park.x + park.w, park.y + park.h / 2);
    g.stroke();

    const cx = park.x + park.w / 2;
    const cy = park.y + park.h / 2;
    g.fillStyle = '#c7b89b';
    fillDisc(g, cx, cy, 19);
    g.fillStyle = hash01(seed, 4, 2) < 0.4 ? COLORS.grassLight : '#79b3ba';
    fillDisc(g, cx, cy, 14.5);
    g.fillStyle = 'rgba(255, 255, 255, 0.4)';
    fillDisc(g, cx - 3.5, cy - 3.5, 4.5);

    g.fillStyle = '#5d8a4c';
    g.fillRect(park.x, park.y, park.w, 6);
    g.fillRect(park.x, park.y + park.h - 6, park.w, 6);
    g.fillRect(park.x, park.y, 6, park.h);
    g.fillRect(park.x + park.w - 6, park.y, 6, park.h);

    const spots = [
      [park.x + 32, park.y + 32],
      [park.x + park.w - 34, park.y + 34],
      [park.x + 34, park.y + park.h - 34],
      [park.x + park.w - 36, park.y + park.h - 36],
      [park.x + park.w * 0.5, park.y + 26],
      [park.x + park.w * 0.5, park.y + park.h - 26],
    ];
    spots.forEach(([tx, ty], i) => paintTree(g, { x: tx, y: ty, r: 12 + hash01(park.x + i, park.y, 5) * 7 }, i));

    for (let i = 0; i < 2; i += 1) {
      paintBench(g, {
        x: park.x + 26 + hash01(park.x, i, 8) * (park.w - 52),
        y: park.y + park.h / 2 + (i === 0 ? -22 : 22),
        angle: 0,
      });
    }
  }

  /** A car park: asphalt, two rows of painted nose-in bays, and a dashed edge. */
  function paintLot(g, lot) {
    g.fillStyle = COLORS.asphaltLight;
    g.fillRect(lot.x, lot.y, lot.w, lot.h);
    g.strokeStyle = 'rgba(232, 227, 210, 0.42)';
    g.lineWidth = 1.6;
    for (let row = 0; row < 2; row += 1) {
      const by = lot.y + 22 + row * 92;
      for (let x = lot.x + 18; x + BAY_W < lot.x + lot.w - 14; x += BAY_W + 5) strokeSegment(g, x, by, x, by + BAY_H);
      g.fillStyle = 'rgba(214, 206, 186, 0.5)';
      for (let x = lot.x + 22; x + 24 < lot.x + lot.w - 16; x += BAY_W + 5) g.fillRect(x, by + 4, 22, 4);
    }
    g.strokeStyle = COLORS.lineWarm;
    g.lineWidth = 2;
    g.setLineDash([12, 10]);
    g.strokeRect(lot.x + 6, lot.y + 6, Math.max(1, lot.w - 12), Math.max(1, lot.h - 12));
    g.setLineDash([]);
    g.fillStyle = 'rgba(232, 227, 210, 0.5)';
    g.font = '700 15px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('P', lot.x + 20, lot.y + 20);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }

  /** The promenade: pale paving with joints, a kerb, and a hedge line on the sand side. */
  function paintPromenade(g) {
    const promenade = city.promenade;
    g.fillStyle = COLORS.courtyard;
    g.fillRect(promenade.x, 0, promenade.w, city.height);
    g.strokeStyle = COLORS.sidewalkLine;
    g.globalAlpha = 0.4;
    g.lineWidth = 1;
    for (let y = 0; y < city.height; y += 24) strokeSegment(g, promenade.x, y, promenade.x + promenade.w, y);
    for (let x = promenade.x + 10; x < promenade.x + promenade.w; x += 10) strokeSegment(g, x, 0, x, city.height);
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255, 255, 255, 0.12)';
    g.fillRect(promenade.x, 0, 3, city.height);
    g.fillStyle = COLORS.grassDark;
    g.fillRect(promenade.x + promenade.w - 6, 0, 6, city.height);
  }

  /** Sand: a warm seaward gradient, the windrows, the damp tide band and the generator's speckles. */
  function paintBeach(g) {
    const beach = city.beach;
    const sandX = beach.x + (city.promenade ? city.promenade.w : 0);
    const sandW = city.shoreline - sandX;
    g.fillStyle = gradientAlong(g, sandX, 0, city.shoreline, 0, [[0, COLORS.sandDark], [0.35, COLORS.sand], [1, COLORS.sandLight]]);
    g.fillRect(sandX, 0, sandW, beach.h);

    for (const spot of city.speckles) {
      g.fillStyle = `rgba(122, 98, 64, ${spot.a})`;
      fillDisc(g, spot.x, spot.y, spot.r);
    }

    // Dry windrows: the lines the wind draws along the sand, drifting with the seed.
    for (let i = 0; i < 3; i += 1) {
      g.strokeStyle = `rgba(150, 122, 84, ${0.11 + i * 0.03})`;
      g.lineWidth = 2;
      g.beginPath();
      for (let y = 0; y <= beach.h; y += 24) {
        const x = city.shoreline - 88 - i * 46 + Math.sin(y * 0.02 + i) * 12;
        if (y === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }

    // Damp sand at the tide line, with a wavering edge rather than a ruled line.
    const wetFrom = city.shoreline - 62;
    g.fillStyle = COLORS.wetSand;
    g.beginPath();
    g.moveTo(wetFrom, 0);
    for (let y = 0; y <= beach.h; y += 16) g.lineTo(wetFrom + Math.sin(y * 0.045) * 4 + Math.sin(y * 0.013) * 7, y);
    g.lineTo(city.shoreline, beach.h);
    g.lineTo(city.shoreline, 0);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.2)';
    g.fillRect(city.shoreline - 70, 0, 14, beach.h);

    // Shell grit, so the sand never reads as one flat fill.
    for (let i = 0; i < 130; i += 1) {
      g.fillStyle = hash01(i, 1.9, 2) > 0.5 ? 'rgba(176, 152, 118, 0.5)' : 'rgba(250, 242, 222, 0.65)';
      fillEllipse(
        g,
        sandX + 22 + hash01(i, 3.3, 3) * Math.max(1, sandW - 38),
        hash01(i, 6.6, 4) * beach.h,
        1.2 + hash01(i, 8.1, 5) * 1.8,
        0.9 + hash01(i, 4.2, 6) * 1.2,
        hash01(i, 5.5, 7) * 3,
      );
    }
  }

  /** The pier deck, clipped to the span `from`..`to` in world x. */
  function paintPier(g, from = city.pier.x, to = city.pier.x + city.pier.w) {
    const pier = city.pier;
    const x0 = Math.max(pier.x, from);
    const x1 = Math.min(pier.x + pier.w, to);
    if (x1 <= x0) return;
    const wet = Math.max(x0, city.shoreline);

    if (x1 > wet) {
      g.fillStyle = 'rgba(8, 34, 46, 0.34)';
      g.fillRect(wet, pier.y + 14, x1 - wet, pier.h + 4);
    }
    g.fillStyle = 'rgba(22, 48, 60, 0.26)';
    fillEllipse(g, x0 + (x1 - x0) / 2, pier.y + pier.h / 2 + 10, (x1 - x0) / 2, pier.h / 2);

    g.fillStyle = '#8f6f4e';
    g.fillRect(x0, pier.y, x1 - x0, pier.h);
    g.strokeStyle = 'rgba(72, 54, 38, 0.4)';
    g.lineWidth = 1;
    for (let x = x0; x < x1; x += 13) strokeSegment(g, x, pier.y, x, pier.y + pier.h);
    g.fillStyle = 'rgba(255, 224, 180, 0.09)';
    for (let y = pier.y + 10; y < pier.y + pier.h - 6; y += 18) g.fillRect(x0, y, x1 - x0, 2);
    g.fillStyle = 'rgba(255, 232, 196, 0.16)';
    g.fillRect(x0, pier.y, x1 - x0, 4);
    g.fillStyle = 'rgba(50, 36, 24, 0.22)';
    g.fillRect(x0, pier.y + pier.h - 4, x1 - x0, 4);

    // Piles with their reflections, but only where the deck hangs out over the water.
    for (let x = wet + 10; x < x1 - 6; x += 34) {
      g.fillStyle = '#3d2f20';
      g.fillRect(x, pier.y + pier.h - 3, 6, 13);
      g.fillRect(x, pier.y - 9, 6, 12);
      g.fillStyle = 'rgba(214, 176, 126, 0.5)';
      g.fillRect(x, pier.y - 9, 2, 12);
      g.fillRect(x, pier.y + pier.h - 3, 2, 13);
      g.fillStyle = 'rgba(6, 28, 38, 0.4)';
      g.fillRect(x - 1, pier.y + pier.h + 9, 8, 4);
      g.fillRect(x - 1, pier.y - 13, 8, 4);
    }

    g.strokeStyle = '#6d553b';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x0, pier.y + 4);
    g.lineTo(x1, pier.y + 4);
    g.moveTo(x0, pier.y + pier.h - 4);
    g.lineTo(x1, pier.y + pier.h - 4);
    g.stroke();

    for (const prop of city.pierProps) {
      if (prop.x < x0 || prop.x > x1) continue;
      g.fillStyle = 'rgba(50, 38, 26, 0.3)';
      fillDisc(g, prop.x + 2, prop.y + 2, 3);
      g.fillStyle = '#5c452e';
      g.fillRect(prop.x - 1.5, prop.y - 5, 3, 10);
      g.fillStyle = '#f2d79d';
      fillDisc(g, prop.x, prop.y, 2.2);
    }

    // A lamp at the seaward end, so the pier has somewhere to lead.
    const endX = pier.x + pier.w - 22;
    if (endX >= x0 && endX <= x1) {
      g.fillStyle = '#6a6f74';
      fillDisc(g, endX, pier.y + pier.h / 2, 4);
      g.fillStyle = '#f7e0a8';
      fillDisc(g, endX, pier.y + pier.h / 2, 2.2);
    }
  }

  // --- the bake -------------------------------------------------------------------------------

  function bake() {
    const w = Math.ceil(city.shoreline + BAKE_MARGIN);
    const h = Math.ceil(city.height);
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const g = layer.getContext('2d');
    litWindows = [];

    // Ground: the city slab only. Everything past the shoreline stays transparent so the live sea
    // shows through — except the pier deck, which is laid over the water further down.
    g.fillStyle = '#4c5246';
    g.fillRect(0, 0, city.shoreline, h);
    g.fillStyle = COLORS.asphalt;
    g.fillRect(0, 0, city.width, h);
    g.fillStyle = COLORS.asphaltDark;
    g.fillRect(city.width, 0, Math.max(0, city.shoreline - city.width), h);

    // Asphalt grain: broad, very faint blooms so no wide road reads as flat paint.
    for (let i = 0; i < 320; i += 1) {
      g.fillStyle = hash01(i, 1.1, 1) > 0.45 ? `rgba(0, 0, 0, ${0.02 + hash01(i, 2.2, 2) * 0.03})` : `rgba(255, 255, 255, ${0.008 + hash01(i, 3.3, 3) * 0.016})`;
      fillEllipse(
        g,
        hash01(i, 4.4, 4) * city.width,
        hash01(i, 5.5, 5) * h,
        40 + hash01(i, 6.6, 6) * 120,
        25 + hash01(i, 7.7, 7) * 70,
        hash01(i, 8.8, 8) * TAU,
      );
    }

    // Tyre-polished bands either side of the centre line on every street.
    g.fillStyle = 'rgba(255, 255, 255, 0.02)';
    for (const y of city.hy) {
      g.fillRect(0, y - 31, city.width, 8);
      g.fillRect(0, y + 23, city.width, 8);
    }
    for (const x of city.vx) {
      g.fillRect(x - 31, 0, 8, city.height);
      g.fillRect(x + 23, 0, 8, city.height);
    }

    // Manholes and patch repairs scattered along the grid.
    for (let i = 0; i < 44; i += 1) {
      const mx = 40 + hash01(i, 1.3, 1) * (city.width - 80);
      const my = 40 + hash01(i, 2.4, 2) * (city.height - 80);
      g.fillStyle = 'rgba(24, 27, 32, 0.5)';
      fillDisc(g, mx, my, 6.5);
      g.strokeStyle = 'rgba(140, 146, 152, 0.24)';
      g.lineWidth = 1.4;
      strokeRing(g, mx, my, 6.5);
    }

    // Blocks: kerb, paving ring with joints, then the courtyard the buildings sit inside.
    for (const block of city.blocks) {
      g.fillStyle = (block.c + block.r) % 2 === 0 ? COLORS.sidewalk : COLORS.sidewalkAlt;
      g.fillRect(block.x, block.y, block.w, block.h);

      g.save();
      g.beginPath();
      g.rect(block.x, block.y, block.w, block.h);
      g.clip();
      g.strokeStyle = 'rgba(140, 132, 118, 0.22)';
      g.lineWidth = 1;
      for (let x = block.x; x <= block.x + block.w; x += 26) strokeSegment(g, x, block.y, x, block.y + block.h);
      for (let y = block.y; y <= block.y + block.h; y += 26) strokeSegment(g, block.x, y, block.x + block.w, y);
      g.restore();

      const inset = city.sidewalk;
      g.fillStyle = COLORS.courtyard;
      g.fillRect(block.x + inset, block.y + inset, block.w - inset * 2, block.h - inset * 2);
      g.strokeStyle = 'rgba(150, 142, 124, 0.4)';
      g.lineWidth = 1.4;
      g.strokeRect(block.x + inset, block.y + inset, block.w - inset * 2, block.h - inset * 2);
      g.strokeStyle = 'rgba(24, 26, 30, 0.26)';
      g.lineWidth = 3;
      g.strokeRect(block.x + 1.5, block.y + 1.5, block.w - 3, block.h - 3);
      g.strokeStyle = COLORS.curb;
      g.lineWidth = 1.6;
      g.strokeRect(block.x + 3, block.y + 3, block.w - 6, block.h - 6);

      // Now and then, a pallet of crates left out in the courtyard.
      if (hash01(block.x + block.y, 9.1, 1) > 0.7) {
        const px = block.x + 22 + hash01(block.x, block.y, 2) * Math.max(1, block.w - 60);
        const py = block.y + 22 + hash01(block.y, block.x, 3) * Math.max(1, block.h - 60);
        g.fillStyle = 'rgba(30, 34, 38, 0.18)';
        g.fillRect(px + 2, py + 3, 14, 10);
        g.fillStyle = '#7d6a52';
        g.fillRect(px, py, 14, 10);
        g.fillStyle = '#9c8768';
        g.fillRect(px, py, 14, 3);
      }
    }

    for (let i = 0; i < city.parks.length; i += 1) paintPark(g, city.parks[i], i);
    for (const lot of city.lots) paintLot(g, lot);
    city.buildings.forEach((building, i) => paintBuilding(g, building, city.seed + i * 7919));

    paintStreetLines(g);
    for (const y of city.hy) for (const x of city.vx) paintCrosswalk(g, x, y);
    for (const y of city.hy) for (const x of city.vx) paintJunctionWear(g, x, y);

    if (city.promenade) paintPromenade(g);
    if (city.beach) paintBeach(g);
    // Only the landward stretch of the pier is baked. The rest stands over live, moving water and is
    // painted during the frame pass, so the surf keeps rolling underneath it.
    if (city.pier) paintPier(g, city.pier.x, city.shoreline + 2);

    for (const lamp of city.lamps) paintLamp(g, lamp);
    for (const tree of city.trees) paintTree(g, tree, 1);
    for (const bench of city.benches) paintBench(g, bench);
    for (const umbrella of city.umbrellas) paintUmbrella(g, umbrella);

    // The night-light companion: only the panes that glow, plus a warm spill under shop fronts.
    const lights = document.createElement('canvas');
    lights.width = w;
    lights.height = h;
    const lg = lights.getContext('2d');
    for (const pane of litWindows) {
      lg.fillStyle = 'rgba(255, 208, 132, 0.55)';
      lg.fillRect(pane.x, pane.y, pane.w, pane.h);
    }
    for (const building of city.buildings) {
      if (!building.awning) continue;
      lg.fillStyle = 'rgba(255, 202, 128, 0.16)';
      lg.fillRect(building.x - 6, building.y + building.h - 2, building.w + 12, 16);
    }

    baked = { layer, lights, w, h };
    bakeDirty = false;
  }

  // --- the sea --------------------------------------------------------------------------------

  /** Deep water: a depth gradient, a darker far band, and long swell lines drifting east. */
  function paintSea(time) {
    const b = bounds(240);
    const shore = city.shoreline;
    const x0 = Math.max(shore - 60, b.x0);
    const x1 = Math.max(b.x1, shore + 60);

    ctx.fillStyle = gradientAlong(ctx, shore, 0, shore + 520, 0, [
      [0, '#8fd6d4'],
      [0.1, COLORS.waterShallow],
      [0.34, COLORS.waterMid],
      [1, COLORS.waterDeep],
    ]);
    ctx.fillRect(x0, b.y0, x1 - x0, b.y1 - b.y0);

    ctx.fillStyle = gradientAlong(ctx, shore + 620, 0, shore + 1400, 0, [[0, 'rgba(6, 40, 60, 0)'], [1, 'rgba(6, 40, 60, 0.42)']]);
    const farX = Math.max(b.x0, shore + 620);
    if (x1 > farX) ctx.fillRect(farX, b.y0, x1 - farX, b.y1 - b.y0);

    // Swell rows: continuous, gently wavering, carrying the eye out to sea.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 2;
    const step = 46;
    for (let y = Math.floor(b.y0 / step) * step - step; y < b.y1 + step; y += step) {
      const phase = time * 0.5 + y * 0.02;
      ctx.beginPath();
      for (let x = x0 + 20; x < x1; x += 26) {
        const wy = y + Math.sin(x * 0.012 + phase) * 4.5;
        if (x === x0 + 20) ctx.moveTo(x, wy);
        else ctx.lineTo(x, wy);
      }
      ctx.stroke();
    }

    // Crests: brighter, shorter caps further out.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let y = Math.floor(b.y0 / 96) * 96 + 24; y < b.y1; y += 96) {
      for (let x = x0 + 60; x < x1; x += 152) {
        const sx = x + Math.sin(time * 0.8 + y * 0.03 + x * 0.01) * 24;
        ctx.beginPath();
        ctx.moveTo(sx, y);
        ctx.quadraticCurveTo(sx + 18, y - 5, sx + 36, y);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }

  /** Surf on the sand: scallops that breathe, a hard foam line, and a shallow veil. */
  function paintSurf(time) {
    const b = bounds(120);
    const shore = city.shoreline;
    if (b.x1 < shore - 120) return;

    const step = 22;
    for (let y = Math.floor(b.y0 / step) * step - step; y < b.y1 + step; y += step) {
      const phase = y * 0.062 + time * 1.5;
      const depth = 8 + Math.sin(phase) * 5 + Math.sin(y * 0.021 + time * 0.6) * 3.5;
      const drift = Math.sin(phase * 0.8) * 3.5;
      const wide = 5 + 4 * Math.abs(Math.sin(y * 0.017 + 1.3));
      ctx.fillStyle = `rgba(246, 255, 253, ${0.32 + 0.16 * Math.abs(Math.sin(phase))})`;
      fillEllipse(ctx, shore + 3 + drift, y + step / 2, Math.max(3, depth + wide), step * 0.62, 0);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
      fillEllipse(ctx, shore + 7 + drift, y + step / 2, Math.max(2, depth * 0.7), step * 0.3, 0);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillRect(shore - 4, b.y0, 6, b.y1 - b.y0);
    ctx.fillStyle = gradientAlong(ctx, shore - 4, 0, shore + 74, 0, [[0, 'rgba(255, 255, 255, 0.28)'], [1, 'rgba(255, 255, 255, 0)']]);
    ctx.fillRect(shore - 4, b.y0, 78, b.y1 - b.y0);

    // Long residual foam lines left behind by earlier waves.
    ctx.lineCap = 'round';
    for (let row = 0; row < 4; row += 1) {
      const alpha = 0.26 - row * 0.055;
      if (alpha <= 0.02) continue;
      ctx.strokeStyle = `rgba(240, 253, 252, ${alpha})`;
      ctx.lineWidth = 2.4 - row * 0.3;
      const spacing = 82 + row * 26;
      for (let y = Math.floor(b.y0 / spacing) * spacing; y < b.y1; y += spacing) {
        const fromX = shore + 44 + row * 96 + ((y * 7 + row * 31) % 130) + Math.sin(y * 0.043 + time * 0.7 + row) * 10;
        const len = 74 + row * 26;
        ctx.beginPath();
        ctx.moveTo(fromX, y);
        ctx.quadraticCurveTo(fromX + len * 0.45, y - 7 - row, fromX + len, y + 1);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';

    // Sun glints on the shallows.
    ctx.fillStyle = 'rgba(255, 252, 232, 0.4)';
    for (let i = 0; i < 46; i += 1) {
      const gx = shore + 90 + ((i * 173) % 640) + Math.sin(time * 0.9 + i) * 6;
      if (gx > b.x1 - 20 || gx < b.x0) continue;
      ctx.globalAlpha = 0.1 + 0.16 * Math.abs(Math.sin(time * 2.1 + i * 1.7));
      ctx.fillRect(gx, b.y0 + ((i * 271) % Math.max(1, b.y1 - b.y0)), 9 + (i % 5) * 3, 1.6);
    }
    ctx.globalAlpha = 1;
  }

  // --- vehicles and people --------------------------------------------------------------------

  /** A car from above: shadow, wheels, paint, glass, lamps, and a police light bar after dark. */
  function paintCar(car, time, night) {
    if (!car || !Number.isFinite(car.x) || !Number.isFinite(car.y)) return;
    const len = car.length ?? VEHICLE.length;
    const wid = car.width ?? VEHICLE.width;
    const angle = car.angle ?? 0;
    const police = car.kind === 'police' || car.kind === 'cop';
    const lit = night > 0.32;

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(angle);

    ctx.fillStyle = 'rgba(16, 20, 26, 0.26)';
    roundRect(ctx, -len / 2 + 3, -wid / 2 + 4, len, wid, 7);
    ctx.fill();

    if (lit) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gradientAlong(ctx, len / 2, 0, len / 2 + 165, 0, [
        [0, `rgba(255, 238, 186, ${0.3 * night})`],
        [0.5, `rgba(255, 228, 160, ${0.1 * night})`],
        [1, 'rgba(255, 220, 150, 0)'],
      ]);
      fillPoly(ctx, [len / 2 - 2, -wid * 0.34, len / 2 - 2, wid * 0.34, len / 2 + 165, wid * 1.5, len / 2 + 165, -wid * 1.5]);
      ctx.restore();
    }

    ctx.fillStyle = '#1d2229';
    for (const wx of [-len * 0.31, len * 0.31]) {
      roundRect(ctx, wx - 4.75, -wid / 2 - 1.2, 9.5, 5, 1.8);
      ctx.fill();
      roundRect(ctx, wx - 4.75, wid / 2 - 6.2, 9.5, 5, 1.8);
      ctx.fill();
    }

    ctx.fillStyle = police ? '#eef1f4' : car.color ?? CAR_COLORS[0];
    roundRect(ctx, -len / 2, -wid / 2, len, wid, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(18, 22, 28, 0.34)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // A lengthways sheen: lit along the near flank, falling into shade at the far one.
    ctx.fillStyle = gradientAlong(ctx, 0, -wid / 2, 0, wid / 2, [
      [0, 'rgba(255, 255, 255, 0.2)'],
      [0.42, 'rgba(255, 255, 255, 0.02)'],
      [1, 'rgba(0, 0, 0, 0.16)'],
    ]);
    roundRect(ctx, -len / 2, -wid / 2, len, wid, 6);
    ctx.fill();

    // Glass: windscreen forward, rear screen back, roof panel between them.
    ctx.fillStyle = 'rgba(24, 34, 44, 0.64)';
    roundRect(ctx, len * 0.06, -wid / 2 + 3.5, len * 0.17, wid - 7, 2.6);
    ctx.fill();
    roundRect(ctx, -len * 0.35, -wid / 2 + 4, len * 0.14, wid - 8, 2.6);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    roundRect(ctx, -len * 0.2, -wid / 2 + 4.5, len * 0.26, wid - 9, 2);
    ctx.fill();

    if (police) {
      ctx.fillStyle = 'rgba(32, 60, 120, 0.8)';
      ctx.fillRect(-len * 0.3, -wid / 2 + 4, len * 0.32, 2.2);
      const flash = Math.sin(time * 13) > 0;
      ctx.fillStyle = flash ? 'rgba(255, 86, 74, 0.95)' : 'rgba(96, 150, 255, 0.95)';
      ctx.fillRect(-len * 0.1, -wid / 2 + 7, len * 0.085, 3.4);
      ctx.fillStyle = flash ? 'rgba(96, 150, 255, 0.95)' : 'rgba(255, 86, 74, 0.95)';
      ctx.fillRect(-len * 0.01, -wid / 2 + 7, len * 0.085, 3.4);
    }

    ctx.fillStyle = lit ? '#fff6ce' : '#fff2c4';
    ctx.fillRect(len / 2 - 7, -wid / 2 + 3.5, 4.5, 3);
    ctx.fillRect(len / 2 - 7, wid / 2 - 6.5, 4.5, 3);
    const braking = (car.occupied && Math.abs(car.speed ?? 0) < 26) || car.handbrake;
    ctx.fillStyle = braking ? '#ff6a58' : '#d9503f';
    ctx.fillRect(-len / 2 + 2.5, -wid / 2 + 3.5, 4.5, 3);
    ctx.fillRect(-len / 2 + 2.5, wid / 2 - 6.5, 4.5, 3);

    if (car.occupied) {
      ctx.fillStyle = 'rgba(20, 24, 30, 0.55)';
      fillDisc(ctx, len * 0.02, 0, 3.6);
    }
    ctx.restore();
  }

  /** A pedestrian: shirt, head, a small bob, and — knocked down — a crumpled pose. */
  function paintPed(p, time) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const s = p.scale ?? 1;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.22)';
    fillEllipse(ctx, 1.6, 3, 6.8 * s, 5 * s);
    ctx.rotate((p.facing ?? 0) + Math.PI / 2);

    const down = p.down === true || (p.down ?? 0) > 0;
    if (down) {
      ctx.fillStyle = p.shirt ?? '#e8604c';
      roundRect(ctx, -9 * s, -4 * s, 18 * s, 8 * s, 3.4 * s);
      ctx.fill();
      ctx.fillStyle = p.skin ?? '#e8bc93';
      fillDisc(ctx, 11 * s, 0, 3.4 * s);
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
    roundRect(ctx, -4.2 * s, -1 + swing * 0.5, 3 * s, 7.4 * s, 1.4 * s);
    ctx.fill();
    roundRect(ctx, 1.2 * s, -1 - swing * 0.5, 3 * s, 7.4 * s, 1.4 * s);
    ctx.fill();

    ctx.fillStyle = p.shirt ?? '#e8604c';
    roundRect(ctx, -5 * s, (-7 + bob * 0.2) * s, 10 * s, 12 * s, 3.4 * s);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    roundRect(ctx, 1.4 * s, (-7 + bob * 0.2) * s, 3.6 * s, 12 * s, 2 * s);
    ctx.fill();

    ctx.fillStyle = p.skin ?? '#e8bc93';
    fillDisc(ctx, 0, -9.4 * s + bob * 0.3, 3.5 * s);
    if (p.hat) {
      ctx.fillStyle = '#3a4250';
      ctx.beginPath();
      ctx.arc(0, -9.6 * s + bob * 0.3, 3.9 * s, Math.PI, TAU);
      ctx.fill();
      ctx.fillRect(-4.2 * s, -10 * s + bob * 0.3, 8.4 * s, 1.4 * s);
    } else {
      ctx.fillStyle = 'rgba(48, 38, 32, 0.7)';
      ctx.beginPath();
      ctx.arc(0, -10.2 * s + bob * 0.3, 3 * s, Math.PI, TAU);
      ctx.fill();
    }

    if (hurt) {
      ctx.fillStyle = `rgba(232, 102, 91, ${0.4 + Math.sin(time * 14) * 0.25})`;
      fillDisc(ctx, 0, -6 * s, 1.8 * s);
    }
    ctx.restore();
  }

  /** An officer: the same figure in navy, with a cap and a badge that catch the light. */
  function paintOfficer(o) {
    if (!o || !Number.isFinite(o.x)) return;
    const s = o.scale ?? 1;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.24)';
    fillEllipse(ctx, 1.6, 3, 7 * s, 5.2 * s);
    ctx.rotate((o.facing ?? 0) + Math.PI / 2);

    const swing = Math.sin((o.walkPhase ?? 0) + o.x * 0.05) * 3;
    ctx.fillStyle = '#1c2331';
    roundRect(ctx, -4.4 * s, -1 + swing * 0.5, 3.2 * s, 7.4 * s, 1.4 * s);
    ctx.fill();
    roundRect(ctx, 1.2 * s, -1 - swing * 0.5, 3.2 * s, 7.4 * s, 1.4 * s);
    ctx.fill();
    ctx.fillStyle = '#2b3a5c';
    roundRect(ctx, -5.2 * s, -7.2 * s, 10.4 * s, 12.4 * s, 3.4 * s);
    ctx.fill();
    ctx.fillStyle = 'rgba(230, 230, 210, 0.5)';
    ctx.fillRect(-5.2 * s, -3.4 * s, 10.4 * s, 1.6 * s);
    ctx.fillStyle = COLORS.gold;
    ctx.fillRect(-1.2 * s, -6.6 * s, 2.4 * s, 2.4 * s);
    ctx.fillStyle = '#e8bc93';
    fillDisc(ctx, 0, -9.4 * s, 3.5 * s);
    ctx.fillStyle = '#1c2331';
    ctx.beginPath();
    ctx.arc(0, -9.8 * s, 4 * s, Math.PI, TAU);
    ctx.fill();
    ctx.fillRect(-4.4 * s, -10.2 * s, 8.8 * s, 1.6 * s);
    ctx.restore();
  }

  /** The player: jacket, cap, and a stride driven by the distance actually walked. */
  function paintPlayer(p) {
    if (!p || !Number.isFinite(p.x)) return;

    const moved = Math.hypot(p.x - walkFrom.x, p.y - walkFrom.y);
    walkPhase += moved * 0.2;
    walkFrom = { x: p.x, y: p.y };

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.26)';
    fillEllipse(ctx, 1.6, 3, 8, 5.8);
    ctx.rotate((p.facing ?? 0) + Math.PI / 2);

    if (p.down === true) {
      ctx.fillStyle = '#2f7f8f';
      roundRect(ctx, -9, -4.4, 18, 8.8, 3.6);
      ctx.fill();
      ctx.fillStyle = '#f4d9b8';
      fillDisc(ctx, 11, 0, 3.8);
      ctx.restore();
      return;
    }

    const stride = Math.sin(walkPhase) * 2.6;

    ctx.fillStyle = '#2f3646';
    roundRect(ctx, -4.6, -1 + stride * 0.4, 3.4, 7.6, 1.6);
    ctx.fill();
    roundRect(ctx, 1.2, -1 - stride * 0.4, 3.4, 7.6, 1.6);
    ctx.fill();

    ctx.fillStyle = '#2f7f8f';
    roundRect(ctx, -5.8, -7.8, 11.6, 13.4, 3.8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    roundRect(ctx, -5.8, -7.8, 3.2, 13.4, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 240, 214, 0.7)';
    roundRect(ctx, -2.4, -7.6, 4.8, 3, 1.4);
    ctx.fill();

    // Arms swing opposite the legs.
    ctx.strokeStyle = '#2f7f8f';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-5.4, -3);
    ctx.lineTo(-6.6, 1.6 - stride * 0.5);
    ctx.moveTo(5.4, -3);
    ctx.lineTo(6.6, 1.6 + stride * 0.5);
    ctx.stroke();
    ctx.lineCap = 'butt';

    ctx.fillStyle = '#f4d9b8';
    fillDisc(ctx, 0, -10.2, 4);
    ctx.fillStyle = '#2b3140';
    ctx.beginPath();
    ctx.arc(0, -10.7, 4.1, Math.PI, TAU);
    ctx.fill();
    ctx.fillRect(-1, -14.4, 2, 1.6);

    if ((p.hurtFlash ?? 0) > 0) {
      ctx.strokeStyle = `rgba(232, 102, 91, ${Math.min(0.55, p.hurtFlash * 1.6)})`;
      ctx.lineWidth = 1.6;
      strokeRing(ctx, 0, -2, 12);
    }
    ctx.restore();
  }

  // --- effects --------------------------------------------------------------------------------

  function spawnSkid(x, y, angle, strength) {
    const mark = skids[skidCursor];
    skidCursor = (skidCursor + 1) % SKID_MAX;
    mark.x1 = x - Math.cos(angle) * 5;
    mark.y1 = y - Math.sin(angle) * 5;
    mark.x2 = x + Math.cos(angle) * 5;
    mark.y2 = y + Math.sin(angle) * 5;
    mark.life = 1;
    mark.max = 1;
    mark.width = 2.6 + strength * 2;
  }

  function spawnDust(x, y, vx, vy, tone = 0) {
    const puff = dust[dustCursor];
    dustCursor = (dustCursor + 1) % DUST_MAX;
    puff.x = x;
    puff.y = y;
    puff.vx = vx * 0.16;
    puff.vy = vy * 0.16;
    puff.life = 0.72;
    puff.max = 0.72;
    puff.size = 3 + hash01(x | 0, y | 0, dustCursor) * 3.4;
    puff.tone = tone;
  }

  /** A muzzle flash or a bright impact: a short-lived star at a point, along an angle. */
  function spawnFlash(x, y, angle) {
    const flash = flashes[flashCursor];
    flashCursor = (flashCursor + 1) % FLASH_MAX;
    flash.x = x;
    flash.y = y;
    flash.angle = angle;
    flash.life = 0.16;
  }

  /** Watch the driven car and the wanted level, and leave behind the marks they would leave. */
  function advanceEffects(dt, world) {
    for (const mark of skids) if (mark.life > 0) mark.life = Math.max(0, mark.life - dt / 4.4);
    for (const puff of dust) {
      if (puff.life <= 0) continue;
      puff.life = Math.max(0, puff.life - dt);
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      puff.vx *= 1 - 2.4 * dt;
      puff.vy *= 1 - 2.4 * dt;
    }
    for (const flash of flashes) if (flash.life > 0) flash.life = Math.max(0, flash.life - dt);

    const car = world.player?.car;
    const wanted = world.wanted ?? 0;

    if (car && Number.isFinite(car.x)) {
      const speed = Math.abs(car.speed ?? 0);
      const angle = car.angle ?? 0;
      const onSand = city.beach ? car.x > city.beach.x + 10 && car.x < city.shoreline - 8 : false;

      // Everything about how the car is being driven is inferred from the previous frame, so the
      // simulation never has to hand the renderer any extra fields.
      const seen = prevCar && prevCar.car === car ? prevCar : null;
      const drift = seen ? Math.abs(angle - seen.angle) : 0;
      const decel = seen ? seen.speed - speed : 0;
      const sliding = (world.player.handbrake && speed > 40) || (drift > 0.035 && speed > 150) || (decel > 70 && speed > 120);

      if (sliding) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rx = car.x - cos * (car.length ?? VEHICLE.length) * 0.36;
        const ry = car.y - sin * (car.length ?? VEHICLE.length) * 0.36;
        spawnSkid(rx - sin * 7.5, ry + cos * 7.5, angle, 1);
        spawnSkid(rx + sin * 7.5, ry - cos * 7.5, angle, 1);
        spawnDust(rx, ry, -cos * 40, -sin * 40, 1);
        if (speed > 150) spawnDust(rx, ry, -cos * 60, -sin * 60, 1);
      }

      // Sand kicked up when a car crosses the beach.
      if (onSand && speed > 70 && hash01(car.x | 0, car.y | 0, (dt * 1000) | 0) < 0.45) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        spawnDust(car.x - cos * 24, car.y - sin * 24, -cos * 50, -sin * 50, 2);
      }

      // A hard shunt: sparks at the nose, and the camera takes the knock.
      if (seen && decel > 90 && seen.speed > 140) {
        const nose = (car.length ?? VEHICLE.length) * 0.5;
        const nx = car.x + Math.cos(angle) * nose;
        const ny = car.y + Math.sin(angle) * nose;
        spawnFlash(nx, ny, angle);
        for (let i = 0; i < 6; i += 1) {
          spawnDust(nx, ny, (hash01(i, nx | 0, 1) - 0.5) * 220, (hash01(i, ny | 0, 2) - 0.5) * 220, 1);
        }
        camera.shake = Math.min(3.2, camera.shake + 0.35);
      }

      prevCar = { car, x: car.x, y: car.y, angle, speed };
    } else {
      prevCar = null;
    }

    // Heat going up: a shot fired somewhere near the heat.
    if (wanted > prevWanted) {
      const police = Array.isArray(world.police?.cars) ? world.police.cars.map((u) => u?.car ?? u).filter(Boolean) : [];
      const shooter = police[0] ?? car;
      if (shooter && Number.isFinite(shooter.x)) {
        spawnFlash(shooter.x + Math.cos(shooter.angle ?? 0) * 26, shooter.y + Math.sin(shooter.angle ?? 0) * 26, shooter.angle ?? 0);
      }
    }
    prevWanted = wanted;
  }

  function paintSkids() {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#22262c';
    for (const mark of skids) {
      if (mark.life <= 0) continue;
      ctx.globalAlpha = Math.min(0.34, mark.life * mark.life * 0.4);
      ctx.lineWidth = mark.width ?? 3.6;
      strokeSegment(ctx, mark.x1, mark.y1, mark.x2, mark.y2);
    }
    ctx.restore();
  }

  function paintDust() {
    for (const puff of dust) {
      if (puff.life <= 0) continue;
      const t = puff.life / puff.max;
      ctx.globalAlpha = t * 0.34;
      ctx.fillStyle = puff.tone === 2 ? '#e6d2a8' : '#d8cbb2';
      fillDisc(ctx, puff.x, puff.y, puff.size * (2 - t));
    }
    ctx.globalAlpha = 1;
  }

  function paintFlashes() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const flash of flashes) {
      if (flash.life <= 0) continue;
      const t = clamp(flash.life / 0.16, 0, 1);
      ctx.save();
      ctx.translate(flash.x, flash.y);
      ctx.rotate(flash.angle);
      ctx.strokeStyle = `rgba(255, 226, 150, ${t})`;
      ctx.lineWidth = 1.8;
      const r = 4 + (1 - t) * 12;
      ctx.beginPath();
      for (let k = 0; k < 4; k += 1) {
        const a = (k / 4) * TAU;
        ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 246, 208, ${t * 0.7})`;
      fillDisc(ctx, Math.cos(flash.angle) * 6, Math.sin(flash.angle) * 6, 3 + t * 3);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Bullets, impact particles, sparks, muzzle glow, a thrown punch and dropped pickups. */
  function paintCombat(combat, player, time) {
    if (!combat) return;

    for (const shot of combat.bullets ?? []) {
      if (!Number.isFinite(shot.x)) continue;
      const life = clamp(shot.life ?? 0.1, 0, 1);
      ctx.strokeStyle = shot.hostile
        ? `rgba(255, 170, 120, ${0.85 * Math.min(1, life * 2)})`
        : `rgba(255, 236, 176, ${0.9 * Math.min(1, life * 2)})`;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      strokeSegment(ctx, shot.px ?? shot.x, shot.py ?? shot.y, shot.x, shot.y);
    }
    ctx.lineCap = 'butt';

    for (const part of combat.particles ?? []) {
      const t = clamp((part.life ?? 0) / (part.max ?? 1), 0, 1);
      if (t <= 0) continue;
      ctx.globalAlpha = t * 0.8;
      ctx.fillStyle = part.colour ?? '#f6e2ae';
      fillDisc(ctx, part.x, part.y, Math.max(0.5, (part.r ?? 2) * (0.5 + t)));
    }
    ctx.globalAlpha = 1;

    for (const spark of combat.sparks ?? []) {
      const t = clamp((spark.life ?? 0) / (spark.max ?? 1), 0, 1);
      if (t <= 0) continue;
      ctx.save();
      ctx.translate(spark.x, spark.y);
      ctx.rotate(t * 2.4);
      ctx.globalAlpha = t;
      ctx.strokeStyle = spark.kind === 'gun' ? '#ffd9a0' : '#fff3c9';
      ctx.lineWidth = 1.8;
      const r = 3 + (1 - t) * 9;
      ctx.beginPath();
      for (let k = 0; k < 4; k += 1) {
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
      ctx.fillStyle = gradientAround(ctx, 0, 0, 1, 26, [[0, 'rgba(255, 246, 208, 0.85)'], [1, 'rgba(255, 210, 120, 0)']]);
      fillDisc(ctx, 0, 0, 26);
      ctx.restore();
    }

    if (combat.fists && player && !player.car) {
      ctx.save();
      ctx.translate(player.x, player.y);
      ctx.rotate((player.facing ?? 0) + Math.PI / 2);
      ctx.fillStyle = '#f4d9b8';
      roundRect(ctx, -2, -20, 4, 13, 2);
      ctx.fill();
      ctx.restore();
    }

    // A dropped pistol, bobbing on a halo so a small dark object still reads on asphalt.
    for (const item of combat.pickups ?? []) {
      if (!item || item.taken) continue;
      ctx.save();
      ctx.translate(item.x, item.y + Math.sin(time * 2.6 + (item.bob ?? 0)) * 1.6);
      ctx.fillStyle = 'rgba(16, 20, 26, 0.3)';
      fillEllipse(ctx, 2, 6, 9, 3.4);
      ctx.fillStyle = gradientAround(ctx, 0, 0, 1, 22, [[0, 'rgba(242, 199, 92, 0.26)'], [1, 'rgba(242, 199, 92, 0)']]);
      fillDisc(ctx, 0, 0, 22);
      ctx.rotate(0.42);
      ctx.fillStyle = '#3b4148';
      roundRect(ctx, -8, -3, 16, 5, 1.6);
      ctx.fill();
      ctx.fillStyle = '#5a6068';
      roundRect(ctx, -3, 1, 5, 7, 1.4);
      ctx.fill();
      ctx.restore();
    }
  }

  /** The objective: a gold pin inside a breathing ring, with its beam and its label chip. */
  function paintMarker(marker) {
    if (!marker || !Number.isFinite(marker.x)) return;
    const bob = Math.sin(clockTime * 2.4) * 2.6;
    const pulse = (clockTime * 0.9) % 1;

    ctx.save();
    ctx.translate(marker.x, marker.y);

    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gradientAround(ctx, 0, 0, 2, 54, [[0, 'rgba(242, 199, 92, 0.3)'], [1, 'rgba(242, 199, 92, 0)']]);
    fillDisc(ctx, 0, 0, 54);
    ctx.fillStyle = gradientAlong(ctx, 0, 0, 0, -110, [[0, 'rgba(242, 199, 92, 0.22)'], [1, 'rgba(242, 199, 92, 0)']]);
    fillPoly(ctx, [-8, 0, 8, 0, 3, -110, -3, -110]);
    ctx.globalCompositeOperation = 'source-over';

    ctx.strokeStyle = 'rgba(242, 199, 92, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 20, 12, 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(242, 199, 92, ${0.5 * (1 - pulse)})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, 20 + pulse * 26, 12 + pulse * 16, 0, 0, TAU);
    ctx.stroke();

    const pinY = -24 + bob;
    ctx.fillStyle = 'rgba(242, 199, 92, 0.96)';
    fillPoly(ctx, [0, pinY + 12, 8.5, pinY - 4, -8.5, pinY - 4]);
    ctx.strokeStyle = 'rgba(52, 40, 16, 0.5)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = '#3a2c10';
    fillDisc(ctx, 0, pinY + 1, 2.4);

    const label = marker.title ?? marker.label;
    if (label) {
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      const value = marker.pay ? `${label} \u00b7 $${marker.pay}` : label;
      const width = Math.min(240, ctx.measureText(value).width + 18);
      ctx.fillStyle = 'rgba(12, 18, 24, 0.9)';
      roundRect(ctx, -width / 2, pinY - 30, width, 18, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(242, 199, 92, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f7f1e2';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value, 0, pinY - 20.5, width - 10);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  // --- night and grade ------------------------------------------------------------------------

  /** After dark: lit panes, warm pools under the lamps, headlight wash, and a cool cast overall. */
  function paintNight(night, cars) {
    if (night <= 0.01) return;
    const b = bounds(0);

    if (baked) {
      const sx = Math.max(0, Math.floor(b.x0));
      const sy = Math.max(0, Math.floor(b.y0));
      const sw = Math.min(baked.w, Math.ceil(b.x1)) - sx;
      const sh = Math.min(baked.h, Math.ceil(b.y1)) - sy;
      if (sw > 0 && sh > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = night * 0.85;
        ctx.drawImage(baked.lights, sx, sy, sw, sh, sx, sy, sw, sh);
        ctx.restore();
      }
    }

    ctx.fillStyle = `rgba(10, 20, 44, ${night * 0.6})`;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);

    if (night > 0.15) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const lamp of city.lamps) {
        if (lamp.x < b.x0 - 100 || lamp.x > b.x1 + 100 || lamp.y < b.y0 - 100 || lamp.y > b.y1 + 100) continue;
        ctx.fillStyle = gradientAround(ctx, lamp.x, lamp.y, 2, 96, [
          [0, `rgba(255, 214, 138, ${0.3 * night})`],
          [0.55, `rgba(255, 196, 112, ${0.11 * night})`],
          [1, 'rgba(255, 180, 90, 0)'],
        ]);
        fillDisc(ctx, lamp.x, lamp.y, 96);
      }
      for (const car of cars) {
        if (!car || car.x < b.x0 - 90 || car.x > b.x1 + 90 || car.y < b.y0 - 90 || car.y > b.y1 + 90) continue;
        const hx = car.x + Math.cos(car.angle ?? 0) * (car.length ?? VEHICLE.length) * 0.55;
        const hy = car.y + Math.sin(car.angle ?? 0) * (car.length ?? VEHICLE.length) * 0.55;
        ctx.fillStyle = gradientAround(ctx, hx, hy, 4, 128, [[0, `rgba(255, 236, 180, ${0.2 * night})`], [1, 'rgba(255, 226, 160, 0)']]);
        fillDisc(ctx, hx, hy, 128);
      }
      ctx.restore();
    }
  }

  /** Screen-space finish: a warm haze at noon, then a soft vignette to give the frame a centre. */
  function paintGrade(night) {
    ctx.save();
    const warm = 0.05 * (1 - night);
    if (warm > 0.002) {
      ctx.fillStyle = `rgba(255, 198, 126, ${warm})`;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    const key = `${view.width}x${view.height}`;
    if (!vignette || vignetteKey !== key) {
      vignette = gradientAround(ctx, view.width / 2, view.height * 0.48, Math.min(view.width, view.height) * 0.35, Math.max(view.width, view.height) * 0.72, [
        [0, 'rgba(8, 14, 20, 0)'],
        [1, 'rgba(8, 14, 20, 0.4)'],
      ]);
      vignetteKey = key;
    }
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();
  }

  // --- camera ---------------------------------------------------------------------------------

  /** Trail the target, lean along its heading, and open the view up a little while driving. */
  function steerCamera(dt, target, driving) {
    if (target) {
      const speed = driving ? Math.abs(target.speed ?? 0) : Math.hypot(target.vx ?? 0, target.vy ?? 0);
      const heading = driving ? target.angle ?? 0 : target.facing ?? 0;
      const ahead = clamp(speed * 0.34, 0, CAMERA.lookAhead * 2.4);
      camera.x = damp(camera.x, target.x + Math.cos(heading) * ahead, CAMERA.follow, dt);
      camera.y = damp(camera.y, target.y + Math.sin(heading) * ahead, CAMERA.follow, dt);
      camera.zoom = damp(
        camera.zoom,
        (driving ? CAMERA.zoomCar : CAMERA.zoomFoot) - Math.min(0.06, (speed / 325) * 0.06),
        CAMERA.zoomRate,
        dt,
      );
    }
    camera.shake = Math.max(0, camera.shake - CAMERA.shakeDecay * dt);
    if (!Number.isFinite(camera.x)) camera.x = city.downtown.x;
    if (!Number.isFinite(camera.y)) camera.y = city.downtown.y;
  }

  /** Hold the viewport over the map, still allowing a generous look out to sea in the east. */
  function confineCamera() {
    const hw = view.width / 2 / camera.zoom;
    const hh = view.height / 2 / camera.zoom;
    const minX = Math.min(hw, city.width / 2);
    const minY = Math.min(hh, city.height / 2);
    const maxX = Math.max(city.water.x + city.water.w * 0.22 - hw, minX);
    camera.x = clamp(camera.x, minX, maxX);
    camera.y = clamp(camera.y, minY, Math.max(city.height - hh, minY));
    if (!Number.isFinite(camera.x)) camera.x = city.downtown.x;
    if (!Number.isFinite(camera.y)) camera.y = city.downtown.y;
  }

  // --- frames ---------------------------------------------------------------------------------

  /** Put the context into world space under the camera, shake and all. */
  function openWorld() {
    const shake = camera.shake;
    camera.ox = shake > 0.001 ? (hash01(camera.x * 13 + clockTime * 60, camera.y, 1) - 0.5) * shake * 10 : 0;
    camera.oy = shake > 0.001 ? (hash01(camera.y * 13 + clockTime * 60, camera.x, 2) - 0.5) * shake * 10 : 0;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.save();
    ctx.translate(view.width / 2 + camera.ox, view.height / 2 + camera.oy);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
  }

  /** The baked layer, blitted only where the camera can see it. */
  function blitStatic() {
    if (!baked) return;
    const b = bounds(60);
    const sx = Math.max(0, Math.floor(b.x0));
    const sy = Math.max(0, Math.floor(b.y0));
    const sw = Math.min(baked.w, Math.ceil(b.x1)) - sx;
    const sh = Math.min(baked.h, Math.ceil(b.y1)) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(baked.layer, sx, sy, sw, sh, sx, sy, sw, sh);
  }

  /** Every car on the street except the one the player is in, culled to the view. */
  function paintCars(world, night, b) {
    const skip = world.player?.car;
    const one = (car) => {
      if (!car || car === skip || !Number.isFinite(car.x)) return;
      if (car.x < b.x0 || car.x > b.x1 || car.y < b.y0 || car.y > b.y1) return;
      paintCar(car, clockTime, night);
    };
    for (const car of world.parked ?? []) one(car);
    for (const car of world.traffic?.list ?? []) one(car);
    for (const unit of world.police?.cars ?? []) one(unit?.car ?? unit);
  }

  /** The crowd, plus any officers still on their feet. */
  function paintCrowd(world, b) {
    for (const ped of world.pedestrians?.list ?? []) {
      if (!ped || ped.x < b.x0 || ped.x > b.x1 || ped.y < b.y0 || ped.y > b.y1) continue;
      paintPed(ped, clockTime);
    }
    for (const officer of world.police?.officers ?? []) {
      if (!officer || (officer.hp ?? 1) <= 0) continue;
      if (officer.x < b.x0 || officer.x > b.x1 || officer.y < b.y0 || officer.y > b.y1) continue;
      paintOfficer(officer);
    }
  }

  /** The world pass shared by the play frame and the title drift. */
  function paintScene(world, night, pad) {
    openWorld();
    paintSea(clockTime);
    blitStatic();
    // Surf comes after the ground layers: the foam must wash over the sand's wet edge, not under it.
    paintSurf(clockTime);
    // The seaward half of the pier is painted live, standing in the moving surf.
    if (city.pier) paintPier(ctx, city.shoreline, city.pier.x + city.pier.w);
    paintSkids();
    const b = bounds(pad);
    paintCars(world, night, b);
    paintCrowd(world, b);
    return b;
  }

  /** Screen-space arrow pointing at an objective that has gone off the edge of the view. */
  function paintMarkerArrow(marker) {
    if (!marker || !Number.isFinite(marker.x) || !Number.isFinite(marker.y)) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const sx = (marker.x - camera.x) * camera.zoom + view.width / 2;
    const sy = (marker.y - camera.y) * camera.zoom + view.height / 2;
    const pad = 74;
    if (sx > pad && sx < view.width - pad && sy > pad && sy < view.height - pad) return;

    const cx = view.width / 2;
    const cy = view.height / 2;
    const angle = Math.atan2(sy - cy, sx - cx);
    const radius = Math.min(view.width, view.height) / 2 - 46;
    const pulse = 0.6 + 0.4 * Math.sin(clockTime * 3);

    ctx.save();
    ctx.translate(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(242, 199, 92, ${0.55 + pulse * 0.35})`;
    fillPoly(ctx, [12, 0, -7, 8, -3, 0, -7, -8]);
    ctx.strokeStyle = 'rgba(42, 32, 10, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Paint one frame. `world` holds the cast; `opts` carries the clock, how dark it is, whether the
   * player is driving, what the camera should chase, and the objective to pin on the map.
   */
  function draw(world, opts) {
    if (bakeDirty || !baked) bake();
    settleSize();
    const { time = 0, night = 0, target = world.player, driving = !!world.player?.car, marker = null, dt = 1 / 60 } = opts ?? {};
    clockTime = time;
    world.time = time;

    steerCamera(dt, target, driving);
    confineCamera();
    advanceEffects(dt, world);

    paintScene(world, night, 90);

    const car = world.player?.car;
    if (car) paintCar(car, time, night);
    else if (world.player) paintPlayer(world.player);

    paintDust();
    paintFlashes();
    paintCombat(world.combat, world.player, time);
    paintMarker(marker);

    const allCars = (world.parked ?? []).concat(world.traffic?.list ?? []);
    for (const unit of world.police?.cars ?? []) allCars.push(unit?.car ?? unit);
    if (car) allCars.push(car);
    paintNight(night, allCars);

    ctx.restore();
    paintGrade(night);
    paintMarkerArrow(marker);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }

  /**
   * The aerial view behind the title screen: a slow drift over downtown, wide enough to read as a
   * city rather than a street, while the traffic and the crowd keep moving underneath it.
   */
  function drawOverview(world, time = 0, night = 0) {
    if (bakeDirty || !baked) bake();
    settleSize();
    clockTime = time;
    world.time = time;

    const pivotX = city.downtown.x + (city.shoreline - city.downtown.x) * 0.18;
    camera.x = damp(camera.x, pivotX + Math.cos(time * 0.055) * 250, 1.6, 1 / 60);
    camera.y = damp(camera.y, city.downtown.y + Math.sin(time * 0.043) * 170, 1.6, 1 / 60);
    camera.zoom = damp(camera.zoom, 0.5 + Math.sin(time * 0.031) * 0.03, 1.2, 1 / 60);
    camera.shake = 0;
    camera.ox = 0;
    camera.oy = 0;
    confineCamera();

    advanceEffects(1 / 60, world);
    paintScene(world, night, 120);

    // A warm sea haze over the bay; the title card itself sits on top of this.
    ctx.fillStyle = gradientAlong(ctx, view.width * 0.55, 0, view.width, view.height * 0.9, [
      [0, 'rgba(255, 206, 138, 0)'],
      [1, `rgba(255, 206, 138, ${0.1 * (1 - night)})`],
    ]);
    ctx.fillRect(-city.width, -city.height, city.width * 2, city.height * 2);

    ctx.restore();
    paintGrade(night);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }

  /** World to CSS pixels, for anything that needs to sit on a car or a corner. */
  function worldToScreen(x, y) {
    return { x: (x - camera.x) * camera.zoom + view.width / 2, y: (y - camera.y) * camera.zoom + view.height / 2 };
  }

  function screenToWorld(x, y) {
    return { x: (x - view.width / 2) / camera.zoom + camera.x, y: (y - view.height / 2) / camera.zoom + camera.y };
  }

  function nudgeShake(amount) {
    camera.shake = clamp(camera.shake + Math.abs(Number(amount) || 0), 0, 3.2);
  }

  return {
    draw,
    drawOverview,
    resize: measure,
    nudgeShake,
    camera,
    view,
    worldToScreen,
    screenToWorld,
    rebake() {
      bakeDirty = true;
    },
  };
}
