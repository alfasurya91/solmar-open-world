/*
 * Pedestrian crowd — Solmar's sidewalk population.
 *
 * Layout of this file:
 *   1. tuning (legacy timers, crossings, panic, spacing)
 *   2. tuning — archetypes, districts, park gathering
 *   2b. tuning — gunfire panic and landmark sightseeing
 *   3. public tables (states, gaits, archetypes, zone pace table)
 *   4. pure helpers: loop maths, districts, density, walking routes
 *   5. createPedestrians — build the crowd
 *   6. per-frame behaviour: walk, wait at the kerb, cross, dodge, linger
 *   7. knockAt
 *
 * A walker belongs to one closed walkway loop (one per city block, plus the
 * promenade and the pier), so the crowd stays on pavement. On top of that:
 *
 *   - each walker keeps its own gait (strolling shopper .. jogger), a slow
 *     breathing wave on its pace and the occasional window-shop pause, so
 *     nobody marches in lockstep;
 *   - on top of the gait sits an archetype: locals, workers, shoppers, parcel
 *     couriers doing hurried delivery runs, and tourists who stop to shoot
 *     photos of whatever landmark is closest;
 *   - pacing is scaled per district — the old town ambles, downtown hurries,
 *     the promenade and the pier dawdle — so a street reads differently
 *     depending on where in town you are;
 *   - reaching a block corner with a road on the other side, it may pause at
 *     the kerb like someone checking for traffic, then walk straight across
 *     to the facing pavement and rejoin that block's loop. It will not step
 *     off the kerb into live traffic: the crossing holds while a moving car
 *     is on the zebra line (with a hard cap so nobody waits forever);
 *   - a car bearing down fast — the player's included — makes it sprint
 *     sideways out of the lane; slower fast traffic still spooks and shoves;
 *   - a gunshot nearby (the player's or an officer's) is louder than traffic:
 *     everyone inside the blast radius scatters, running away from the report
 *     for a few seconds before they dare to slow down again;
 *   - tourists with a camera walk errands to the town's landmarks — the pier,
 *     the plaza fountains, the shore — and stop there to frame a shot, holding
 *     still with the lens up until the photo is taken;
 *   - a share of the crowd is booked to gather at a park (or, on the shore, at
 *     the promenade): they walk to the stretch of pavement closest to the
 *     green, then stand in a loose knot facing it before drifting off again.
 *
 * The exported surface keeps createPedestrians(city, rng) with
 * { list, update, knockAt, count }; everything else is additive, and the
 * previously exported tables (PED_STATES, PED_GAITS) keep every key they had.
 */

import { PEDS, PED_SHIRTS, PED_SKINS } from './config.js';
import { clamp, distance, lerp, TAU } from './utils.js';

/* ------------------------------------------------------------------ */
/* 1. tuning — legacy reaction values                                  */
/* ------------------------------------------------------------------ */

const DOWN_TIME = 4.5;
const HURT_TIME = 0.7;
const PERSONAL = 30;
const CAR_FEAR = 46;
const SCARY_SPEED = 55;
const RECOVER = 2.4;
const OFFSET_LIMIT = 9;

/* ------------------------------------------------------------------ */
/* 1b. tuning — zebra crossings                                        */
/* ------------------------------------------------------------------ */

// Two facing kerb corners across a road corridor sit ~108 apart on this map
// (road 86 wide, each loop inset 11 into its block). The window is loose so a
// re-tuned CITY still yields crossings instead of silently none.
const CROSS_MIN = 26;
const CROSS_MAX = 150;
const CORNER_EPS = 3.5;      // how axis-aligned a corner pair must be
const CORNER_REACH = 8;      // how close a walker must come to a corner
const CROSS_WAIT_MIN = 0.25; // pause at the kerb, looking up the road
const CROSS_WAIT_MAX = 1.15;
const CROSS_SPEED = 1.2;     // everyone hurries a little on the road
const CROSS_COOLDOWN = 7;    // seconds before the next crossing
const CROSS_LANE = 4;        // sideways scatter between crossing walkers
const CROSS_CLEAR = 34;      // a moving car this near the zebra line holds us
const CROSS_RECHECK = 0.3;   // how often a held walker looks again
const CROSS_PATIENCE = 6.5;  // ... and how long it will wait before striding out
const CROSS_CAR_SPEED = 18;  // below this a car counts as parked, not traffic

/* ------------------------------------------------------------------ */
/* 1c. tuning — panic and spacing                                      */
/* ------------------------------------------------------------------ */

const RUN_FEAR = 88;         // radius a fast car has to enter
const RUN_SPEED = 105;       // ... while doing at least this speed
const RUN_BOOST = 2.15;      // sprint multiplier while dodging
const DODGE_TIME = 1.1;      // seconds of sprint after the last scare

const SEPARATION = 15;       // personal bubble between pedestrians
const SEPARATION_GAIN = 1.6;
const PUSH_LIMIT = 18;       // cap on accumulated shove, in world units
const IDLE_MIN = 7;          // seconds between chances to stop and look around
const IDLE_MAX = 20;

/* ------------------------------------------------------------------ */
/* 1d. tuning — archetypes, gathering, photography                     */
/* ------------------------------------------------------------------ */

const GATHER_CHANCE = 0.34;      // share of walkers with a park booking
const GATHER_DELAY_MIN = 14;     // seconds before they head for it
const GATHER_DELAY_MAX = 65;
const GATHER_ARRIVE = 6;         // arc distance that counts as "there"
const GATHER_LINGER_MIN = 12;
const GATHER_LINGER_MAX = 34;
const GATHER_SWAY = 2.6;         // sideways drift while standing in the knot
const GATHER_RELEASE = 45;       // cooldown after a linger, in seconds

const PHOTO_CHANCE = 0.75;       // per second, while paused with a camera
const PHOTO_COOLDOWN_MIN = 16;
const PHOTO_COOLDOWN_MAX = 46;
const PHOTO_TIME_MIN = 1.2;
const PHOTO_TIME_MAX = 2.4;

const COURIER_DASH = 1.34;       // pace multiplier during a delivery sprint
const COURIER_DASH_MIN = 3;
const COURIER_DASH_MAX = 8;
const COURIER_DASH_GAP_MIN = 12;
const COURIER_DASH_GAP_MAX = 32;

const DODGE_SIDE_KEEP = 0.45;    // how hard a dodge pushes the walker's lane

/* ------------------------------------------------------------------ */
/* 2b. tuning — gunfire panic and landmark sightseeing                 */
/* ------------------------------------------------------------------ */

// A gunshot is a point event, not a passing car: it is felt through
// world.combat.bullets, a world.fires()/gunshot report or a police officer
// discharging a sidearm, and it reaches further than any engine noise.
const SHOT_RADIUS = 260;         // world units a report carries
const SHOT_RADIUS_CAR = 340;     // ... a little further through open street
const SHOT_PANIC_MIN = 3.2;      // seconds of blind panic per report
const SHOT_PANIC_MAX = 6.5;
const SHOT_SPRINT = 2.55;        // pace multiplier while fleeing gunfire
const SHOT_FLEE_CAP = 900;       // never run further than this from the shot
const SHOT_SETTLE = 1.6;         // seconds of shaking before they walk again
const SHOT_REPEAT = 0.45;        // ignore repeats of the same report this soon
const SHOT_HEARSAY = 55;         // a panicking walker spreads it this far
const SHOT_PANIC_KEEP = 12;      // distance kept from the muzzle while fleeing

// Tourists with a camera are not content to shoot whatever is nearest: they
// walk an errand to a named landmark and photograph it from the kerb.
const LANDMARK_CHANCE = 0.62;    // share of camera tourists who take an errand
const LANDMARK_DELAY_MIN = 8;    // seconds before they set off
const LANDMARK_DELAY_MAX = 40;
const LANDMARK_ARRIVE = 34;      // arc distance that counts as "at the view"
const LANDMARK_STAND = 46;       // world distance for the pose, not the arc
const LANDMARK_LINGER_MIN = 7;   // seconds of framing before the shutter
const LANDMARK_LINGER_MAX = 18;
const LANDMARK_RELEASE = 55;     // cooldown before the next landmark errand
const LANDMARK_VIEW = 120;       // how far past a fountain the camera aims
const SNAPSHOT_RANGE = 900;      // the landmark must be this close to shoot it
const SNAPSHOT_SWAY = 1.1;       // timid lens drift while composing

/* ------------------------------------------------------------------ */
/* 2. public tables                                                    */
/* ------------------------------------------------------------------ */

export const PED_STATES = Object.freeze({
  WALK: 'walk',
  WAIT: 'wait',
  CROSS: 'cross',
  DODGE: 'dodge',
  DOWN: 'down',
  GATHER: 'gather',
  PHOTO: 'photo',
  FLEE: 'flee',
  SIGHTSEE: 'sightsee',
});

/*
 * Walking personalities. `factor` scales the base pace, `tempo` scales the
 * stride animation, `pauseChance` is the chance of taking a break each idle
 * window and `crossChance` the chance of using a crossing it walks past.
 */
