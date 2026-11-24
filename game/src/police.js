/*
 * Wanted level & police response — heat, cruisers, PITs, roadblocks, spike
 * strips and the busted / wasted outcomes.
 *
 * Layout of this file:
 *   1. tuning and public constants
 *   2. heat: crimes, decay while hidden, star level
 *   3. cruisers: spawn placement, pursue / ram / PIT driving, unstick
 *   3b. roadblock pursuit: parked pairs that re-deploy as the chase passes
 *   3c. the radio: backup called when the wanted level climbs
 *   4. roadblocks and spike strips (high wanted levels)
 *   5. officers on foot, busted and wasted
 *   6. spawning & despawning, the per-frame update, public surface
 *
 * The shape the rest of the game already reads is honoured exactly:
 *   world.wanted           fractional 0..5 (HUD paints round() + partial star)
 *   world.police.cars[]    units, each a wrapper `{ car, role, ... }`
 *   world.police.officers[] walkers with x / y / facing / hp / walkPhase
 * Cruisers are ordinary `createTypedCar(..., 'cruiser', ..., 'police')`
 * bodies, so render / traffic / vehicles treat them like any other car
 * (traffic gives way when `car.siren === true` and the car is moving).
 *
 * Public surface: `createPolice(city, world, options)` plus the exported
 * tuning constants below. Nothing else in the game is modified.
 */

import { POLICE } from './config.js';
import { angleDelta, clamp, distance } from './utils.js';
import { createTypedCar, driveCar, moveCar } from './vehicles.js';

/* ------------------------------------------------------------------ */
/* 1. tuning and public constants                                      */
/* ------------------------------------------------------------------ */

export const WANTED_MIN = POLICE.minLevel;
export const WANTED_MAX = POLICE.maxLevel;
export const WANTED_HEAT_PER_LEVEL = POLICE.heatPerLevel;
export const WANTED_HEAT_MAX = POLICE.heatMax;
export const CRIME_HEAT = POLICE.heatGain;

export const OUTCOME_CLEAR = 'clear';
export const OUTCOME_BUSTED = 'busted';
export const OUTCOME_WASTED = 'wasted';

const CRUISER_COLOR = '#eef1f4';

/* Response tuning that is ours rather than config's. */
const AI = {
  leadTime: 0.55,          // seconds of target velocity the chase aims ahead by
  stuckSpeed: 22,          // below this a cruiser counts as stuck
  stuckTime: 2.2,          // seconds stuck before reversing out
  reverseTime: 1.1,        // seconds spent backing out
  separateGap: 46,         // cruisers this close ahead get off the throttle
  pitHold: 0.55,           // seconds a PIT attempt lasts
  pitReach: 30,            // contact distance at which the shove lands
  pitDamage: 4,            // body damage per landed PIT
  pitSlip: 62,             // lateral impulse added to the victim
  pitYaw: 0.13,            // yaw kick added to the victim
  roadblockCooldown: 16,   // seconds between roadblocks
  roadblockAhead: 360,     // metres of road ahead a roadblock is laid on
  roadblockSpread: 34,     // half-width of the cruiser pair
  roadblockChaseLead: 1.35, // how much further ahead a block goes once chased
  blockHoldRadius: 150,    // a parked block joins the chase inside this
  blockRearmAhead: 240,    // the player this far past a block re-arms it
  blockRearmAheadBehind: 120, // ... or this far behind the block's own nose
  blockRedeployCap: 3,     // times one block pair may be pulled forward
  blockRedeployGap: 8,     // seconds between a pair's two re-deployments
  interceptAhead: 300,     // metres ahead an intercept unit aims to arrive
  interceptReach: 74,      // this close to the point, it brakes into the road
  interceptSpeed: 0.6,     // fraction of the chase cap a rolling block crawls at
  interceptMinGap: 150,    // below this an intercept just chases normally
  backupDelay: 2.8,        // seconds between the radio call and the first car
  backupPerLevel: 1,       // reinforcements queued per star gained
  backupCap: 2,            // most cars a single call puts on the street
  backupCooldown: 9,       // seconds between backup calls
  backupDistance: 700,     // how far out a backup call is answered from
  backupOfficers: 2,       // officers riding along in a backup car
  backupMinLevel: 2,       // below this the radio stays quiet
  spikeCooldown: 13,
  spikeAhead: 150,
  spikeLife: 26,
  spikeDamage: 0.32,       // tyre damage a strip inflicts per crossing
  bustRadius: 34,          // on foot: an officer this close can make an arrest
  bustCarRadius: 56,       // in a car: a cruiser this close, once stopped
  bustTime: 1.4,           // seconds of pressure before the cuffs go on
  bustSpeed: 26,           // a car above this speed cannot be boxed in
  despawnDistance: 1650,   // units this far behind the player are retired
  wreckLinger: 7,          // seconds a wrecked cruiser stays as scenery
  officerSpeed: 108,
  officerReach: 26,
  /* Routing around the city blocks. A chase that only ever aims at the
   * player's bumper spends the whole pursuit grinding into the corner of a
   * building: the wall kills its speed, the unstick logic reverses it out,
   * and it noses straight back into the same corner. When the direct line is
   * walled off, a unit routes through the street grid instead. */
  detourStart: 26,         // the sightline is tested from this far ahead of the nose
  detourMinRadius: 10,     // circles smaller than this (lamps, kerbs) never block
  detourMinSide: 20,       // rects thinner than this never block
  routeHold: 0.9,          // seconds a street route is trusted before rebuilding
  offRoadSlack: 26,        // past the kerb by this much counts as off the road
  officerShootRange: 210,
  officerShootCd: 1.6,
  officerDamage: 7,
  searchSpeed: 96,         // patrol pace while sweeping for the player
};

/* ------------------------------------------------------------------ */
/* 2. heat, stars and decay                                            */
/* ------------------------------------------------------------------ */

function levelForHeat(heat) {
  if (!(heat > 0)) return 0;
  return clamp(Math.ceil(heat / POLICE.heatPerLevel), WANTED_MIN, WANTED_MAX);
}

/*
 * `createPolice(city, world, options)`.
 *
 *   options.police  overrides on POLICE (a resolveDifficulty preset drops in)
 *   options.rng     () => 0..1, so a seeded run places units reproducibly
 *   options.heatGain multiplier on every crime's heat
 *
 * The returned controller also accepts `(world, city)` argument order, since
 * either reads naturally at the call site.
 */