export const PED_GAITS = Object.freeze([
  { key: 'stroller', label: 'Stroller', weight: 0.18, factor: 0.72, tempo: 0.85, pauseChance: 0.55, crossChance: 0.30 },
  { key: 'shopper', label: 'Shopper', weight: 0.34, factor: 0.92, tempo: 1.00, pauseChance: 0.70, crossChance: 0.45 },
  { key: 'commuter', label: 'Commuter', weight: 0.34, factor: 1.12, tempo: 1.18, pauseChance: 0.15, crossChance: 0.55 },
  { key: 'jogger', label: 'Jogger', weight: 0.14, factor: 1.34, tempo: 1.45, pauseChance: 0.04, crossChance: 0.35 },
]);

/*
 * Who the walker is, as opposed to how they walk. `gaitBias` multiplies the
 * base gait weights, `speed` scales the cruise pace, `pauseBias` and
 * `gatherBias` skew the idle and park tendencies and `crossBias` their
 * appetite for the zebra. `prop` is cosmetic data the renderer may pick up
 * later (parcel satchel, camera, shopping bag); it changes nothing here.
 */
export const PED_ARCHETYPES = Object.freeze([
  {
    key: 'local', label: 'Local', weight: 0.30, prop: null,
    speed: 1, pauseBias: 1, crossBias: 1, gatherBias: 1.1,
    gaitBias: {},
  },
  {
    key: 'worker', label: 'Worker', weight: 0.22, prop: 'bag',
    speed: 1.06, pauseBias: 0.6, crossBias: 1.2, gatherBias: 0.45,
    gaitBias: { commuter: 2.1, jogger: 1.2, stroller: 0.3 },
  },
  {
    key: 'shopper', label: 'Shopper', weight: 0.22, prop: 'bag',
    speed: 0.94, pauseBias: 1.35, crossBias: 1.05, gatherBias: 0.9,
    gaitBias: { shopper: 2.4, stroller: 1.4, commuter: 0.5 },
  },
  {
    key: 'courier', label: 'Parcel courier', weight: 0.12, prop: 'parcel',
    speed: 1.24, pauseBias: 0.25, crossBias: 1.7, gatherBias: 0.12,
    gaitBias: { commuter: 2.6, jogger: 1.8, stroller: 0.15 },
  },
  {
    key: 'tourist', label: 'Tourist', weight: 0.14, prop: 'camera',
    speed: 0.76, pauseBias: 1.9, crossBias: 0.7, gatherBias: 1.9,
    gaitBias: { stroller: 2.3, shopper: 1.2, jogger: 0.15 },
  },
]);

/*
 * District pace table. These are the districts city.js hands out
 * ('oldtown', 'downtown', 'modern') plus 'shore' for the promenade, pier and
 * beach loops, which are not part of any block district.
 */
export const PED_ZONES = Object.freeze({
  oldtown: { speed: 0.90, crossBias: 0.85, gatherBias: 1.2 },
  downtown: { speed: 1.10, crossBias: 1.15, gatherBias: 0.85 },
  modern: { speed: 1.00, crossBias: 1.0, gatherBias: 0.9 },
  shore: { speed: 0.82, crossBias: 0.35, gatherBias: 1.5 },
  unknown: { speed: 1.0, crossBias: 1.0, gatherBias: 1.0 },
});

/* ------------------------------------------------------------------ */
/* 3. geometry and pure helpers                                        */
/* ------------------------------------------------------------------ */

function validRoute(w) {
  return !!w && Array.isArray(w.points) && w.points.length >= 2;
}

/* Loop length in world units. Exported for route/inspection tooling. */
export function measureLoop(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    sum += distance(a.x, a.y, b.x, b.y);
  }
  return sum;
}

// The old internal name, kept so nothing that reaches in breaks.
const loopLength = measureLoop;

// Arc length of the point on the loop closest to (x, y); used to re-attach a
// walker to a new loop after it has crossed a road.
function nearestOnLoop(pts, x, y) {
  let bestS = 0, bestD = Infinity, acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const seg = Math.hypot(dx, dy);
    if (seg < 1e-6) continue;
    const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (seg * seg), 0, 1);
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < bestD) { bestD = d; bestS = acc + seg * t; }
    acc += seg;
  }
  return { s: bestS, d: bestD };
}

/*
 * The point at arc length `s` along a closed loop, ignoring the lane offset.
 * Used by the gunfire logic to ask "is the next stretch of pavement further
 * from the muzzle than the last one?" — pure, so it is cheap to call twice a
 * frame per panicking walker.
 */
function loopPoint(pts, len, s) {
  if (!Array.isArray(pts) || pts.length < 2) return { x: 0, y: 0 };
  const total = len > 0 ? len : 1;
  let want = ((s % total) + total) % total;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const seg = Math.hypot(dx, dy);
    if (seg < 1e-6) continue;
    if (want <= seg) {
      const t = want / seg;
      return { x: a.x + dx * t, y: a.y + dy * t };
    }
    want -= seg;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y };
}

/*
 * Pairs up kerb corners that face each other across a road corridor. Corner
 * points are the vertices of the block loops, so a match is a straight
 * pavement-to-pavement line over one road — always the road flanking a
 * junction, which is where the town paints its zebra bands.
 */
function buildCrossings(routes) {
  const entries = [];
  for (let i = 0; i < routes.length; i++) {
    const A = routes[i];
    for (let j = i + 1; j < routes.length; j++) {
      const B = routes[j];
      for (let a = 0; a < A.length; a++) {
        const p = A[a];
        for (let b = 0; b < B.length; b++) {
          const q = B[b];
          const dx = q.x - p.x, dy = q.y - p.y;
          const ax = Math.abs(dx), ay = Math.abs(dy);
          const across = ay <= CORNER_EPS && ax >= CROSS_MIN && ax <= CROSS_MAX;
          const along = ax <= CORNER_EPS && ay >= CROSS_MIN && ay <= CROSS_MAX;
          if (!across && !along) continue;
          entries.push({
            axis: across ? 'x' : 'y',
            dist: Math.hypot(dx, dy),
            // The band is the stretch of road a zebra would be painted over.
            midX: (p.x + q.x) / 2,
            midY: (p.y + q.y) / 2,
            ends: [
              { loop: i, x: p.x, y: p.y },
              { loop: j, x: q.x, y: q.y },
            ],
          });
        }
      }
    }
  }
  return entries;
}

function indexCrossings(routes, entries) {
  const map = new Map();
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e];
    for (let k = 0; k < 2; k++) {
      const route = routes[entry.ends[k].loop];
      let list = map.get(route);
      if (!list) { list = []; map.set(route, list); }
      list.push(entry);
    }
  }
  return map;
}

/*
 * Which of the town's districts a point sits in. `city.districtOf` is the
 * authoritative answer for the mainland; the shore loops are handled first
 * because they live beyond the block grid and would otherwise fall into the
 * nearest column's district.
 */
export function zoneOf(city, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'unknown';

  const beachX = city?.beach?.x;
  if (Number.isFinite(beachX) && x >= beachX - 30) return 'shore';

  const d = typeof city?.districtOf === 'function' ? city.districtOf(x, y) : null;
  if (d && PED_ZONES[d]) return d;

  const rects = city?.districts;
  if (rects && typeof rects === 'object') {
    for (const key of ['oldtown', 'downtown', 'modern']) {
      const r = rects[key];
      if (!r || !Number.isFinite(r.x)) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return key;
    }
  }
  return 'unknown';
}

/*
 * Walking routes the crowd uses, in the order createPedestrians lays them
 * out: block loops first (a crossing is only ever built across a real
 * street), then the shore loops. Pure — handy for map screens and tests.
 */
export function walkRoutes(city) {
  const turns = Array.isArray(city?.walkways) ? city.walkways.filter(validRoute) : [];
  const blocks = Array.isArray(city?.blocks) ? city.blocks.length : 0;
  return turns.map((loop, index) => {
    const points = loop.points;
    const kind = index < blocks ? 'block' : 'shore';
    const first = points[0] ?? { x: 0, y: 0 };
    return {
      index,
      kind,
      closed: loop.closed !== false,
      points,
      length: measureLoop(points),
      district: kind === 'block'
        ? (city?.blocks?.[index]?.district ?? zoneOf(city, first.x, first.y))
        : 'shore',
    };
  });
}

/*
 * Landmarks worth a photograph, in the order a tourist cares about them.
 * Everything is read off the city the crowd was built from — the pier head,
 * the plaza fountains, the parks, the promenade and the sea wall — so a
 * re-tuned CITY yields different viewpoints without touching this file.
 * Pure: `view` is the direction the lens should point, in radians.
 */
export function landmarkSites(city) {
  const out = [];
  const push = (kind, label, x, y, view, weight) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    out.push({ id: out.length, kind, label, x, y, view, weight });
  };

  const pier = city?.pier;
  if (pier && Number.isFinite(pier.x) && Number.isFinite(pier.w)) {
    // Standing at the landward end, looking out along the boards.
    push('pier', 'the pier', pier.x + pier.w * 0.18, pier.y + (pier.h ?? 0) / 2,
      Math.atan2(0, 1), 1.3);
  }

  const fountains = Array.isArray(city?.fountains) ? city.fountains : [];
  for (let i = 0; i < fountains.length; i++) {
    const f = fountains[i];
    push('fountain', 'the plaza fountain', f.x, f.y, Math.PI * 0.5, 1.1);
  }

  const plazas = Array.isArray(city?.plazas) ? city.plazas : [];
  for (let i = 0; i < plazas.length; i++) {
    const p = plazas[i];
    push('plaza', 'the plaza', p.x + p.w / 2, p.y + p.h / 2, 0, 0.7);
  }

  const parks = Array.isArray(city?.parks) ? city.parks : [];
  for (let i = 0; i < parks.length; i++) {
    const p = parks[i];
    push('park', 'the park', p.x + p.w / 2, p.y + p.h / 2, 0, 0.9);
  }

  const promenade = city?.promenade;
  if (promenade && Number.isFinite(promenade.x)) {
    const midY = (promenade.h ?? (city?.height ?? 1200)) * 0.5;
    push('promenade', 'the promenade', promenade.x + (promenade.w ?? 30) / 2, midY,
      Math.atan2(0, 1), 1.0);
  }

  const water = city?.water;
  if (water && Number.isFinite(water.x)) {
    push('sea', 'the sea', water.x + (water.w ?? 0) * 0.5,
      (city?.height ?? 1200) * 0.5, Math.atan2(0, 1), 0.8);
  }

  return out;
}

/*
 * Headcount per district. Reads the zone a walker was last seen in (walkers
 * carry `zoneKey`), falling back to a live lookup when a city is supplied.
 * Returns plain counts, plus total and a share for each district.
 */
export function districtDensity(list, city = null) {
  const out = {
    oldtown: 0, downtown: 0, modern: 0, shore: 0, unknown: 0,
    total: 0, share: {},
  };
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    let key = typeof p.zoneKey === 'string' && PED_ZONES[p.zoneKey] ? p.zoneKey : null;
    if (!key && city) key = zoneOf(city, p.x, p.y);
    if (!key || !(key in out)) key = 'unknown';
    out[key]++;
    out.total++;
  }
  for (const key of ['oldtown', 'downtown', 'modern', 'shore', 'unknown']) {
    out.share[key] = out.total > 0 ? out[key] / out.total : 0;
  }
  return out;
}

function pickArchetype(rand) {
  let total = 0;
  for (let i = 0; i < PED_ARCHETYPES.length; i++) total += PED_ARCHETYPES[i].weight;
  let roll = rand() * total;
  for (let i = 0; i < PED_ARCHETYPES.length; i++) {
    roll -= PED_ARCHETYPES[i].weight;
    if (roll <= 0) return PED_ARCHETYPES[i];
  }
  return PED_ARCHETYPES[PED_ARCHETYPES.length - 1];
}

/* Weighted gait pick. The archetype's gaitBias is optional, so the old
 * pickGait(rand) call still works exactly as before. */
function pickGait(rand, archetype = null) {
  const bias = archetype?.gaitBias;
  const weights = [];
  let total = 0;
  for (let i = 0; i < PED_GAITS.length; i++) {
    const g = PED_GAITS[i];
    const weight = g.weight * (bias?.[g.key] ?? 1);
    weights.push(weight);
    total += weight;
  }
  let roll = rand() * total;
  for (let i = 0; i < PED_GAITS.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return PED_GAITS[i];
  }
  return PED_GAITS[PED_GAITS.length - 1];
}

function clampPush(w) {
  const m = Math.hypot(w.pushX, w.pushY);
  if (m > PUSH_LIMIT) {
    const k = PUSH_LIMIT / m;
    w.pushX *= k;
    w.pushY *= k;
  }
}