export function createPolice(city, world = {}, options = {}) {
  if (city && !Array.isArray(city.vx) && Array.isArray(world?.vx)) {
    const swap = city;
    city = world;
    world = swap;
  }
  const town = city ?? { vx: [0], hy: [0], width: 2000, height: 2000, spawn: { x: 0, y: 0 } };
  const T = { ...POLICE, ...(options.police ?? {}) };
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const heatGain = Number.isFinite(options.heatGain) ? options.heatGain : 1;

  const cars = [];
  const officers = [];
  const roadblocks = [];
  const spikes = [];

  const state = {
    heat: 0,
    level: 0,
    seen: false,
    calm: 0,
    spawnT: 0,
    blockT: 0,
    spikeT: 0,
    pitT: 0,
    bustT: 0,
    searchT: 0,
    airT: 0,
    nextId: 1,
    outcome: OUTCOME_CLEAR,
    stats: { crimes: 0, spawns: 0, despawns: 0, pits: 0, roadblocks: 0, spikes: 0, busts: 0, wrecks: 0 },

    /* --- backup / roadblock-pursuit bookkeeping (additive) ------------- */
    lastLevel: 0,       // level seen last frame, for "the level climbed" edges
    peakLevel: 0,       // highest level reached this spree
    backupT: 0,         // countdown to the next car answering the radio
    backupCd: 0,        // cooldown between radio calls
    backupQueue: 0,     // cars still owed from calls already made
    backupCalls: 0,     // how many times the radio has been keyed
    redeploys: 0,       // blocks pulled forward onto a running player
    intercepts: 0,      // blocks that rolled into an intercept instead of waiting
  };

  const police = world.police && typeof world.police === 'object' ? world.police : {};
  Object.assign(police, {
    cars,
    units: cars,             // alias: some readouts call them units
    officers,
    roadblocks,
    spikes,
    heat: 0,
    level: 0,
    wanted: 0,
    busted: false,
    wasted: false,
    air: false,
    outcome: OUTCOME_CLEAR,
    stats: state.stats,
  });
  world.police = police;

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  const playerOf = (w) => w?.player ?? null;
  // The thing the police actually pursue: the player's car, else the body.
  const bodyOf = (w) => {
    const p = playerOf(w);
    return p?.car ?? p ?? null;
  };

  function playerSpeed(w) {
    const p = playerOf(w);
    if (!p) return 0;
    if (p.car) return Math.abs(p.car.speed ?? 0);
    return Math.hypot(p.vx ?? 0, p.vy ?? 0);
  }

  function insideTown(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < 16 || y < 16 || x > (town.width ?? 1e9) - 16 || y > (town.height ?? 1e9) - 16) return false;
    if (typeof town.isWater === 'function' && town.isWater(x, y)) return false;
    return true;
  }

  // Snap a point onto the road grid; used by spawns, roadblocks and strips.
  function snapRoad(x, y) {
    const vx = town.vx ?? [];
    const hy = town.hy ?? [];
    let bx = x, by = y, bestX = Infinity, bestY = Infinity;
    for (let i = 0; i < vx.length; i++) {
      const d = Math.abs(vx[i] - x);
      if (d < bestX) { bestX = d; bx = vx[i]; }
    }
    for (let i = 0; i < hy.length; i++) {
      const d = Math.abs(hy[i] - y);
      if (d < bestY) { bestY = d; by = hy[i]; }
    }
    // Keep the coordinate whose road is nearer, and slide along the other.
    if (bestX <= bestY) return { x: bx, y, along: 'v' };
    return { x, y: by, along: 'h' };
  }

  /* ------------------------------------------------------------------ */
  /* 2b. driving lines: what a cruiser can actually see past              */
  /* ------------------------------------------------------------------ */

  /*
   * Liang-Barsky: does the segment cross the rect? Used instead of sampling
   * the corridor so a long thin wall cannot slip between probe points.
   */
  function segmentHitsRect(x1, y1, x2, y2, r) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return true;
  }

  /*
   * The first collider on the line from (x1,y1) to (x2,y2), ignoring the
   * small street furniture a car can clip without being stopped. Kerbs,
   * lamps and bollards are circles a few units across and bench-height
   * rects; a building face is metres thick. Filtering by size is what keeps
   * a cruiser from swerving around a lamp post it would have shrugged off.
   */
  function wallBetween(x1, y1, x2, y2) {
    if (typeof town?.collidersNear !== 'function') return null;
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
    const mx = (x1 + x2) * 0.5;
    const my = (y1 + y2) * 0.5;
    const reach = Math.hypot(x2 - x1, y2 - y1) * 0.5 + 4;
    for (const c of town.collidersNear(mx, my, reach)) {
      if (c.kind === 'circle') {
        if (!(c.r >= AI.detourMinRadius)) continue;
        // Cheap point-segment test; a circle this big is not going to be
        // missed by the distance check itself.
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 1e-9) t = clamp(((c.x - x1) * dx + (c.y - y1) * dy) / len2, 0, 1);
        const nx = x1 + dx * t;
        const ny = y1 + dy * t;
        const ex = c.x - nx;
        const ey = c.y - ny;
        if (ex * ex + ey * ey <= c.r * c.r) return c;
      } else {
        if (Math.min(c.w ?? 0, c.h ?? 0) < AI.detourMinSide) continue;
        if (segmentHitsRect(x1, y1, x2, y2, c)) return c;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 2c. the road graph: cruising the streets like a driver              */
  /* ------------------------------------------------------------------ */

  /*
   * The town is a grid of intersections at (vx[i], hy[j]) joined by straight
   * road segments. Almost every one of those segments is clear — the blocks
   * sit between them, not on them. So the honest way to get a cruiser around
   * a building is not to sniff a way past the wall, it is to send it down
   * the streets: route on the intersection graph and follow the corridor.
   *
   * The graph is built once per police controller and cached; the city is
   * static once built, so the segments never change under it.
   */
  let graph = null;

  function roadGraph() {
    if (graph) return graph;
    const vx = town.vx ?? [];
    const hy = town.hy ?? [];
    if (vx.length < 2 || hy.length < 2) { graph = { n: 0, cols: 0, rows: 0, link: [] }; return graph; }
    const cols = vx.length;
    const rows = hy.length;
    const n = cols * rows;
    // link[k] = node indices reachable in one street hop from k.
    const link = Array.from({ length: n }, () => []);
    const at = (i, j) => j * cols + i;

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = at(i, j);
        if (i + 1 < cols) {
          const x1 = vx[i], y1 = hy[j], x2 = vx[i + 1], y2 = hy[j];
          if (!wallBetween(x1, y1, x2, y2)) { link[k].push(at(i + 1, j)); link[at(i + 1, j)].push(k); }
        }
        if (j + 1 < rows) {
          const x1 = vx[i], y1 = hy[j], x2 = vx[i], y2 = hy[j + 1];
          if (!wallBetween(x1, y1, x2, y2)) { link[k].push(at(i, j + 1)); link[at(i, j + 1)].push(k); }
        }
      }
    }
    graph = { n, cols, rows, link, vx, hy };
    return graph;
  }

  // Nearest intersection to a point, as a graph node index.
  function roadNode(g, x, y) {
    if (!g?.n) return -1;
    let bi = 0, bj = 0, best = Infinity;
    for (let j = 0; j < g.rows; j++) {
      const dy = g.hy[j] - y;
      for (let i = 0; i < g.cols; i++) {
        const dx = g.vx[i] - x;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    return bj * g.cols + bi;
  }

  /*
   * A street route from the cruiser to just outside the target, as a list of
   * corner points. Breadth-first on a 48-node grid costs nothing, so it is
   * rebuilt on a short timer rather than tracked incrementally.
   */
  function roadRoute(car, tx, ty) {
    const g = roadGraph();
    if (!g?.n) return null;
    const start = roadNode(g, car.x, car.y);
    const goal = roadNode(g, tx, ty);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return null;   // same junction: let the driver handle it

    const prev = new Int32Array(g.n).fill(-1);
    const seen = new Uint8Array(g.n);
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const k = queue[head];
      if (k === goal) break;
      for (const nb of g.link[k]) {
        if (seen[nb]) continue;
        seen[nb] = 1;
        prev[nb] = k;
        queue.push(nb);
      }
    }
    if (!seen[goal]) return null;      // no street path (island edge): fall back

    const path = [];
    for (let k = goal; k !== -1; k = prev[k]) path.push(k);
    path.reverse();
    const pts = path.map((k) => ({ x: g.vx[k % g.cols], y: g.hy[(k / g.cols) | 0] }));
    return pts.length > 1 ? pts : null;
  }

  /*
   * Which corner to steer for: the last point on the route the cruiser can
   * actually see. Aiming at the next corner only makes it crawl junction to
   * junction; aiming at a far corner it can see down a straight road is what
   * a driver does. The final leg to the target is handled by the caller.
   */
  function followRoute(car, route) {
    if (!route?.length) return null;
    let pick = null;
    for (let i = 1; i < route.length; i++) {
      if (wallBetween(car.x, car.y, route[i].x, route[i].y)) break;
      pick = route[i];
    }
    if (!pick) pick = route[Math.min(1, route.length - 1)];
    return pick;
  }

  /*
   * How far the car is off the carriageway, and the nearest point that is
   * back on it.
   *
   * A cruiser can be shoved into the middle of a block: a PIT, a pile-up at a
   * junction, clipping a corner at speed. Once it is in there the street
   * route is useless — the nearest intersection is on the far side of the
   * building it is pressed against, and every leg of the route runs through
   * a wall. The one thing that always works from there is to get back to the
   * road first and route afterwards, so this is checked before the route.
   */
  function roadEscape(x, y) {
    const vx = town.vx ?? [];
    const hy = town.hy ?? [];
    if (!vx.length || !hy.length) return null;
    let bx = x, by = y, bestX = Infinity, bestY = Infinity;
    for (let i = 0; i < vx.length; i++) {
      const d = Math.abs(vx[i] - x);
      if (d < bestX) { bestX = d; bx = vx[i]; }
    }
    for (let j = 0; j < hy.length; j++) {
      const d = Math.abs(hy[j] - y);
      if (d < bestY) { bestY = d; by = hy[j]; }
    }
    const half = (town.roadWidth ?? 86) * 0.5;
    const slack = AI.offRoadSlack;
    // Still on a road: nothing to escape.
    if (bestX <= half + slack || bestY <= half + slack) return null;
    // Off both: the shorter step back is along whichever axis is closer.
    if (bestX <= bestY) return { x: bx, y, d: bestX };
    return { x, y: by, d: bestY };
  }

  function sync(w) {
    const target = w ?? world;
    const level = levelForHeat(state.heat);
    state.level = level;
    const wanted = clamp(state.heat / POLICE.heatPerLevel, 0, WANTED_MAX);
    target.wanted = wanted;
    target.heat = state.heat;
    target.wantedLevel = level;
    police.heat = state.heat;
    police.level = level;
    police.wanted = wanted;
    police.busted = state.outcome === OUTCOME_BUSTED;
    police.wasted = state.outcome === OUTCOME_WASTED;
    police.outcome = state.outcome;
    police.air = state.airT > 0;
    return level;
  }

  function addHeat(amount) {
    const add = Number(amount);
    if (!Number.isFinite(add) || add <= 0) return state.heat;
    // Any fresh crime wakes the response and stops the cooling clock.
    state.heat = clamp(state.heat + add, 0, POLICE.heatMax);
    state.calm = 0;
    sync(world);
    return state.heat;
  }

  /*
   * Register a crime. `type` is a key of POLICE.heatGain (bump, hitPed,
   * gunshot, stealCar, propertyDamage, missionAlarm); an explicit number is
   * also accepted for anything the config does not name yet.
   */
  function crime(type = 'bump', amount) {
    const named = typeof type === 'number' ? type : CRIME_HEAT[type];
    const base = Number.isFinite(amount) ? amount : named;
    if (!Number.isFinite(base) || base <= 0) return state.heat;
    state.stats.crimes++;
    return addHeat(base * heatGain);
  }

  function setHeat(value) {
    const v = Number(value);
    state.heat = Number.isFinite(v) ? clamp(v, 0, POLICE.heatMax) : 0;
    if (state.heat <= 0) state.calm = 0;
    sync(world);
    return state.heat;
  }

  /* ------------------------------------------------------------------ */
  /* 3. cruisers                                                         */
  /* ------------------------------------------------------------------ */

  function spawnPoint(w, minD = T.spawnDistanceMin, maxD = T.spawnDistanceMax) {
    const at = bodyOf(w) ?? town.spawn ?? { x: 0, y: 0 };
    // Never drop a cruiser inside its own sight radius, or a hidden player
    // would be re-acquired by every reinforcement the moment it appears.
    const floorD = Math.max(minD, T.sightRangeChasing + 90);
    const hiD = Math.max(floorD + 40, maxD);
    for (let tries = 0; tries < 24; tries++) {
      const ang = rng() * Math.PI * 2;
      const d = floorD + rng() * (hiD - floorD);
      const p = snapRoad(at.x + Math.cos(ang) * d, at.y + Math.sin(ang) * d);
      if (!insideTown(p.x, p.y)) continue;
      const gap = distance(p.x, p.y, at.x, at.y);
      if (gap < floorD * 0.75) continue;
      return { x: p.x, y: p.y };
    }
    // Fallback: a grid intersection on the far side of town.
    const vx = town.vx ?? [at.x];
    const hy = town.hy ?? [at.y];
    const gx = vx[Math.floor(rng() * vx.length)] ?? at.x;
    const gy = hy[Math.floor(rng() * hy.length)] ?? at.y;
    return { x: gx, y: gy };
  }

  function addUnit(spot, role = 'pursue') {
    const at = bodyOf(world);
    const heading = at && Number.isFinite(at.x)
      ? Math.atan2(at.y - spot.y, at.x - spot.x)
      : 0;
    const car = createTypedCar(spot.x, spot.y, heading, 'cruiser', CRUISER_COLOR, 'police');
    car.siren = true;
    car.locked = false;
    car.ignition = true;
    car.cruise = T.chaseSpeedBase;

    const unit = {
      id: state.nextId++,
      car,
      role,
      mode: role === 'block' ? 'hold' : 'pursue',
      siren: true,
      stuckT: 0,
      reverseT: 0,
      pitT: 0,
      pitDir: 1,
      loseT: 0,
      life: 0,
      wreckT: 0,
      hp: car.health,
      target: null,

      /* additive: roadblock ownership and rolling-block bookkeeping */
      block: null,       // the roadblocks[] entry this cruiser was laid out for
      redeployT: 0,      // seconds until this pair may be pulled forward again
      intercept: false,  // true once it has left the kerb as a rolling block
      backup: false,     // true for a car answering a radio call

      /* routing around buildings (see roadRoute) */
      route: null,       // street corners to follow while the target is walled off
      routeT: 0,         // seconds before that route is rebuilt
    };
    cars.push(unit);
    state.stats.spawns++;
    return unit;
  }

  /*
   * Public spawn: one cruiser on the nearest piece of road at least
   * spawnDistanceMin away, unless an explicit spot is handed in.
   */
  function spawnUnit(spot, role = 'pursue') {
    const at = spot && Number.isFinite(spot.x) ? spot : spawnPoint(world);
    if (!insideTown(at.x, at.y)) return null;
    if (cars.length >= T.maxUnits) {
      // Never exceed the cap: retire the furthest unit first.
      let worst = null;
      let worstD = -1;
      for (const u of cars) {
        const d = u.role === 'block' ? -1 : distance(u.car.x, u.car.y, at.x, at.y);
        if (d > worstD) { worstD = d; worst = u; }
      }
      if (worst) despawnUnit(worst);
      if (cars.length >= T.maxUnits) return null;
    }
    return addUnit(at, role);
  }

  function despawnUnit(unit) {
    if (!unit) return false;
    const i = cars.indexOf(unit);
    if (i < 0) return false;
    cars.splice(i, 1);
    // Feet open a cruiser's doors: retire its officers with it.
    for (let k = officers.length - 1; k >= 0; k--) {
      if (officers[k].unit === unit) officers.splice(k, 1);
    }
    state.stats.despawns++;
    return true;
  }

  function cruiserCap(level) {
    // 1 star: a single unit, then two per star up to maxUnits.
    return clamp(level <= 0 ? 0 : level + 1, 0, T.maxUnits);
  }

  function speedCap(level) {
    return T.chaseSpeedBase + T.chaseSpeedPerLevel * Math.max(0, level - 1);
  }

  /* Pure aim: the steer and throttle a cruiser wants, without applying it,
     so updateUnit can fold in separation and speed-cap rules and then call
     driveCar exactly once per frame. */
  function aimToward(car, tx, ty, brake = 0, cap = Infinity) {
    const want = Math.atan2(ty - car.y, tx - car.x);
    const delta = angleDelta(car.angle, want);
    const dist = distance(car.x, car.y, tx, ty);
    const steer = clamp(delta * 2.4, -1, 1);
    let throttle = 1;
    if (Number.isFinite(cap) && Math.abs(car.speed ?? 0) > cap) throttle = -0.25;
    if (brake > 0 && dist < brake) throttle = 0;
    if (Math.abs(delta) > 1.5 && Math.abs(car.speed ?? 0) > 120) throttle = 0;
    return { steer, throttle, dist, delta };
  }

  function driveToward(car, tx, ty, dt, brake = 0, cap = Infinity) {
    const aim = aimToward(car, tx, ty, brake, cap);
    driveCar(car, aim.throttle, aim.steer, false, dt);
    return aim;
  }

  /*
   * A PIT: pull alongside the fleeing car's rear quarter, then shove the
   * tail out. The chase settles behind and slightly to one side first, so
   * the manoeuvre reads as deliberate rather than a random sideswipe.
   */
  function tryPit(unit, victim, dt, level) {
    const car = unit.car;
    if (!victim || !Number.isFinite(victim.x) || car.wrecked) return false;
    if (level < 2) return false;

    if (unit.pitT > 0) {
      unit.pitT = Math.max(0, unit.pitT - dt);
      const side = unit.pitDir;
      const fx = Math.cos(victim.angle ?? 0);
      const fy = Math.sin(victim.angle ?? 0);
      const px = -fy * side;
      const py = fx * side;
      const aimX = victim.x - fx * 26 + px * 12;
      const aimY = victim.y - fy * 26 + py * 12;
      driveToward(car, aimX, aimY, dt);
      const gap = distance(car.x, car.y, victim.x, victim.y);
      if (gap < AI.pitReach) {
        victim.slip = clamp((victim.slip ?? 0) + side * AI.pitSlip, -220, 220);
        victim.angle = (victim.angle ?? 0) + side * AI.pitYaw;
        victim.health = Math.max(0, (victim.health ?? 100) - AI.pitDamage);
        victim.lastHit = 1;
        unit.pitT = 0;
        unit.ramT = T.ramCooldown;
        state.stats.pits++;
        return true;
      }
      return true;
    }

    // Look for the right geometry: behind, roughly alongside, both moving.
    const relX = victim.x - car.x;
    const relY = victim.y - car.y;
    const fx = Math.cos(car.angle);
    const fy = Math.sin(car.angle);
    const ahead = relX * fx + relY * fy;
    const lateral = relX * -fy + relY * fx;
    const closing = (victim.speed ?? 0) > 40;
    if (!closing) return false;
    if (ahead < 4 || ahead > T.pitDistance * 2.6) return false;
    if (Math.abs(lateral) > T.pitDistance) return false;

    const side = lateral >= 0 ? -1 : 1;
    unit.pitT = AI.pitHold;
    unit.pitDir = side;
    // Aim at the victim's rear quarter on our side to line the hit up.
    const px = -Math.sin(victim.angle ?? 0) * side;
    const py = Math.cos(victim.angle ?? 0) * side;
    driveToward(car, victim.x - Math.cos(victim.angle ?? 0) * 26 + px * 10,
      victim.y - Math.sin(victim.angle ?? 0) * 26 + py * 10, dt);
    return true;
  }

  function updateUnit(unit, dt, level, target, w) {
    const car = unit.car;
    unit.life += dt;

    if (car.wrecked) {
      unit.wreckT += dt;
      car.siren = false;
      return;
    }

    // Blockers sit still until the player is close, then join the chase.
    if (unit.role === 'block' && unit.mode === 'hold') {
      driveCar(car, 0, 0, true, dt);
      if (!target) return;
      if (distance(car.x, car.y, target.x, target.y) < AI.blockHoldRadius) unit.mode = 'pursue';
      return;
    }

    // A rolling block: drive to the mark on the player's line, brake hard into
    // it, and only then join the chase. If it gets there with time to spare it
    // turns across the carriageway so the road is closed, not just occupied.
    if (unit.mode === 'intercept') {
      const mk = unit.block;
      unit.interceptT = Math.max(0, (unit.interceptT ?? 10) - dt);
      // A mark the player has long since left is not worth holding: fall in
      // behind the chase rather than man a junction nobody is coming to.
      if (unit.interceptT <= 0) {
        unit.mode = 'pursue';
        unit.intercept = false;
        return;
      }
      const mx = Number.isFinite(mk?.interceptX) ? mk.interceptX : target?.x;
      const my = Number.isFinite(mk?.interceptY) ? mk.interceptY : target?.y;
      if (!Number.isFinite(mx) || !Number.isFinite(my)) {
        unit.mode = 'pursue';
        unit.intercept = false;
      } else {
        const toMark = distance(car.x, car.y, mx, my);
        const cap = Math.max(90, speedCap(level) * AI.interceptSpeed);
        if (toMark > AI.interceptReach) {
          // Roll to the mark at a controlled pace — no ramming the junction.
          driveToward(car, mx, my, dt, AI.interceptReach, cap);
        } else {
          // On the mark: square up across the road, stop, and become a
          // stationary barrier again — the tactic then owns the pair.
          const want = Number.isFinite(mk?.angle) ? mk.angle : car.angle;
          const lock = clamp(angleDelta(car.angle, want) * 2.4, -1, 1);
          driveCar(car, Math.abs(car.speed ?? 0) > 30 ? -0.4 : 0, lock, true, dt);
          if (Math.abs(car.speed ?? 0) < 18) {
            unit.mode = 'hold';
            unit.intercept = false;
            unit.interceptT = 0;
          }
        }
        car.siren = level > 0;
        // If the player has already gone by, the mark is worthless: rejoin the
        // pursuit instead of rolling to a junction behind him.
        if (target && distance(car.x, car.y, target.x, target.y) < AI.blockHoldRadius * 0.8) {
          unit.mode = 'pursue';
          unit.intercept = false;
        }
        return;
      }
    }

    if (!target) {
      // No one to chase: sweep slowly back toward town centre.
      const cx = town.downtown?.x ?? (town.width ?? car.x) / 2;
      const cy = town.downtown?.y ?? (town.height ?? car.y) / 2;
      if (distance(car.x, car.y, cx, cy) > 260) driveToward(car, cx, cy, dt);
      else driveCar(car, 0, 0, false, dt);
      return;
    }

    // Stuck against scenery: reverse out with opposite lock.
    if (unit.reverseT > 0) {
      unit.reverseT -= dt;
      const back = Math.atan2(target.y - car.y, target.x - car.x) + Math.PI;
      const lock = clamp(angleDelta(car.angle, back) * 2, -1, 1);
      driveCar(car, -1, lock, false, dt);
      return;
    }

    const cap = speedCap(level);
    const gap = distance(car.x, car.y, target.x, target.y);

    // PIT first: a landed shove is this frame's whole manoeuvre.
    unit.ramT = Math.max(0, (unit.ramT ?? 0) - dt);
    if (level >= 2 && unit.ramT <= 0 && gap < T.ramDistance * 2.2) {
      if (tryPit(unit, target, dt, level)) return;
    }

    // Aim ahead of the target so a fast player is intercepted, not trailed.
    let aimX = target.x;
    let aimY = target.y;
    if (Math.abs(target.speed ?? 0) > 8) {
      const lead = clamp(gap / Math.max(120, cap), 0, 1.1) + AI.leadTime;
      aimX += Math.cos(target.angle ?? 0) * (target.speed ?? 0) * lead * 0.5;
      aimY += Math.sin(target.angle ?? 0) * (target.speed ?? 0) * lead * 0.5;
    }

    const brakeAt = unit.role === 'block' ? 90 : 46;

    /*
     * Drive the streets. A cruiser that can see the bumper goes straight at
     * it; one that cannot routes around the block on the intersection graph
     * and follows that route. Without this the unit noses into the wall, the
     * unstick logic reverses it out, and it noses straight back into the same
     * corner for the rest of the chase.
     */
    unit.routeT = Math.max(0, (unit.routeT ?? 0) - dt);
    const noseX = car.x + Math.cos(car.angle) * AI.detourStart;
    const noseY = car.y + Math.sin(car.angle) * AI.detourStart;
    const walled = wallBetween(noseX, noseY, aimX, aimY);

    if (!walled) {
      // Clear shot: drop any route and close in.
      unit.route = null;
      unit.routeT = 0;
    } else if (unit.routeT <= 0 || !unit.route) {
      unit.route = roadRoute(car, aimX, aimY);
      unit.routeT = AI.routeHold;
    }

    const corner = walled ? followRoute(car, unit.route) : null;
    // Wedged in a block: get back on the road before following any route.
    const escape = roadEscape(car.x, car.y);
    const aim = escape
      ? aimToward(car, escape.x, escape.y, 0, cap)
      : corner
        ? aimToward(car, corner.x, corner.y, 0, cap)
        : aimToward(car, aimX, aimY, brakeAt, cap);

    // Separation from other cruisers queuing on the same line.
    let blocked = false;
    for (const other of cars) {
      if (other === unit || other.car.wrecked) continue;
      const ox = other.car.x - car.x;
      const oy = other.car.y - car.y;
      const ahead = ox * Math.cos(car.angle) + oy * Math.sin(car.angle);
      const lat = Math.abs(ox * Math.sin(car.angle) - oy * Math.cos(car.angle));
      if (ahead > 0 && ahead < AI.separateGap && lat < 26) { blocked = true; break; }
    }

    driveCar(car, blocked ? 0 : aim.throttle, aim.steer, false, dt);

    // Stuck bookkeeping. Measured on ground actually covered, not on the
    // distance to the aim point: a car wedged on a building corner is aiming
    // at a point 30 units away, so an `aim.dist > 60` guard reads a wedged
    // car as "arrived" and never triggers the reverse-out at all.
    if (unit.lastX === undefined) { unit.lastX = car.x; unit.lastY = car.y; }
    const progress = distance(car.x, car.y, unit.lastX, unit.lastY);
    unit.lastX = car.x;
    unit.lastY = car.y;
    const creep = progress < AI.stuckSpeed * dt * 1.5;
    if (creep && !blocked && gap > 70) unit.stuckT += dt;
    else unit.stuckT = Math.max(0, unit.stuckT - dt * 2);
    if (unit.stuckT > AI.stuckTime) {
      unit.stuckT = 0;
      unit.reverseT = AI.reverseTime;
    }

    car.siren = level > 0;
  }

  /* ------------------------------------------------------------------ */
  /* 3b. roadblock pursuit                                               */
  /* ------------------------------------------------------------------ */

  /*
   * A roadblock is not scenery. The pair is laid across the road ahead of the
   * player, and when he goes past it the nearest open junction ahead is blocked
   * instead — the same pair, pulled forward, so the street keeps closing on
   * him. Two things a pair can do:
   *
   *   - RE-DEPLOY: the player has driven past. Snap a fresh spot onto the road
   *     he is now on, a few hundred metres out, and put the pair there. A pair
   *     that has already been moved `blockRedeployCap` times gives up blocking
   *     and joins the chase instead.
   *   - INTERCEPT: the player is still far out and closing fast. Rather than
   *     wait to be passed, the pair rolls off its spot toward a point on his
   *     line, then swings across the carriageway and stops. If it cannot get
   *     there in time it simply folds into the pursuit.
   */
  function snapBlockSpot(at, ahead) {
    const heading = at.angle ?? at.facing ?? 0;
    const spot = snapRoad(at.x + Math.cos(heading) * ahead, at.y + Math.sin(heading) * ahead);
    if (!insideTown(spot.x, spot.y)) return null;
    return spot;
  }

  function relocateBlock(entry, units, spot, face) {
    const across = spot.along === 'v' ? { x: 1, y: 0 } : { x: 0, y: 1 };
    entry.across = across;
    entry.axe = across.x;
    entry.aye = across.y;
    entry.along = spot.along;
    entry.x = spot.x;
    entry.y = spot.y;
    entry.angle = face;
    entry.t = 0;
    let side = -1;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const x = spot.x + across.x * AI.roadblockSpread * side;
      const y = spot.y + across.y * AI.roadblockSpread * side;
      side = side === -1 ? 1 : -1;
      if (!insideTown(x, y)) continue;
      unit.car.x = x;
      unit.car.y = y;
      unit.car.angle = face;
      unit.car.speed = 0;
      unit.car.slip = 0;
      unit.mode = 'hold';
      unit.intercept = false;
      unit.stuckT = 0;
      unit.reverseT = 0;
    }
    entry.redeploys++;
  }

  function stepBlockTactics(dt, w, level) {
    const at = bodyOf(w);
    if (!at) return;
    if (!roadblocks.length) return;

    const speed = playerSpeed(w);
    const moving = speed > 55;

    for (let i = 0; i < roadblocks.length; i++) {
      const entry = roadblocks[i];
      const live = [];
      for (let k = 0; k < entry.units.length; k++) {
        const unit = entry.units[k];
        if (!unit || !cars.includes(unit) || unit.car.wrecked) continue;
        live.push(unit);
      }
      if (!live.length) continue;

      let ready = true;
      for (let k = 0; k < live.length; k++) {
        const unit = live[k];
        unit.redeployT = Math.max(0, (unit.redeployT ?? 0) - dt);
        if (unit.redeployT > 0) ready = false;
      }
      if (!ready) continue;

      const gap = distance(at.x, at.y, entry.x, entry.y);

      // --- has he already gone past the barrier? ---------------------------
      // This is the primary tactic and it outranks the intercept: a pair that
      // is behind the player cannot cut him off, it can only set up the next
      // one. Distance-from-the-line plus a forward dot product tells us which.
      const dx = at.x - entry.x;
      const dy = at.y - entry.y;
      const fx = Math.cos(entry.angle);
      const fy = Math.sin(entry.angle);
      const along = dx * fx + dy * fy;      // + while he is still in front
      const lateral = Math.abs(dx * -fy + dy * fx);
      const passed = along < -AI.blockRearmAheadBehind ||
        (along < 30 && lateral < AI.roadblockSpread * 2.4 && gap < AI.blockRearmAheadBehind);

      if (passed) {
        if (entry.redeploys >= AI.blockRedeployCap) {
          // Out of road to jump to: peel off the mark and join the chase.
          for (let k = 0; k < live.length; k++) {
            live[k].mode = 'pursue';
            live[k].role = 'pursue';
            live[k].intercept = false;
            live[k].redeployT = 0;
          }
          continue;
        }
        const lead = clamp(AI.roadblockAhead * (moving ? AI.roadblockChaseLead : 0.85), 160, 720);
        const spot = snapBlockSpot(at, lead);
        if (!spot) continue;
        const face = Math.atan2(at.y - spot.y, at.x - spot.x);
        relocateBlock(entry, live, spot, face);
        entry.interceptX = undefined;
        entry.interceptY = undefined;
        state.redeploys++;
        state.stats.redeploys = (state.stats.redeploys ?? 0) + 1;
        for (let k = 0; k < live.length; k++) live[k].redeployT = AI.blockRedeployGap;
        continue;
      }

      // --- intercept: still in front, and closing fast ---------------------
      // A pair that is already rolling does not re-task every frame; it drives
      // its existing mark, squares up on arrival, then rejoins the barrier.
      let rolling = false;
      for (let k = 0; k < live.length; k++) if (live[k].mode === 'intercept') rolling = true;

      if (rolling) {
        // Arrived and stopped? Then the pair is a roadblock again, and the
        // next pass of this function will be free to re-deploy it.
        let settled = true;
        for (let k = 0; k < live.length; k++) {
          const unit = live[k];
          if (!unit.interceptT) continue;
          const onMark = gap < 60 || Math.abs(unit.car.speed ?? 0) > 40;
          if (unit.mode !== 'hold' && onMark) settled = false;
        }
        if (settled) {
          entry.x = Number.isFinite(entry.interceptX) ? entry.interceptX : entry.x;
          entry.y = Number.isFinite(entry.interceptY) ? entry.interceptY : entry.y;
          entry.interceptX = undefined;
          entry.interceptY = undefined;
          for (let k = 0; k < live.length; k++) {
            live[k].mode = 'hold';
            live[k].intercept = false;
            live[k].interceptT = 0;
            live[k].redeployT = Math.min(live[k].redeployT, 2);
          }
        }
        continue;
      }

      if (level >= T.roadblockLevel && moving && along > AI.roadblockSpread &&
          gap > AI.roadblockSpread + AI.interceptMinGap && gap < 1100) {
        const ahead = clamp(gap * 0.6, AI.interceptMinGap, AI.interceptAhead);
        const spot = snapBlockSpot(at, ahead);
        if (spot) {
          entry.interceptX = spot.x;
          entry.interceptY = spot.y;
          for (let k = 0; k < live.length; k++) {
            const unit = live[k];
            unit.mode = 'intercept';
            unit.intercept = true;
            unit.interceptT = 1;
            unit.redeployT = AI.blockRedeployGap;
            unit.stuckT = 0;
          }
          state.intercepts++;
          state.stats.intercepts = (state.stats.intercepts ?? 0) + 1;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3c. the radio: backup when the level climbs                          */
  /* ------------------------------------------------------------------ */

  /*
   * Each star gained keys the radio: a car or two roll in from the edge of the
   * response area rather than materialising beside the player, and they drive
   * to the place the call came from even before anyone has eyes on him. That
   * last part is the difference between reinforcements and teleporting police:
   * the units are handed the caller's position as `lastSeen`, which is exactly
   * the same stale-hint the pursuit already navigates by.
   */
  function callBackup(w, level) {
    if (state.backupCd > 0) return 0;
    if (level < AI.backupMinLevel) return 0;
    if (state.outcome !== OUTCOME_CLEAR) return 0;

    const gained = Math.max(1, level - (state.lastLevel || 0));
    const want = clamp(gained * AI.backupPerLevel, 1, AI.backupCap);
    const room = Math.max(0, T.maxUnits - cars.length - state.backupQueue);
    const take = Math.min(want, room);
    if (take <= 0) return 0;

    state.backupQueue += take;
    if (state.backupT <= 0) state.backupT = AI.backupDelay;
    state.backupCd = AI.backupCooldown;
    state.backupCalls++;
    state.stats.backups = (state.stats.backups ?? 0) + 1;
    return take;
  }

  function stepBackup(dt, w, level) {
    if (state.backupCd > 0) state.backupCd = Math.max(0, state.backupCd - dt);
    if (state.backupQueue <= 0) return;
    if (state.outcome !== OUTCOME_CLEAR || level < AI.backupMinLevel) {
      state.backupQueue = 0;
      return;
    }
    if (state.backupT > 0) {
      state.backupT = Math.max(0, state.backupT - dt);
      if (state.backupT > 0) return;
    }

    const spot = spawnPoint(w, T.spawnDistanceMin, AI.backupDistance);
    const unit = spawnUnit(spot, 'pursue');
    if (!unit) {
      // The street is full: hold the call and try again shortly.
      state.backupT = 1.4;
      return;
    }

    unit.backup = true;
    const at = bodyOf(w);
    if (at) unit.lastSeen = { x: at.x, y: at.y };
    // Riding two-up: the officers bail out where the car came in.
    for (let i = 0; i < AI.backupOfficers; i++) {
      const side = i === 0 ? -1 : 1;
      const x = spot.x + side * 18;
      const y = spot.y + side * 14;
      if (!insideTown(x, y)) continue;
      addOfficer(x, y, unit);
    }

    state.backupQueue = Math.max(0, state.backupQueue - 1);
    state.backupT = state.backupQueue > 0 ? AI.backupDelay * 0.65 : 0;
  }

  function resetResponse() {
    state.lastLevel = 0;
    state.peakLevel = 0;
    state.backupT = 0;
    state.backupCd = 0;
    state.backupQueue = 0;
  }

  /* ------------------------------------------------------------------ */
  /* 4. roadblocks & spike strips                                        */
  /* ------------------------------------------------------------------ */

  function placeRoadblock(w) {
    const at = bodyOf(w);
    if (!at) return null;
    const heading = at.angle ?? at.facing ?? 0;
    // A chase that is already running wants the block laid further out, so the
    // player meets it at speed rather than watching it appear at the bumper.
    const moving = Math.abs(playerSpeed(w)) > 40;
    const lead = AI.roadblockAhead * (moving ? AI.roadblockChaseLead : 1);
    const rawX = at.x + Math.cos(heading) * lead;
    const rawY = at.y + Math.sin(heading) * lead;
    const spot = snapRoad(rawX, rawY);
    if (!insideTown(spot.x, spot.y)) return null;
    // A pair is two bodies: never lay one that would break the unit cap. The
    // old code let addUnit() run unbounded, which a long chase could stack.
    if (cars.length + 2 > T.maxUnits) return null;

    // Lay the pair across the road, noses toward the oncoming player.
    const across = spot.along === 'v' ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const face = Math.atan2(at.y - spot.y, at.x - spot.x);
    const made = [];
    for (const side of [-1, 1]) {
      const x = spot.x + across.x * AI.roadblockSpread * side;
      const y = spot.y + across.y * AI.roadblockSpread * side;
      if (!insideTown(x, y)) continue;
      const unit = addUnit({ x, y }, 'block');
      unit.mode = 'hold';
      unit.car.angle = face;
      unit.car.speed = 0;
      made.push(unit);
    }
    if (!made.length) return null;
    const entry = {
      x: spot.x, y: spot.y, angle: face, t: 0, units: made,
      // additive: the road this pair straddles, and how often it has moved
      along: spot.along,
      across,
      axe: across.x,
      aye: across.y,
      redeploys: 0,
      armed: true,
    };
    for (const unit of made) unit.block = entry;
    roadblocks.push(entry);
    state.stats.roadblocks++;
    // A pair of officers mans each block.
    for (let i = 0; i < 2; i++) addOfficer(spot.x + across.x * (i ? 26 : -26), spot.y + across.y * (i ? 26 : -26), null);
    return roadblocks[roadblocks.length - 1];
  }

  function placeSpikes(w) {
    const at = bodyOf(w);
    if (!at) return null;
    const heading = at.angle ?? at.facing ?? 0;
    const spot = snapRoad(at.x + Math.cos(heading) * AI.spikeAhead, at.y + Math.sin(heading) * AI.spikeAhead);
    if (!insideTown(spot.x, spot.y)) return null;
    const strip = {
      x: spot.x,
      y: spot.y,
      angle: spot.along === 'v' ? Math.PI / 2 : 0,
      life: AI.spikeLife,
      hit: false,
    };
    spikes.push(strip);
    return strip;
  }

  function updateRoadblocks(dt, w) {
    const at = bodyOf(w);
    for (let i = roadblocks.length - 1; i >= 0; i--) {
      const block = roadblocks[i];
      block.t += dt;
      const alive = block.units.some((u) => cars.includes(u));
      const far = at ? distance(block.x, block.y, at.x, at.y) > 900 : true;
      if (!alive || block.t > 40 || far) roadblocks.splice(i, 1);
    }

    for (let i = spikes.length - 1; i >= 0; i--) {
      const strip = spikes[i];
      strip.life -= dt;
      if (strip.life <= 0) { spikes.splice(i, 1); continue; }
      const car = playerOf(w)?.car;
      if (!car || strip.hit) continue;
      if (distance(car.x, car.y, strip.x, strip.y) > 34) continue;
      if (Math.abs(car.speed ?? 0) < 55) continue;
      strip.hit = true;
      car.tyreDamage = clamp((car.tyreDamage ?? 0) + AI.spikeDamage, 0, 1);
      car.slip = (car.slip ?? 0) + (rng() - 0.5) * 60;
      state.stats.spikes = (state.stats.spikes ?? 0) + 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 5. officers, busted, wasted                                         */
  /* ------------------------------------------------------------------ */

  function addOfficer(x, y, unit) {
    if (officers.length >= 14) return null;
    const officer = {
      x,
      y,
      facing: 0,
      hp: 100,
      speed: 0,
      walkPhase: 0,
      scale: 1,
      unit: unit ?? null,
      shootT: 0,
      bustT: 0,
    };
    officers.push(officer);
    return officer;
  }

  function updateOfficers(dt, w, level) {
    const p = playerOf(w);
    const target = bodyOf(w);
    for (let i = officers.length - 1; i >= 0; i--) {
      const o = officers[i];
      if ((o.hp ?? 1) <= 0) { officers.splice(i, 1); continue; }
      if (!target || !p) { officers.splice(i, 1); continue; }
      if (distance(o.x, o.y, target.x, target.y) > 900) { officers.splice(i, 1); continue; }

      const dx = target.x - o.x;
      const dy = target.y - o.y;
      const d = Math.hypot(dx, dy) || 1;
      o.facing = Math.atan2(dy, dx);

      // Stay put while the player is in a moving car at range; close in on foot.
      const chasing = !p.car || Math.abs(p.car.speed ?? 0) < AI.bustSpeed;
      if (chasing && d > AI.officerReach) {
        const step = Math.min(d - AI.officerReach, AI.officerSpeed * dt);
        o.x += (dx / d) * step;
        o.y += (dy / d) * step;
        o.speed = AI.officerSpeed;
        o.walkPhase = (o.walkPhase ?? 0) + dt * 9;
      } else {
        o.speed = 0;
      }

      // Sidearm only at range, and only when the player is not already done.
      o.shootT = Math.max(0, (o.shootT ?? 0) - dt);
      if (level >= 3 && !p.car && d < AI.officerShootRange && d > AI.officerReach && o.shootT <= 0) {
        o.shootT = AI.officerShootCd;
        if (typeof w.hurtPlayer === 'function') w.hurtPlayer(p, AI.officerDamage);
        else if (Number.isFinite(p.health)) p.health = Math.max(0, p.health - AI.officerDamage);
      }
    }
  }

  function updateBusted(dt, w, level) {
    const p = playerOf(w);
    if (!p) return;
    if (state.outcome !== OUTCOME_CLEAR) return;

    const body = bodyOf(w);
    if (!body || level <= 0) { state.bustT = 0; return; }

    let pressure = false;
    if (p.car) {
      const stopped = Math.abs(p.car.speed ?? 0) <= AI.bustSpeed;
      if (stopped) {
        for (const u of cars) {
          if (u.car.wrecked) continue;
          if (distance(u.car.x, u.car.y, body.x, body.y) < AI.bustCarRadius) { pressure = true; break; }
        }
      }
    } else {
      for (const o of officers) {
        if (distance(o.x, o.y, body.x, body.y) <= AI.bustRadius) { pressure = true; break; }
      }
    }

    if (!pressure) { state.bustT = Math.max(0, state.bustT - dt * 1.6); return; }
    state.bustT += dt;
    if (state.bustT >= AI.bustTime) bust(w);
  }

  function bust(w) {
    if (state.outcome !== OUTCOME_CLEAR) return false;
    state.outcome = OUTCOME_BUSTED;
    state.stats.busts++;
    state.bustT = 0;
    state.heat = 0;
    state.searchT = 0;
    resetResponse();
    const target = w ?? world;
    target.busted = true;
    target.wasted = false;
    target.outcome = OUTCOME_BUSTED;
    target.over = OUTCOME_BUSTED;
    const p = playerOf(target);
    if (p) p.busted = true;
    despawnAll();
    sync(target);
    return true;
  }

  function wasted(w) {
    if (state.outcome === OUTCOME_WASTED) return false;
    state.outcome = OUTCOME_WASTED;
    state.heat = 0;
    state.bustT = 0;
    resetResponse();
    const target = w ?? world;
    target.wasted = true;
    target.busted = false;
    target.outcome = OUTCOME_WASTED;
    target.over = OUTCOME_WASTED;
    despawnAll();
    sync(target);
    return true;
  }

  function checkWasted(w) {
    if (state.outcome !== OUTCOME_CLEAR) return false;
    const p = playerOf(w);
    if (!p) return false;
    const dead = p.down === true || (Number.isFinite(p.health) && p.health <= 0);
    const carDown = p.car && (p.car.wrecked === true || (Number.isFinite(p.car.health) && p.car.health <= 0));
    if (dead || carDown) return wasted(w);
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* 6. spawning, despawning, the update                                 */
  /* ------------------------------------------------------------------ */

  function despawnAll() {
    for (let i = cars.length - 1; i >= 0; i--) despawnUnit(cars[i]);
    officers.length = 0;
    roadblocks.length = 0;
    spikes.length = 0;
  }

  function clear(w) {
    state.heat = 0;
    state.calm = 0;
    state.bustT = 0;
    state.outcome = OUTCOME_CLEAR;
    resetResponse();
    const target = w ?? world;
    target.busted = false;
    target.wasted = false;
    target.over = OUTCOME_CLEAR;
    const p = playerOf(target);
    if (p) p.busted = false;
    despawnAll();
    sync(target);
  }

  /*
   * One frame of the whole response.
   *
   * `seen` is true when any cruiser is inside its sight radius of the player,
   * which both keeps heat from cooling and pins the chase. Heat cools only
   * after calmDelay seconds of no contact, so ducking down an alley works
   * but a slow crawl in the open does not.
   */
  function update(dt, w = world) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    if (step === 0) { sync(w); return state; }

    const target = bodyOf(w);
    let level = levelForHeat(state.heat);

    // --- sight & cooling ------------------------------------------------
    /*
     * Cruisers are not omniscient. Each unit only knows where the player is
     * while the player is inside its sight radius; once contact breaks it
     * heads for the last known position for `loseSightGrace` seconds, then
     * falls back to sweeping the neighbourhood. Heat only cools while no
     * unit has contact, which is what makes ducking into an alley work.
     */
    let seen = false;
    const sightRange = level > 0 ? T.sightRangeChasing : T.sightRange;
    if (target && level > 0) {
      for (const u of cars) {
        if (u.car.wrecked) continue;
        const inSight = distance(u.car.x, u.car.y, target.x, target.y) <= sightRange;
        if (inSight) {
          u.lastSeen = { x: target.x, y: target.y };
          u.loseT = 0;
          seen = true;
        } else {
          u.loseT = (u.loseT ?? 0) + step;
          if (u.loseT > T.loseSightGrace) u.lastSeen = null;
        }
      }
      if (!seen) {
        for (const o of officers) {
          if (distance(o.x, o.y, target.x, target.y) <= T.sightRange) { seen = true; break; }
        }
      }
    }
    state.seen = seen;

    if (seen) {
      state.calm = 0;
      state.searchT = T.searchTime;
    } else {
      state.calm += step;
      state.searchT = Math.max(0, state.searchT - step);
      if (state.heat > 0 && state.calm >= T.calmDelay) {
        state.heat = Math.max(0, state.heat - T.heatDecay * step);
        if (state.heat <= 0) state.heat = 0;
      }
    }

    level = levelForHeat(state.heat);

    /*
     * The radio. Any rise in the wanted level — a fresh crime, not the slow
     * creep of heat — keys it once, and the cars it promises arrive through
     * stepBackup() below. `lastLevel` is advanced here, after the comparison,
     * so a two-star jump in one frame still only places one call.
     */
    if (level > state.lastLevel && level > 0) callBackup(w, level);
    if (level > state.peakLevel) state.peakLevel = level;
    if (level < state.lastLevel) resetResponse();
    state.lastLevel = level;

    // --- spawn pacing ----------------------------------------------------
    /*
     * No reinforcements while the player is out of sight. Backup only rolls
     * while the chase is live; once contact breaks, the units already out
     * search and the heat cools instead of the response resetting forever.
     */
    if (level > 0 && target && seen) {
      state.spawnT = Math.max(0, state.spawnT - step);
      const want = cruiserCap(level);
      if (cars.length < want && state.spawnT <= 0) {
        spawnUnit(spawnPoint(w));
        state.spawnT = T.unitSpawnDelay;
      }
    }

    // --- high-level response --------------------------------------------
    state.blockT = Math.max(0, state.blockT - step);
    if (level >= T.roadblockLevel && target && state.blockT <= 0) {
      if (placeRoadblock(w)) state.blockT = AI.roadblockCooldown;
    }
    state.spikeT = Math.max(0, state.spikeT - step);
    if (level >= T.spikeStripLevel && target && state.spikeT <= 0) {
      if (placeSpikes(w)) state.spikeT = AI.spikeCooldown;
    }

    if (level >= T.helicopterLevel) {
      state.airT = Math.min(T.helicopterDelay, state.airT + step);
    } else {
      state.airT = Math.max(0, state.airT - step * 2);
    }

    /*
     * Roadblock pursuit runs before the units so a pair re-tasked this frame
     * drives its new mark immediately, and the radio's backlog is drained here
     * too — arrivals land at the edge of the map, not in the player's mirror.
     */
    stepBlockTactics(step, w, level);
    stepBackup(step, w, level);

    // --- units -----------------------------------------------------------
    const keep = cruiserCap(level);
    for (let i = cars.length - 1; i >= 0; i--) {
      const u = cars[i];
      // A unit chases live contact when it has it, else its last known spot.
      const chase = seen ? target : (u.lastSeen ?? null);
      if (level === 0) u.lastSeen = null;
      updateUnit(u, step, level, chase, w);

      if (u.car.wrecked && !u.wrecked) {
        u.wrecked = true;
        state.stats.wrecks++;
      }
      if (u.car.wrecked && u.wreckT > AI.wreckLinger) { despawnUnit(u); continue; }

      if (target) {
        const far = distance(u.car.x, u.car.y, target.x, target.y) > AI.despawnDistance;
        if (far) { despawnUnit(u); continue; }
      }
      if (level === 0 && state.searchT <= 0) { despawnUnit(u); continue; }
      if (cars.length > keep && !u.car.wrecked) {
        // A pair manning or rolling to a block is doing the job the level
        // asked for: it stays even when the cruiser cap would cull it.
        const working = u.role === 'block' || u.mode === 'hold' || u.mode === 'intercept';
        if (!working && (!target || distance(u.car.x, u.car.y, target.x, target.y) > 420)) {
          despawnUnit(u);
          continue;
        }
      }

      // Integrate after the AI has set throttle / steer.
      moveCar(u.car, town, step);
      if (!Number.isFinite(u.car.x) || !Number.isFinite(u.car.y)) {
        u.car.x = town.spawn?.x ?? u.car.x;
        u.car.y = town.spawn?.y ?? u.car.y;
        u.car.speed = 0;
      }
      u.car.x = clamp(u.car.x, 20, (town.width ?? 1e9) - 20);
      u.car.y = clamp(u.car.y, 20, (town.height ?? 1e9) - 20);
    }

    // Nudge cruisers apart so a blockade reads as parked, not stacked.
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i].car;
        const b = cars[j].car;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 3600 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (60 - d) * 0.5;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }

    // --- feet ------------------------------------------------------------
    updateOfficers(step, w, level);
    updateRoadblocks(step, w);

    // --- outcomes --------------------------------------------------------
    checkWasted(w);
    updateBusted(step, w, level);

    sync(w);
    return state;
  }

  /* ------------------------------------------------------------------ */
  /* public surface                                                      */
  /* ------------------------------------------------------------------ */

  const api = {
    /* state */
    state,
    get heat() { return state.heat; },
    get level() { return levelForHeat(state.heat); },
    get wanted() { return clamp(state.heat / POLICE.heatPerLevel, 0, WANTED_MAX); },
    get busted() { return state.outcome === OUTCOME_BUSTED; },
    get wasted() { return state.outcome === OUTCOME_WASTED; },
    get outcome() { return state.outcome; },
    cars,
    units: cars,
    officers,
    roadblocks,
    spikes,

    /* heat / crimes */
    crime,
    addHeat,
    setHeat,
    clear,
    cooling: () => state.calm >= T.calmDelay && !state.seen,

    /* spawning */
    spawnUnit,
    despawnUnit,
    despawnAll: () => { despawnAll(); sync(world); },
    cap: () => cruiserCap(levelForHeat(state.heat)),
    spawn: (spot) => spawnUnit(spot),

    /* radio: call backup on demand, or see what the last call owes */
    callBackup: (level) => callBackup(world, Number.isFinite(level) ? level : levelForHeat(state.heat)),
    backupPending: () => state.backupQueue,
    backupCalls: () => state.backupCalls,

    /* roadblock pursuit: pull every standing pair onto the player's line */
    redeployBlocks: () => {
      const at = bodyOf(world);
      if (!at || !roadblocks.length) return 0;
      let moved = 0;
      for (let i = 0; i < roadblocks.length; i++) {
        const entry = roadblocks[i];
        const live = entry.units.filter((u) => u && cars.includes(u) && !u.car.wrecked);
        if (!live.length) continue;
        const spot = snapBlockSpot(at, clamp(AI.roadblockAhead, 160, 720));
        if (!spot) continue;
        relocateBlock(entry, live, spot, Math.atan2(at.y - spot.y, at.x - spot.x));
        moved++;
      }
      state.redeploys += moved;
      return moved;
    },
    intercepts: () => state.intercepts,

    /* outcomes */
    bust: () => bust(world),
    wasted: () => wasted(world),
    checkWasted: () => checkWasted(world),

    /* per-frame */
    update,
    sync: () => sync(world),

    /* readouts */
    status: () => ({
      heat: state.heat,
      level: levelForHeat(state.heat),
      wanted: clamp(state.heat / POLICE.heatPerLevel, 0, WANTED_MAX),
      seen: state.seen,
      calm: state.calm,
      cars: cars.length,
      officers: officers.length,
      roadblocks: roadblocks.length,
      spikes: spikes.length,
      outcome: state.outcome,
      // additive: the radio and the rolling blocks
      backup: { queued: state.backupQueue, calls: state.backupCalls, cooldown: state.backupCd },
      blocks: roadblocks.map((r) => ({
        x: r.x, y: r.y, angle: r.angle, units: r.units.length,
        redeploys: r.redeploys ?? 0, intercept: Number.isFinite(r.interceptX),
      })),
      redeploys: state.redeploys,
      intercepts: state.intercepts,
      peakLevel: state.peakLevel,
      tuning: T,
    }),
    stats: () => ({ ...state.stats }),
    tuning: T,
  };

  sync(world);
  return api;
}

export default createPolice;