// Shortest signed angle from a to b, and a damped turn towards it.
function angleGap(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function turnFacing(w, target, k) {
  w.facing += angleGap(w.facing, target) * clamp(k, 0, 1);
}

/* ------------------------------------------------------------------ */
/* 4. the crowd                                                        */
/* ------------------------------------------------------------------ */

export function createPedestrians(city, rng) {
  const crowd = [];
  const routeLengths = new Map();
  const zoneCells = new Map();
  let clock = 0;

  /*
   * Behaviour rolls run on a private generator seeded from the caller's, so
   * per-frame decisions never disturb the city's deterministic sequence.
   */
  let seed = (Math.floor((rng?.() ?? 0.5) * 0xffffffff) || 1) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const randRange = (a, b) => a + rand() * (b - a);
  const randPick = (arr) => arr[Math.floor(rand() * arr.length)];

  function routeLength(route) {
    let len = routeLengths.get(route);
    if (len === undefined) {
      len = Math.max(1, loopLength(route));
      routeLengths.set(route, len);
    }
    return len;
  }

  /* ---- placement on a loop --------------------------------------- */

  function placeOnLoop(w) {
    const pts = w.route;
    if (!pts?.length || pts.length < 2) return;
    const n = pts.length;
    const len = w.length > 0 ? w.length : 1;
    let s = ((w.s % len) + len) % len;

    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const seg = Math.hypot(dx, dy);
      if (seg < 1e-6) continue;
      if (s <= seg) {
        const t = s / seg;
        const nx = -dy / seg, ny = dx / seg;
        w.lx = lerp(a.x, b.x, t) + nx * w.offset;
        w.ly = lerp(a.y, b.y, t) + ny * w.offset;
        const fwd = Math.atan2(dy, dx);
        w.facing = w.dirSign > 0 ? fwd : fwd + Math.PI;
        return;
      }
      s -= seg;
    }
    w.lx = pts[0].x; w.ly = pts[0].y;
  }

  function settle(w) {
    w.x = w.lx + w.pushX;
    w.y = w.ly + w.pushY;
    w.onRoute = true;
  }

  /* ---- zone lookup, cached on a coarse grid ---------------------- */

  function zoneKeyAt(x, y) {
    const cell = (Math.floor(x / 96) + 1024) * 4096 + (Math.floor(y / 96) + 1024);
    let key = zoneCells.get(cell);
    if (key === undefined) {
      key = zoneOf(city, x, y);
      zoneCells.set(cell, key);
    }
    return key;
  }

  /* ---- routes ---------------------------------------------------- */
  /* Walkways are laid out blocks first, then the shore loops; keeping that
   * split means crossings are only ever built across real streets. */

  const turns = Array.isArray(city?.walkways) ? city.walkways.filter(validRoute) : [];
  const blocks = Array.isArray(city?.blocks) ? city.blocks.length : 0;
  const blockLoops = turns.slice(0, blocks);
  const shoreLoops = turns.slice(blocks);

  const blockRoutes = blockLoops.map((l) => l.points);
  const shoreRoutes = shoreLoops.map((l) => l.points);

  // Degenerate city (no walkways at all): keep the headcount honest with a
  // small square around downtown rather than spawning nobody.
  if (!blockRoutes.length && !shoreRoutes.length) {
    const cx = Number.isFinite(city?.downtown?.x) ? city.downtown.x : 400;
    const cy = Number.isFinite(city?.downtown?.y) ? city.downtown.y : 400;
    const r = 60;
    blockRoutes.push([
      { x: cx - r, y: cy - r },
      { x: cx + r, y: cy - r },
      { x: cx + r, y: cy + r },
      { x: cx - r, y: cy + r },
    ]);
  }

  const blockIndexOf = new Map();
  for (let i = 0; i < blockRoutes.length; i++) blockIndexOf.set(blockRoutes[i], i);

  const crossingEntries = buildCrossings(blockRoutes);
  const crossingAt = indexCrossings(blockRoutes, crossingEntries);

  /* ---- parks and gathering spots --------------------------------- */

  const parkList = (Array.isArray(city?.parks) ? city.parks : [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      cx: p.x + (p.w ?? 0) / 2,
      cy: p.y + (p.h ?? 0) / 2,
      r: Math.min(p.w ?? 0, p.h ?? 0) * 0.5,
      district: p.district ?? 'downtown',
    }));

  /*
   * A gathering spot is the stretch of pavement closest to a park: the crowd
   * stands on its own loop, facing the green, which is as close to "loitering
   * in the park" as a loop-bound walker can honestly get. Shore loops get one
   * spot each at their mid-point so tourists mass on the promenade too.
   */
  const gatherSpots = [];
  for (let i = 0; i < parkList.length; i++) {
    const park = parkList[i];
    let best = null;
    for (let r = 0; r < blockRoutes.length; r++) {
      const snap = nearestOnLoop(blockRoutes[r], park.cx, park.cy);
      if (!best || snap.d < best.d) best = { loop: r, d: snap.d, s: snap.s };
    }
    if (!best) continue;
    gatherSpots.push({
      id: gatherSpots.length,
      kind: 'park',
      loop: best.loop,
      route: blockRoutes[best.loop],
      s: best.s,
      x: park.cx,
      y: park.cy,
      radius: Math.max(24, park.r * 0.6),
      capacity: 2 + Math.floor(rand() * 3),
      occupants: 0,
      district: park.district,
    });
  }
  for (let i = 0; i < shoreRoutes.length; i++) {
    const route = shoreRoutes[i];
    gatherSpots.push({
      id: gatherSpots.length,
      kind: 'promenade',
      loop: -1,
      route,
      s: routeLength(route) * 0.5,
      x: route[0]?.x ?? 0,
      y: route[0]?.y ?? 0,
      radius: 40,
      capacity: 2 + Math.floor(rand() * 3),
      occupants: 0,
      district: 'shore',
    });
  }

  function nearestGatherSpot(route, s) {
    if (!gatherSpots.length) return null;
    const len = routeLength(route);
    let best = null, bestD = Infinity;
    for (let i = 0; i < gatherSpots.length; i++) {
      const spot = gatherSpots[i];
      if (spot.route !== route) continue;
      if (spot.occupants >= spot.capacity) continue;
      let d = Math.abs(spot.s - s) % len;
      if (d > len / 2) d = len - d;
      // Prefer the nearer one, but let a small dice roll break ties so the
      // whole block does not queue for the same bench.
      const score = d * randRange(0.75, 1.25);
      if (score < bestD) { bestD = score; best = spot; }
    }
    return best;
  }

  function releaseSpot(w) {
    const spot = w.gatherSpot;
    if (spot && w.gatherPhase === 'linger') spot.occupants = Math.max(0, spot.occupants - 1);
    w.gatherPhase = 'idle';
    w.gatherLinger = 0;
  }

  /* ---- landmark viewpoints --------------------------------------- */

  /*
   * Every loop gets one viewpoint: the stretch of pavement closest to the most
   * interesting landmark within sight of it. That is the same trick the park
   * gathering spots use — a walker stands on its own pavement and looks at the
   * thing — and it means every camera tourist has somewhere real to walk,
   * instead of only the handful whose loop a landmark happened to snap onto.
   */
  const landmarkList = landmarkSites(city);
  const viewCache = new Map();

  function buildView(route) {
    let best = null, bestScore = Infinity;
    let nearest = null, nearestD = Infinity;
    for (let i = 0; i < landmarkList.length; i++) {
      const lm = landmarkList[i];
      const snap = nearestOnLoop(route, lm.x, lm.y);
      if (!Number.isFinite(snap.d)) continue;
      // Track the genuinely nearest landmark as a last resort, so a block out
      // in the back streets still has one worth the walk.
      if (snap.d < nearestD) { nearestD = snap.d; nearest = { lm, snap }; }
      // Too far to photograph honestly: skip it.
      if (snap.d > SNAPSHOT_RANGE) continue;
      // Nearer and more famous wins; the weighting keeps the pier and the
      // fountains ahead of an anonymous square.
      const score = snap.d - lm.weight * 140;
      if (score < bestScore) {
        bestScore = score;
        best = { lm, snap };
      }
    }
    if (!best) best = nearest;
    if (!best) return null;
    return {
      id: viewCache.size,
      kind: best.lm.kind,
      label: best.lm.label,
      x: best.lm.x,
      y: best.lm.y,
      view: best.lm.view,
      route,
      s: best.snap.s,
      standoff: best.snap.d,
      weight: best.lm.weight,
      loop: blockIndexOf.has(route) ? blockIndexOf.get(route) : -1,
    };
  }

  function viewOf(route) {
    if (viewCache.has(route)) return viewCache.get(route);
    const made = buildView(route);
    viewCache.set(route, made);
    return made;
  }

  function nearestView(route, s, x, y) {
    const candidate = viewOf(route);
    if (candidate) return candidate;
    // No landmark in sight of this loop: fall back to any viewpoint at all so
    // the tourist keeps an errand rather than standing about.
    let best = null;
    for (const spot of viewCache.values()) if (spot) { best = spot; break; }
    void s; void x; void y;
    return best;
  }

  function allViews() {
    const seen = [];
    const keys = blockRoutes.concat(shoreRoutes);
    for (let i = 0; i < keys.length; i++) {
      const v = viewOf(keys[i]);
      if (v) seen.push(v);
    }
    return seen;
  }

  /* ---- walker construction --------------------------------------- */

  function makeWalker(route, along) {
    const archetype = pickArchetype(rand);
    const gait = pickGait(rand, archetype);
    const len = routeLength(route);
    const spot = rand() < GATHER_CHANCE * (archetype.gatherBias ?? 1)
      ? nearestGatherSpot(route, clamp(along, 0, 0.9999) * len)
      : null;
    const zoneKey = zoneKeyAt(route[0].x, route[0].y);
    const zone = PED_ZONES[zoneKey] ?? PED_ZONES.unknown;

    // Only a camera tourist takes the landmark errand; a shopper holding a bag
    // has no business framing the fountain.
    const camera = archetype.prop === 'camera';
    const view = camera && rand() < LANDMARK_CHANCE
      ? nearestView(route, clamp(along, 0, 0.9999) * len, route[0].x, route[0].y)
      : null;

    const w = {
      // route state
      route,
      loopIndex: blockIndexOf.has(route) ? blockIndexOf.get(route) : -1,
      routeKind: blockIndexOf.has(route) ? 'block' : 'shore',
      length: len,
      s: clamp(along, 0, 0.9999) * len,
      dirSign: rand() < 0.5 ? 1 : -1,

      // who they are and how they walk
      archetype,
      archetypeKey: archetype.key,
      prop: archetype.prop,
      camera,
      parcel: archetype.prop === 'parcel',
      bag: archetype.prop === 'bag',
      gait,
      gaitKey: gait.key,
      base: randRange(24, 46) * gait.factor * archetype.speed,
      cruise: 0,
      tempo: gait.tempo * randRange(0.9, 1.12),
      waveRate: randRange(0.3, 0.85),
      wavePhase: randRange(0, TAU),
      waveAmp: randRange(0.05, 0.15),
      speed: 0,

      // district pacing
      zoneKey,
      zone: zoneKey,
      zoneJitter: randRange(0.96, 1.04),
      zoneSpeed: zone.speed * randRange(0.96, 1.04),
      crossChance: clamp(gait.crossChance * (archetype.crossBias ?? 1) * zone.crossBias, 0.02, 0.95),
      pauseChance: clamp(gait.pauseChance * (archetype.pauseBias ?? 1), 0.01, 0.95),

      // body
      x: route[0].x,
      y: route[0].y,
      lx: route[0].x,
      ly: route[0].y,
      pushX: 0,
      pushY: 0,
      facing: 0,
      walkPhase: randRange(0, TAU),
      shirt: randPick(PED_SHIRTS),
      skin: randPick(PED_SKINS),
      hat: rand() < 0.25,
      scale: randRange(0.9, 1.08),
      offset: randRange(-5, 5),
      anchorOffset: 0,

      // behaviour timers
      paused: 0,
      idleIn: randRange(2, IDLE_MAX),
      down: 0,
      hurt: 0,
      fear: 0,
      hp: 100,
      stagger: 0,
      radius: 9,
      onRoute: true,
      onRoad: false,
      state: PED_STATES.WALK,
      cross: null,
      crossCooldown: randRange(0, 6),
      crossings: 0,

      // gathering
      gatherSpot: spot,
      gatherPhase: 'idle',
      gatherTimer: randRange(GATHER_DELAY_MIN, GATHER_DELAY_MAX),
      gatherLinger: 0,
      gatherSway: randRange(0, TAU),

      // photography and delivery errands
      photo: 0,
      photoYaw: 0,
      photoCooldown: randRange(0, 20),
      dash: 0,
      dashIn: randRange(2, COURIER_DASH_GAP_MAX),

      // landmark sightseeing (camera tourists only)
      camera,
      viewSpot: view,
      viewPhase: 'idle',
      viewTimer: view ? randRange(LANDMARK_DELAY_MIN, LANDMARK_DELAY_MAX) : Infinity,
      viewLinger: 0,
      viewShots: 0,
      viewYaw: 0,

      // gunfire panic
      panic: 0,
      panicMax: 0,
      panicX: 0,
      panicY: 0,
      panicKey: -1,
      startle: 0,
      scatter: 0,
    };
    // A few percent either side of the profile, so the crowd is not made of
    // four identical queues.
    w.cruise = w.base * randRange(0.94, 1.06);
    w.speed = w.cruise * 0.7;
    placeOnLoop(w);
    w.anchorOffset = w.offset;
    settle(w);
    return w;
  }

  const target = Math.max(0, (PEDS?.count ?? 54) | 0);
  const blockOrder = blockRoutes.slice();
  for (let i = blockOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = blockOrder[i]; blockOrder[i] = blockOrder[j]; blockOrder[j] = t;
  }
  let blockCursor = 0;

  // Deal walkers across every block in turn (so all 35 sidewalks are used),
  // with roughly one in seven taking the promenade or the pier instead.
  for (let i = 0; i < target; i++) {
    const onShore = i % 7 === 0 && shoreRoutes.length > 0;
    let route;
    if (onShore) {
      route = randPick(shoreRoutes);
    } else if (blockOrder.length) {
      route = blockOrder[blockCursor % blockOrder.length];
      blockCursor++;
    } else {
      route = randPick(shoreRoutes);
    }
    if (!route) continue;
    crowd.push(makeWalker(route, rand()));
  }

  /* ---- state helpers --------------------------------------------- */

  function dead(w) {
    return w.down === true || w.hp <= 0;
  }

  function findCrossing(w) {
    const list = crossingAt.get(w.route);
    if (!list || !list.length || w.loopIndex < 0) return null;

    let best = null, bestD = CORNER_REACH * CORNER_REACH;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      const near = entry.ends[0].loop === w.loopIndex ? entry.ends[0] : entry.ends[1];
      const far = entry.ends[0].loop === w.loopIndex ? entry.ends[1] : entry.ends[0];
      if (near === far) continue;
      const d2 = (w.lx - near.x) ** 2 + (w.ly - near.y) ** 2;
      if (d2 < bestD) { bestD = d2; best = { entry, near, far }; }
    }
    return best;
  }

  function startCrossing(w) {
    const hit = findCrossing(w);
    if (!hit) return false;
    const { entry, near, far } = hit;
    const dx = far.x - near.x, dy = far.y - near.y;
    const dist = Math.hypot(dx, dy) || entry.dist || 1;
    const wait = randRange(CROSS_WAIT_MIN, CROSS_WAIT_MAX);

    w.cross = {
      phase: 'wait',
      wait,
      waitTotal: wait,
      held: 0,
      t: 0,
      // where the walker is right now, so the step up to the kerb is smooth
      ax: w.lx,
      ay: w.ly,
      x0: near.x,
      y0: near.y,
      x1: far.x,
      y1: far.y,
      ux: dx / dist,
      uy: dy / dist,
      dist,
      lane: randRange(-CROSS_LANE, CROSS_LANE) * (rand() < 0.5 ? 1 : -1),
      dir: Math.atan2(dy, dx),
      toLoop: far.loop,
      axis: entry.axis,
      // zebra band the walker is stepping onto, for the traffic check
      bandX: entry.midX,
      bandY: entry.midY,
    };
    w.crossCooldown = CROSS_COOLDOWN * randRange(0.75, 1.5);
    w.paused = 0;
    return true;
  }

  function finishCross(w) {
    const c = w.cross;
    if (!c) return;
    const route = blockRoutes[c.toLoop];
    if (route) {
      const snap = nearestOnLoop(route, c.x1, c.y1);
      w.route = route;
      w.routeKind = 'block';
      w.loopIndex = c.toLoop;
      w.length = routeLength(route);
      w.s = snap.s;
    } else {
      w.s = 0;
    }
    w.offset = clamp(w.offset * 0.35 + c.lane * 0.5, -OFFSET_LIMIT, OFFSET_LIMIT);
    w.anchorOffset = w.offset;
    w.crossings++;
    w.cross = null;
    w.onRoad = false;
    // A crossing can land you in the next district: reprice the pace.
    const zk = zoneKeyAt(c.x1, c.y1);
    if (zk !== w.zoneKey) {
      w.zoneKey = zk;
      w.zoneSpeed = (PED_ZONES[zk] ?? PED_ZONES.unknown).speed * w.zoneJitter;
    }
    // The park they were heading for is likely on the loop they just left.
    if (w.gatherSpot && w.gatherSpot.route !== w.route) {
      releaseSpot(w);
      w.gatherSpot = nearestGatherSpot(w.route, w.s);
      w.gatherTimer = randRange(GATHER_DELAY_MIN, GATHER_DELAY_MAX);
    }
    placeOnLoop(w);
    settle(w);
  }

  /* ---- threat scan ----------------------------------------------- */

  function gatherCars(w, world) {
    const out = [];
    const near = world?.carsNear ? world.carsNear(w.x, w.y, RUN_FEAR) : null;
    if (Array.isArray(near)) {
      for (let i = 0; i < near.length; i++) if (near[i]) out.push(near[i]);
    } else if (near) {
      out.push(near);
    }
    // The player's own car matters most; take it directly in case carsNear
    // only knows about ambient traffic.
    const pc = world?.player?.car;
    if (pc && Number.isFinite(pc.x) && Number.isFinite(pc.y) && out.indexOf(pc) === -1) out.push(pc);
    return out;
  }

  function scanThreat(w, world) {
    const cars = gatherCars(w, world);
    let best = null, bestScore = 0;

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car || !Number.isFinite(car.x) || !Number.isFinite(car.y)) continue;
      const speed = Math.abs(car.speed ?? 0);
      if (!(speed > SCARY_SPEED)) continue;
      const d = distance(w.x, w.y, car.x, car.y);
      if (!(d < RUN_FEAR)) continue;
      const player = car === world?.player?.car;
      const score = speed + (RUN_FEAR - d) * 2 + (player ? 40 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { car, speed, d, player };
      }
    }
    return best;
  }

  /*
   * Is somebody driving over the zebra this walker is about to use? Only
   * moving cars count — a parked one never blocks the band — and the test is
   * the distance from the car to the crossing line, so a car a lane over is
   * not mistaken for traffic bearing down.
   */
  function crossingBusy(w, world) {
    const c = w.cross;
    if (!c) return false;
    const cars = gatherCars(w, world);
    const dx = c.x1 - c.x0, dy = c.y1 - c.y0;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car || !Number.isFinite(car.x) || !Number.isFinite(car.y)) continue;
      if (Math.abs(car.speed ?? 0) < CROSS_CAR_SPEED) continue;
      const t = clamp(((car.x - c.x0) * dx + (car.y - c.y0) * dy) / len2, -0.35, 1.35);
      const px = c.x0 + dx * t, py = c.y0 + dy * t;
      if (Math.hypot(car.x - px, car.y - py) < CROSS_CLEAR) return true;
    }
    return false;
  }

  /*
   * A car actually bearing down makes a walker sprint sideways out of the
   * lane; merely fast traffic keeps the old spook-and-shove. Both keep the
   * legacy `hurt` flash so the renderer still shows panic. The archetype
   * decides how quickly they react: a courier is already moving, a tourist
   * with a camera takes half a beat longer.
   */
  function reactToThreat(w, threat, dt) {
    const car = threat.car;
    const reaction = w.archetypeKey === 'courier' ? 1.15
      : w.archetypeKey === 'tourist' ? 0.85
        : 1;

    if (threat.speed > RUN_SPEED * (w.archetypeKey === 'tourist' ? 1.1 : 1)) {
      w.fear = Math.max(w.fear, DODGE_TIME);

      const ax = w.x - car.x, ay = w.y - car.y;
      const ad = Math.hypot(ax, ay) || 1;
      let ex = ax / ad, ey = ay / ad;

      // Blend "away from the car" with "square to its heading": backing
      // straight down the lane keeps you in the way, stepping aside does not.
      const hx = Math.cos(car.angle ?? 0), hy = Math.sin(car.angle ?? 0);
      let px = -hy, py = hx;
      if (ex * px + ey * py < 0) { px = -px; py = -py; }
      // Remember which side they broke for, so the crowd parts one way.
      w.dodgeSide = ex * px + ey * py >= 0 ? 1 : -1;
      ex = ex * 0.55 + px * 0.45;
      ey = ey * 0.55 + py * 0.45;
      const n = Math.hypot(ex, ey) || 1;
      ex /= n; ey /= n;

      const close = clamp(1 - threat.d / RUN_FEAR, 0, 1);
      const force = (110 + 130 * close) * (threat.player ? 1.25 : 1) * reaction;
      w.pushX += ex * force * dt;
      w.pushY += ey * force * dt;
      w.offset = clamp(w.offset + ex * 10 * dt * reaction, -OFFSET_LIMIT, OFFSET_LIMIT);
      w.paused = 0;
      // A scare cancels the errand: nobody strolls to the park mid-dodge.
      if (w.gatherPhase !== 'idle') releaseSpot(w);
      return;
    }

    // Legacy reaction: a fast car within CAR_FEAR makes them flinch.
    if (threat.d < CAR_FEAR) {
      w.hurt = Math.max(w.hurt, 0.35);
      const ax = w.x - car.x, ay = w.y - car.y;
      const ad = Math.hypot(ax, ay) || 1;
      w.pushX += (ax / ad) * 95 * dt;
      w.pushY += (ay / ad) * 95 * dt;
      w.offset = clamp(w.offset + (ax / ad) * 14 * dt, -OFFSET_LIMIT, OFFSET_LIMIT);
    }
  }

  /* ---- gunfire: panic and fleeing ---------------------------------- */

  /*
   * A shot is not a moving threat, so it does not go through scanThreat. It is
   * a point event, gathered from whatever the rest of the game already
   * publishes:
   *   - bullets in flight (world.combat.bullets), counted once each, read at
   *     the point they were fired from;
   *   - an explicit log, world.gunshots / world.shots, of { x, y } reports;
   *   - an officer who has just pulled the trigger (world.police.officers[].lastShot),
   *     so police gunfire scatters the street too.
   * Nothing is invented when none of those exist: an empty list means a calm
   * street, exactly as before.
   */
  const counted = new WeakSet();

  function shotCarrier(world) {
    const log = Array.isArray(world?.gunshots) ? world.gunshots
      : Array.isArray(world?.shots) ? world.shots
        : null;
    return log;
  }

  function collectShots(world, out) {
    const bullets = Array.isArray(world?.combat?.bullets) ? world.combat.bullets : null;
    if (bullets) {
      for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        if (!b || counted.has(b)) continue;
        // Only a bullet still near its muzzle is news; one already halfway
        // down the street was reported frames ago.
        if ((b.travelled ?? 0) > 40) continue;
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        counted.add(b);
        out.push({ x: b.x, y: b.y, hostile: !!b.hostile });
      }
    }

    const log = shotCarrier(world);
    if (log) {
      for (let i = 0; i < log.length; i++) {
        const s = log[i];
        if (!s || s.counted) continue;
        if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        // An entry may carry a `t` (seconds); a stale one is not news.
        if (Number.isFinite(s.t) && clock - s.t > SHOT_REPEAT) continue;
        s.counted = true;
        out.push({ x: s.x, y: s.y, hostile: !!s.hostile });
      }
    }

    const officers = Array.isArray(world?.police?.officers) ? world.police.officers : null;
    if (officers) {
      for (let i = 0; i < officers.length; i++) {
        const o = officers[i];
        const shot = o?.lastShot;
        if (!shot || shot.counted) continue;
        if (!Number.isFinite(shot.x) || !Number.isFinite(shot.y)) continue;
        if (Number.isFinite(shot.t) && clock - shot.t > SHOT_REPEAT) continue;
        shot.counted = true;
        out.push({ x: shot.x, y: shot.y, hostile: true, officer: true });
      }
    }
  }

  /*
   * Start a panic in one walker. `source` is the muzzle position; the timer is
   * longer the closer the report was, and a courier already keyed up reacts
   * the fastest while a tourist with a camera freezes a beat longer.
   */
  function raisePanic(w, sx, sy, power = 1) {
    const d = distance(w.x, w.y, sx, sy);
    const near = clamp(1 - d / SHOT_RADIUS, 0, 1);
    const nerve = w.archetypeKey === 'courier' ? 1.12
      : w.archetypeKey === 'tourist' ? 0.82
        : 1;
    const span = randRange(SHOT_PANIC_MIN, SHOT_PANIC_MAX) * (0.7 + near * 0.6) * nerve * power;
    if (span <= w.panic) return false;

    w.panic = span;
    w.panicMax = Math.max(w.panicMax, span);
    w.panicX = sx;
    w.panicY = sy;
    w.panicKey = (Math.round(sx) << 16) ^ Math.round(sy);
    w.startle = Math.max(w.startle, 0.4 + near * 0.5);
    w.photo = 0;
    w.paused = 0;
    w.dash = 0;
    // Panic outranks every errand: drop the booking and the landmark.
    if (w.gatherPhase !== 'idle') releaseSpot(w);
    if (w.viewPhase !== 'idle') {
      w.viewPhase = 'idle';
      w.viewLinger = 0;
      w.viewTimer = randRange(LANDMARK_RELEASE, LANDMARK_RELEASE * 1.6);
    }
    return true;
  }

  /*
   * One frame of running from a shot. The crowd is loop-bound, so "run away"
   * means running the loop in whichever direction puts more pavement between
   * them and the muzzle; a walker mid-crossing is put back on the kerb first
   * rather than left standing in the road with a gun going off.
   */
  function stepPanic(w, dt) {
    if (w.panic <= 0) return false;

    if (w.cross) {
      finishCross(w);
      w.crossCooldown = Math.max(w.crossCooldown, 2.5);
    }

    const sx = w.panicX, sy = w.panicY;
    const len = w.length;
    const eps = Math.max(6, Math.min(40, len * 0.02));
    const ahead = loopPoint(w.route, len, w.s + eps);
    const behind = loopPoint(w.route, len, w.s - eps);
    const dAhead = distance(ahead.x, ahead.y, sx, sy);
    const dBehind = distance(behind.x, behind.y, sx, sy);
    // If both ends are equally far the walker keeps its own direction and
    // simply sprints; a tie means the shot is dead abeam.
    if (dAhead !== dBehind) w.dirSign = dAhead >= dBehind ? 1 : -1;

    // Bolt away from the muzzle as well as along the wall, so the pavement
    // itself clears either side of the gun.
    const ax = w.x - sx, ay = w.y - sy;
    const ad = Math.hypot(ax, ay) || 1;
    const shove = SHOT_PANIC_KEEP * dt;
    w.pushX += (ax / ad) * shove;
    w.pushY += (ay / ad) * shove;

    // Stop running once they are far enough away to feel silly about it.
    if (distance(w.x, w.y, sx, sy) > SHOT_FLEE_CAP) {
      w.panic = Math.min(w.panic, SHOT_SETTLE * 0.5);
    }
    return true;
  }

  /* ---- landmark sightseeing ---------------------------------------- */

  /*
   * Camera tourists walk an errand to a named landmark and photograph it.
   * Phases mirror the park gathering — idle, approach, frame — but the pose is
   * a held lens rather than a loose knot, and the shutter is the existing
   * `photo` timer so the renderer needs nothing new.
   */
  function stepView(w, dt) {
    if (!w.viewSpot) return false;
    if (w.gatherPhase === 'approach' || w.gatherPhase === 'linger') return true;

    const spot = w.viewSpot;

    // A crossing can land the walker on another block, where the old
    // viewpoint is no longer on the pavement it walks: re-home the errand.
    if (spot.route !== w.route) {
      w.viewSpot = nearestView(w.route, w.s, w.x, w.y);
      w.viewPhase = 'idle';
      w.viewLinger = 0;
      w.viewTimer = randRange(LANDMARK_DELAY_MIN, LANDMARK_DELAY_MAX);
      if (!w.viewSpot) return false;
      return true;
    }

    if (w.viewPhase === 'idle') {
      w.viewTimer -= dt;
      if (w.viewTimer > 0) return false;
      // Re-home the errand if the walker crossed onto another block.
      if (spot.route !== w.route) {
        w.viewSpot = nearestView(w.route, w.s, w.x, w.y);
        w.viewTimer = randRange(3, 12);
        return false;
      }
      w.viewPhase = 'approach';
      return true;
    }

    if (w.viewPhase === 'approach') {
      const len = w.length;
      let delta = ((spot.s - w.s) % len + len) % len;
      if (delta > len / 2) delta -= len;
      w.dirSign = delta >= 0 ? 1 : -1;
      // Do not wander into traffic on the way to the viewpoint.
      w.crossCooldown = Math.max(w.crossCooldown, 1.5);
      const standing = distance(w.x, w.y, spot.x, spot.y);
      if (Math.abs(delta) <= LANDMARK_ARRIVE && standing <= SNAPSHOT_RANGE) {
        w.viewPhase = 'frame';
        w.viewLinger = randRange(LANDMARK_LINGER_MIN, LANDMARK_LINGER_MAX);
        w.viewYaw = Math.atan2(spot.y - w.y, spot.x - w.x);
        w.photoCooldown = 0;
        w.speed = 0;
      }
      return true;
    }

    // frame: hold still, aim the lens, take the shot on the cooldown.
    w.viewYaw = Math.atan2(spot.y - w.y, spot.x - w.x) +
      Math.sin(clock * 0.9 + w.wavePhase) * 0.03 * SNAPSHOT_SWAY;
    w.viewLinger -= dt;
    if (w.viewLinger <= 0) {
      w.viewPhase = 'idle';
      w.viewShots = 0;
      w.viewTimer = randRange(LANDMARK_RELEASE, LANDMARK_RELEASE * 2);
      w.viewSpot = nearestView(w.route, w.s, w.x, w.y);
      return false;
    }
    return true;
  }

  /* ---- gathering -------------------------------------------------- */

  /*
   * Three phases: idle (waiting for the appointment), approach (walking the
   * loop to the spot) and linger (standing in the knot). StepWalk keeps the
   * body on the pavement throughout; this only steers the arc and the pose.
   */
  function stepGather(w, dt) {
    if (!gatherSpots.length) return false;

    if (w.gatherSpot && w.gatherSpot.route !== w.route) {
      releaseSpot(w);
      w.gatherSpot = nearestGatherSpot(w.route, w.s);
    }
    if (!w.gatherSpot) return false;

    if (w.cross || w.fear > 0 || w.hurt > 0) {
      if (w.gatherPhase !== 'idle') releaseSpot(w);
      return false;
    }

    if (w.gatherPhase === 'idle') {
      w.gatherTimer -= dt;
      if (w.gatherTimer > 0) return false;
      const spot = w.gatherSpot;
      if (spot.occupants >= spot.capacity) {
        w.gatherTimer = randRange(3, 9);
        return false;
      }
      w.gatherPhase = 'approach';
      return true;
    }

    const spot = w.gatherSpot;

    if (w.gatherPhase === 'approach') {
      const len = w.length;
      let delta = ((spot.s - w.s) % len + len) % len;
      if (delta > len / 2) delta -= len;
      w.dirSign = delta >= 0 ? 1 : -1;
      // Don't wander into the road on the way to the bench.
      w.crossCooldown = Math.max(w.crossCooldown, 1.5);
      if (Math.abs(delta) <= GATHER_ARRIVE) {
        w.gatherPhase = 'linger';
        w.gatherLinger = randRange(GATHER_LINGER_MIN, GATHER_LINGER_MAX);
        spot.occupants = Math.min(spot.capacity, spot.occupants + 1);
        w.paused = 0;
        w.speed = 0;
      }
      return true;
    }

    // linger
    w.gatherLinger -= dt;
    w.gatherSway += dt * randRange(0.4, 0.9);
    if (w.gatherLinger <= 0) {
      releaseSpot(w);
      w.gatherSpot = nearestGatherSpot(w.route, w.s);
      w.gatherTimer = randRange(GATHER_RELEASE, GATHER_RELEASE * 2);
      return false;
    }
    return true;
  }

  /* ---- photography ------------------------------------------------- */

  function photoYaw(w) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < parkList.length; i++) {
      const p = parkList[i];
      const d2 = (p.cx - w.x) ** 2 + (p.cy - w.y) ** 2;
      if (d2 < bestD) { bestD = d2; best = p; }
    }
    if (best && bestD < 420 * 420) return Math.atan2(best.cy - w.y, best.cx - w.x);
    // Nothing green nearby: shoot the sea instead.
    const wx = Number.isFinite(city?.water?.x) ? city.water.x : w.x + 300;
    const wy = Number.isFinite(city?.height) ? city.height * 0.5 : w.y;
    return Math.atan2(wy - w.y, wx - w.x);
  }

  /* ---- movement --------------------------------------------------- */

  function stepWalk(w, dt, decay, pace) {
    w.speed += (pace - w.speed) * Math.min(1, 3.2 * dt);
    if (pace === 0 && w.speed < 0.4) w.speed = 0;

    w.s += w.speed * w.dirSign * dt;
    w.walkPhase += w.speed * dt * 0.32 * w.tempo;

    w.pushX *= decay;
    w.pushY *= decay;
    clampPush(w);
    placeOnLoop(w);
    settle(w);
    w.onRoad = false;

    // Reached a corner with pavement on the far side of a road? Then maybe
    // use the crossing — unless an errand is steering them elsewhere.
    if (!w.cross && w.crossCooldown <= 0 && w.speed > 2 && w.gatherPhase !== 'approach' &&
        rand() < w.crossChance * dt * 6) {
      if (findCrossing(w)) startCrossing(w);
    }
  }

  function stepCross(w, dt, decay, pace, world) {
    const c = w.cross;

    if (c.phase === 'wait') {
      c.wait -= dt;
      // ease from wherever we were up to the kerb corner
      const k = clamp(1 - c.wait / Math.max(1e-3, c.waitTotal), 0, 1);
      const e = k * k * (3 - 2 * k);
      w.lx = lerp(c.ax, c.x0, e);
      w.ly = lerp(c.ay, c.y0, e);
      w.facing = c.dir;
      w.speed += (0 - w.speed) * Math.min(1, 6 * dt);
      w.walkPhase += dt * 1.1;
      w.onRoad = false;
      w.pushX *= decay;
      w.pushY *= decay;
      clampPush(w);
      settle(w);
      if (c.wait <= 0) {
        // Kerbside check: hold for traffic on the band, but not forever.
        if (c.held < CROSS_PATIENCE && crossingBusy(w, world)) {
          c.held += CROSS_RECHECK;
          c.wait = CROSS_RECHECK;
          c.waitTotal = Math.max(c.waitTotal, CROSS_RECHECK);
        } else {
          c.phase = 'walk';
        }
      }
      return;
    }

    const target = Math.max(pace, w.cruise * 0.8) * CROSS_SPEED;
    w.speed += (target - w.speed) * Math.min(1, 4.5 * dt);
    c.t += (w.speed * dt) / Math.max(1, c.dist);

    const t = clamp(c.t, 0, 1);
    // Sideways scatter fades in and out, so entry and exit land on the corner.
    const lane = c.lane * Math.sin(Math.PI * t);
    w.lx = lerp(c.x0, c.x1, t) - c.uy * lane;
    w.ly = lerp(c.y0, c.y1, t) + c.ux * lane;
    w.facing = c.dir;
    w.walkPhase += w.speed * dt * 0.32 * w.tempo;
    w.onRoad = true;

    w.pushX *= decay;
    w.pushY *= decay;
    clampPush(w);
    settle(w);

    if (c.t >= 1) finishCross(w);
  }

  /* ---- mutual spacing -------------------------------------------- */

  function separate(dt) {
    const reach = SEPARATION * SEPARATION;
    for (let i = 0; i < crowd.length; i++) {
      const a = crowd[i];
      if (dead(a) || a.down > 0) continue;
      for (let j = i + 1; j < crowd.length; j++) {
        const b = crowd[j];
        if (dead(b) || b.down > 0) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx > SEPARATION || dx < -SEPARATION || dy > SEPARATION || dy < -SEPARATION) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= reach || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (SEPARATION - d) * SEPARATION_GAIN * dt;
        const ux = dx / d, uy = dy / d;
        a.pushX -= ux * push;
        a.pushY -= uy * push;
        b.pushX += ux * push;
        b.pushY += uy * push;
      }
    }
  }

  /* ---- public update --------------------------------------------- */

  function update(dt, world) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepSize = Math.min(dt, 0.1);
    clock += stepSize;

    const player = world?.player;
    const decay = Math.max(0, 1 - RECOVER * stepSize);

    /*
     * Gunfire is resolved once for the whole crowd, before anyone steps: each
     * fresh report reaches every walker inside its radius, dropped off with
     * distance. A report is also passed to walkers already panicking nearby,
     * so the street spreads the scare outward a little instead of a neat
     * circle of statues.
     */
    const shots = [];
    collectShots(world, shots);
    if (shots.length) {
      for (let s = 0; s < shots.length; s++) {
        const shot = shots[s];
        const radius = shot.hostile ? SHOT_RADIUS_CAR : SHOT_RADIUS;
        for (let i = 0; i < crowd.length; i++) {
          const w = crowd[i];
          if (dead(w) || w.down > 0) continue;
          const d = distance(w.x, w.y, shot.x, shot.y);
          if (d > radius) continue;
          // 1 at the muzzle, ~0.35 at the rim: a far shot still scatters.
          raisePanic(w, shot.x, shot.y, 0.35 + 0.65 * clamp(1 - d / radius, 0, 1));
        }
      }
    }

    for (let i = 0; i < crowd.length; i++) {
      const w = crowd[i];

      if (dead(w)) {
        w.down = true;
        w.speed = 0;
        w.state = PED_STATES.DOWN;
        continue;
      }

      if (w.down > 0) {
        w.down = Math.max(0, w.down - stepSize);
        w.speed = 0;
        w.state = PED_STATES.DOWN;
        if (w.down === 0) w.hurt = HURT_TIME;
        continue;
      }

      if (w.hurt > 0) w.hurt = Math.max(0, w.hurt - stepSize);
      if (w.stagger > 0) w.stagger = Math.max(0, w.stagger - stepSize);
      if (w.fear > 0) w.fear = Math.max(0, w.fear - stepSize);
      if (w.panic > 0) w.panic = Math.max(0, w.panic - stepSize);
      if (w.startle > 0) w.startle = Math.max(0, w.startle - stepSize);
      if (w.crossCooldown > 0) w.crossCooldown = Math.max(0, w.crossCooldown - stepSize);
      if (w.photo > 0) w.photo = Math.max(0, w.photo - stepSize);
      if (w.photoCooldown > 0) w.photoCooldown = Math.max(0, w.photoCooldown - stepSize);

      // District pacing follows the walker as they migrate between blocks.
      const zk = zoneKeyAt(w.x, w.y);
      if (zk !== w.zoneKey) {
        w.zoneKey = zk;
        w.zone = zk;
        w.zoneSpeed = (PED_ZONES[zk] ?? PED_ZONES.unknown).speed * w.zoneJitter;
      }

      const threat = scanThreat(w, world);
      if (threat) reactToThreat(w, threat, stepSize);

      // Companionship with the player: shuffle aside, don't get shoved. This
      // runs whether or not the player is in a car, exactly as before, so a
      // car rolling through the crowd still parts it gently.
      if (player) {
        const pdx = w.x - player.x, pdy = w.y - player.y;
        const d2 = pdx * pdx + pdy * pdy;
        if (d2 < PERSONAL * PERSONAL && d2 > 0.01) {
          const d = Math.sqrt(d2) || 1;
          const side = w.offset >= 0 ? 1 : -1;
          if (!w.cross) w.offset = clamp(w.offset + side * 18 * stepSize, -OFFSET_LIMIT, OFFSET_LIMIT);
          w.pushX += (pdx / d) * 12 * stepSize;
          w.pushY += (pdy / d) * 12 * stepSize;
        }
      }

      // Window-shopping breaks, only while simply walking the pavement. A
      // walker fleeing gunfire has no interest in a shop window.
      if (!w.cross && w.gatherPhase !== 'approach' && w.panic <= 0) {
        w.idleIn -= stepSize;
        if (w.idleIn <= 0) {
          if (w.paused <= 0 && w.fear <= 0 && rand() < w.pauseChance) {
            w.paused = randRange(1.4, 4.2);
          }
          w.idleIn = randRange(IDLE_MIN, IDLE_MAX);
        }
      }

      // Errands stand down while the street is running: a panicking walker
      // drops the park booking and the landmark view (raisePanic already did)
      // and simply legs it.
      if (w.panic <= 0) {
        stepGather(w, stepSize);
        stepView(w, stepSize);
      }

      let pace = w.cruise * (1 + w.waveAmp * Math.sin(clock * w.waveRate + w.wavePhase));
      pace *= w.zoneSpeed;

      if (w.paused > 0) { w.paused = Math.max(0, w.paused - stepSize); pace = 0; }
      if (w.hurt > 0) pace *= 1.9;
      if (w.stagger > 0) pace *= 0.2;
      if (w.fear > 0) pace = Math.max(pace, w.cruise * RUN_BOOST);
      if (w.photo > 0) pace = 0;
      if (w.gatherPhase === 'linger') pace = 0;

      // Gunfire panic outranks every other pose: pick the escape direction
      // along the loop and sprint, with a little extra while still startled.
      if (w.panic > 0) {
        stepPanic(w, stepSize);
        pace = Math.max(pace, w.cruise * SHOT_SPRINT);
        if (w.startle > 0) pace *= 1 + clamp(w.startle, 0, 1) * 0.22;
      } else if (w.startle > 0) {
        // Coming down: a nervous glance back over the shoulder, no sprint.
        pace *= 0.85;
      }

      // Framing a landmark: stand still, lens up, let the shutter fire.
      if (w.viewPhase === 'frame' && w.panic <= 0) pace = 0;

      // Couriers run their errands: a few seconds of hurry, then a breather.
      if (w.archetypeKey === 'courier' && w.fear <= 0 && w.panic <= 0 && w.gatherPhase === 'idle') {
        if (w.dash > 0) {
          w.dash = Math.max(0, w.dash - stepSize);
          pace *= COURIER_DASH;
        } else {
          w.dashIn -= stepSize;
          if (w.dashIn <= 0) {
            w.dash = randRange(COURIER_DASH_MIN, COURIER_DASH_MAX);
            w.dashIn = randRange(COURIER_DASH_GAP_MIN, COURIER_DASH_GAP_MAX);
          }
        }
      }

      if (w.cross) {
        stepCross(w, stepSize, decay, pace, world);
        if (w.cross) w.state = w.cross.phase === 'wait' ? PED_STATES.WAIT : PED_STATES.CROSS;
        else w.state = PED_STATES.WALK;
      } else {
        stepWalk(w, stepSize, decay, pace);
        w.state = w.panic > 0 ? PED_STATES.FLEE
          : w.fear > 0 ? PED_STATES.DODGE
            : PED_STATES.WALK;
      }

      // Poses that outrank plain walking: standing in the knot, shooting a
      // photo. Both re-aim the body after placeOnLoop has had its say.
      if (w.gatherPhase === 'linger' && w.gatherSpot) {
        w.state = PED_STATES.GATHER;
        w.gatherSway += stepSize * 0.7;
        w.offset = clamp(w.anchorOffset + Math.sin(w.gatherSway) * GATHER_SWAY, -OFFSET_LIMIT, OFFSET_LIMIT);
        w.lx += -Math.sin(w.facing) * 0; // reserved: the knot keeps to the loop
        const toPark = Math.atan2(w.gatherSpot.y - w.y, w.gatherSpot.x - w.x);
        turnFacing(w, toPark, 3 * stepSize);
      }

      // Landmark sightseeing: the walker plants itself at the viewpoint, aims
      // the lens at the landmark and takes its picture. The shutter reuses the
      // existing `photo` timer, so the renderer needs no new field.
      if (w.viewPhase === 'frame' && w.panic <= 0 && w.viewSpot) {
        w.state = PED_STATES.SIGHTSEE;
        w.offset = clamp(w.anchorOffset + Math.sin(clock * 0.7 + w.wavePhase) * 0.6, -OFFSET_LIMIT, OFFSET_LIMIT);
        turnFacing(w, w.viewYaw, 3.5 * stepSize);
        if (w.photo <= 0 && w.photoCooldown <= 0 && w.fear <= 0 &&
            rand() < PHOTO_CHANCE * stepSize) {
          w.photo = randRange(PHOTO_TIME_MIN, PHOTO_TIME_MAX);
          w.photoYaw = w.viewYaw;
          w.photoCooldown = randRange(PHOTO_COOLDOWN_MIN, PHOTO_COOLDOWN_MAX);
          w.viewShots++;
        }
      }

      // Tourists stop to photograph whatever is worth photographing.
      if (w.camera && w.photo <= 0 && w.photoCooldown <= 0 && w.fear <= 0 && w.panic <= 0 &&
          w.viewPhase !== 'frame' &&
          (w.paused > 0 || w.gatherPhase === 'linger') &&
          rand() < PHOTO_CHANCE * stepSize) {
        w.photo = randRange(PHOTO_TIME_MIN, PHOTO_TIME_MAX);
        w.photoYaw = photoYaw(w);
        w.photoCooldown = randRange(PHOTO_COOLDOWN_MIN, PHOTO_COOLDOWN_MAX);
        w.state = PED_STATES.PHOTO;
      }
      if (w.photo > 0) {
        w.state = w.viewPhase === 'frame' ? PED_STATES.SIGHTSEE : PED_STATES.PHOTO;
        turnFacing(w, w.photoYaw, 4 * stepSize);
      }
    }

    separate(stepSize);
  }

  /* ---- knockdown -------------------------------------------------- */

  function knockAt(x, y, radius) {
    let best = null, bestD = radius * radius;
    for (let i = 0; i < crowd.length; i++) {
      const w = crowd[i];
      if (dead(w) || w.down > 0) continue;
      const d2 = (w.x - x) ** 2 + (w.y - y) ** 2;
      if (d2 < bestD) { bestD = d2; best = w; }
    }
    if (!best) return null;
    // Someone hit mid-crossing keeps the ground they gained.
    if (best.cross) finishCross(best);
    releaseSpot(best);
    // A body on the ground is not running anywhere, nor framing a shot.
    best.viewPhase = 'idle';
    best.viewLinger = 0;
    best.panic = 0;
    best.startle = 0;
    best.down = DOWN_TIME;
    best.hurt = DOWN_TIME;
    best.speed = 0;
    best.fear = 0;
    best.paused = 0;
    best.photo = 0;
    best.dash = 0;
    best.state = PED_STATES.DOWN;
    return best;
  }

  /*
   * Public: start a gunfire panic at (x, y) without waiting for a bullet to be
   * found. The shell (or a mission script, or a sound event) can call this
   * directly; a radius is optional and only narrows the area that hears it.
   */
  function startle(x, y, radius = SHOT_RADIUS) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const reach = Number.isFinite(radius) && radius > 0 ? radius : SHOT_RADIUS;
    let hit = 0;
    for (let i = 0; i < crowd.length; i++) {
      const w = crowd[i];
      if (dead(w) || w.down > 0) continue;
      const d = distance(w.x, w.y, x, y);
      if (d > reach) continue;
      if (raisePanic(w, x, y, 0.35 + 0.65 * clamp(1 - d / reach, 0, 1))) hit++;
    }
    return hit;
  }

  /* ---- additive diagnostics --------------------------------------- */

  function stats() {
    const out = {
      total: crowd.length,
      walk: 0, wait: 0, cross: 0, dodge: 0, down: 0, gather: 0, photo: 0,
      flee: 0, sightsee: 0,
      crossings: 0, linger: 0, panic: 0, views: 0,
    };
    for (let i = 0; i < crowd.length; i++) {
      const w = crowd[i];
      if (w.state === PED_STATES.DOWN) out.down++;
      else if (w.state === PED_STATES.CROSS) out.cross++;
      else if (w.state === PED_STATES.WAIT) out.wait++;
      else if (w.state === PED_STATES.DODGE) out.dodge++;
      else if (w.state === PED_STATES.GATHER) out.gather++;
      else if (w.state === PED_STATES.PHOTO) out.photo++;
      else if (w.state === PED_STATES.FLEE) out.flee++;
      else if (w.state === PED_STATES.SIGHTSEE) out.sightsee++;
      else out.walk++;
      if (w.gatherPhase === 'linger') out.linger++;
      if (w.panic > 0) out.panic++;
      if (w.viewPhase === 'frame') out.views++;
      out.crossings += w.crossings;
    }
    return out;
  }

  function archetypeCounts() {
    const out = {};
    for (let i = 0; i < PED_ARCHETYPES.length; i++) out[PED_ARCHETYPES[i].key] = 0;
    for (let i = 0; i < crowd.length; i++) {
      const key = crowd[i].archetypeKey;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  return {
    list: crowd,
    update,
    knockAt,
    count: () => crowd.length,
    stats,
    crossings: () => crossingEntries.length,

    // additive: district/livelihood views of the same crowd
    density: (source = city) => districtDensity(crowd, source),
    archetypes: archetypeCounts,

    // additive: gunfire panic, callable from the shell or a mission script
    startle,
    panicking: () => crowd.reduce((n, w) => n + (w.panic > 0 ? 1 : 0), 0),

    // additive: the landmark viewpoints the tourists work from
    landmarks: () => allViews().map((v) => ({
      id: v.id, kind: v.kind, label: v.label,
      x: v.x, y: v.y, view: v.view, standoff: v.standoff,
      loop: v.loop, arc: v.s,
    })),
    sightseers: () => crowd
      .filter((w) => w.viewPhase === 'frame')
      .map((w) => ({ spot: w.viewSpot?.label ?? null, shots: w.viewShots })),

    gatherSpots: () => gatherSpots.map((s) => ({
      id: s.id, kind: s.kind, x: s.x, y: s.y, district: s.district,
      capacity: s.capacity, occupants: s.occupants,
    })),
    routeFor: (w) => (w && w.routeKind ? {
      kind: w.routeKind, loop: w.loopIndex, length: w.length,
      district: w.zoneKey, arc: w.s,
    } : null),
  };
}
