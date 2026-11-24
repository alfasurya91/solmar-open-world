/*
 * NPC traffic fleet — cars that follow the grid, queue naturally, give way
 * at intersections, drift in and out of town at the city edges, and read the
 * neighbourhood they are driving through.
 *
 * Layout of this file:
 *   1. tuning (grid, following, yielding, density, edges, zones, rush hour)
 *   1b. districts — zone mapping, per-district density, rush-hour curve
 *   2. driver archetypes — per-car cruise speed, braking and gap habits
 *   3. small public helpers (dirVector, dirAngle, sampleDriver, zone helpers)
 *   4. createTraffic: lanes, legs and route choice
 *   5. following, and passing a car that has stopped in the lane
 *   6. police: making way, and drivers who panic at a lit cruiser
 *   6b. bus lane: reserved lane, and giving a merging bus room
 *   6c. siren courtesy: pulling to the kerb for a lit cruiser
 *   7. intersection right-of-way, patience and courtesy waives
 *   8. the edge gate (recycle a car back onto a perimeter road)
 *   9. density control (rush-hour waves, surges, convoys)
 *  10. the per-frame update
 *
 * Public surface is unchanged: `dirAngle(dir)` and `createTraffic(city, rng)`
 * keep their exact names and signatures, and the returned object still has
 * `list`, `update`, `spawn` and `count`. Everything else here is additive.
 */

import { CAR_COLORS, TRAFFIC } from './config.js';
import { angleDelta, clamp } from './utils.js';
import { createCar, createTypedCar } from './vehicles.js';

/* ------------------------------------------------------------------ */
/* 1. tuning                                                           */
/* ------------------------------------------------------------------ */

const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

const ARRIVE = 20;          // distance at which a leg counts as reached
const LEG_TIMEOUT = 30;     // seconds a car may spend on one leg before giving up
const BRAKE = 380;          // baseline deceleration, scaled per driver
const PULL = 150;           // baseline acceleration, scaled per driver

const YIELD_ZONE = 138;     // approach distance at which right-of-way is claimed
const STOP_LINE = 30;       // a giving-way car halts this far short of the box
const WAIT_PATIENCE = 5.0;  // seconds of waiting before a car may break the tie
const ETA_TIEBREAK = 0.2;   // seconds of arrival-time difference that decides ties
const HOLD_CREEP = 34;      // speed cap for a car that is giving way but still rolling

const FLEET = {
  minFraction: 0.42,        // never fewer than this share of TRAFFIC.count
  maxFraction: 1.16,        // never more than this share
  rushBonus: 0.24,          // extra headroom the fleet gets at rush hour
  waveRate: 0.045,          // radians/second of the slow rush-hour wave
  surgeEvery: [7, 18],      // seconds between density surges/dips
  fadeDistance: 640,        // a car this far from the player may be retired
};

const EDGE = {
  ttlMin: 24,               // seconds a car may live before it heads out of town
  ttlMax: 62,
  farAway: 620,             // beyond this the player will not see the swap
  clearance: 88,            // minimum gap to any other car at the new spot
  playerGap: 250,           // never reappear this close to the player
  speed: 0.55,              // fraction of cruise speed when re-entering
  fadeIn: 0.8,              // seconds of "just appeared" bookkeeping for renderers
};

const WANDER = { rateMin: 0.35, rateMax: 0.95, depthMin: 0.02, depthMax: 0.09 };

const POLICE = {
  scan: 190,      // an NPC notices a cruiser with its lights on this close
  slow: 62,       // speed cap while easing past it
  hold: 46,       // a cruiser this close ahead brings the NPC to a stop
  cool: 1.2,      // seconds the "making way" flag lingers after it passes
  panic: 260,     // radius inside which some drivers lose their nerve
};

/*
 * Passing a stopped car. A blocked driver waits `after` seconds, then looks
 * for a clear corridor in the next lane; the shift is eased in and out so the
 * car never teleports sideways.
 */
const OVERTAKE = {
  after: 2.4,     // seconds of being stuck before a driver considers it
  hold: [1.7, 3.1],
  shift: 1.6,     // lane widths to the side while passing
  ahead: 130,     // corridor length checked ahead
  back: -64,      // ... and behind
  halfWidth: 22,  // lateral tolerance around the passing line
  speed: 0.92,    // fraction of cruise while passing
  cap: 118,
  grit: 0.95,     // "bold" score below which a driver rarely attempts it
};

/* Flustered drivers near a lit cruiser: some bolt, some pull to the kerb. */
const PANIC = {
  boost: 1.2,       // speed multiplier while bolting
  duck: 38,         // speed cap while tucked against the kerb
  kerb: 0.9,        // lane widths toward the kerb when ducking
  cool: [0.8, 1.7],
  rate: 1.1,        // flusters per second at full fear
  trigger: 0.42,
};

/* Bus lane: a reserved kerb-side strip that buses prefer and other traffic
 * keeps clear of. Only exists on roads wide enough for two running lanes. */
const BUS_LANE = {
  minRoadWidth: 2,           // minimum lanes each way for a bus lane to exist
  offset: 5,                 // extra kerb-ward offset of the reserved strip
  carInset: 6,               // how far general traffic tucks toward the centre
  preferChance: 1,           // share of buses that use the reserved strip: all
                             // of them — a reserved lane a bus ignores reads as
                             // a bug, so variety comes from the livery instead
  yieldRadius: 160,          // distance at which cars notice a bus in its lane
  yieldSpeed: 0.3,           // speed multiplier when yielding to a bus
  mergeCooldown: 2.0,        // seconds before a bus can re-enter bus lane after leaving
  corridor: 16,              // lateral half-width of a bus-lane lane test
  hold: 1.4,                 // seconds a give-way flag lingers
};

/* Siren yield: when a police cruiser runs its siren, nearby traffic pulls
 * to the kerb and stops until it passes. */
const SIREN_YIELD = {
  radius: 220,               // max distance to react to a siren
  kerbShift: 1.1,            // lane widths toward kerb when pulling over
  stopRadius: 150,           // inside this the pull-over becomes a full stop
  stopHold: 1.5,             // seconds to remain stopped after siren passes
  resumeSpeed: 0.4,          // speed multiplier while resuming
  resumeHold: 1.8,           // seconds spent at resumeSpeed before full pace
  checkInterval: 0.5,        // how often to re-evaluate siren presence
  abandon: 4.0,              // a car stuck this long stops insisting on stopping
};

/* Courtesy at a junction: a patient driver may wave through a car that has
 * been stuck noticeably longer, even when it technically has right of way. */
const COURTESY = { hold: 1.4, margin: 0.45, patience: 0.9 };

/* Rush-hour platoons: cars spawned nose-to-tail along one street. */
const CONVOY = {
  size: [2, 4],          // nominal platoon size (scaled by how busy the hour is)
  keep: 12,              // seconds a platoon member keeps preferring to go straight
  tight: 0.82,           // following-gap multiplier inside a platoon
  spacing: [0.35, 0.7],  // where along each block a member sits
  clearance: 52,         // minimum distance to an existing car
};

/* ------------------------------------------------------------------ */
/* 1b. districts                                                       */
/* ------------------------------------------------------------------ */

/*
 * Speed and density read differently by neighbourhood: the old town is tight
 * and slow, downtown is fast and busy, the marina is wide but quiet. These
 * multipliers are applied on top of the car's own cruise band.
 */
export const ZONE_TUNING = {
  oldtown: { label: 'Old Town', speed: 0.78, density: 1.12, patience: 1.15 },
  downtown: { label: 'Downtown', speed: 1.08, density: 1.3, patience: 0.85 },
  modern: { label: 'Marina District', speed: 0.95, density: 0.92, patience: 1.0 },
};

export const ZONE_ORDER = ['oldtown', 'downtown', 'modern'];

// Coordinate -> district key. Prefers the city's own classifier, then its
// district rectangles, then a plain left/centre/right split of the map.
export function zoneFor(city, x, y) {
  if (!city || !Number.isFinite(x) || !Number.isFinite(y)) return 'downtown';

  if (typeof city.districtOf === 'function') {
    const found = city.districtOf(x, y);
    if (found && ZONE_TUNING[found]) return found;
  }

  const zones = city.districts;
  if (zones) {
    for (let i = 0; i < ZONE_ORDER.length; i++) {
      const key = ZONE_ORDER[i];
      const z = zones[key];
      if (!z) continue;
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return key;
    }
  }

  if (Number.isFinite(city.width) && city.width > 0) {
    if (x < city.width * 0.36) return 'oldtown';
    if (x > city.width * 0.66) return 'modern';
  }
  return 'downtown';
}

// Speed multiplier for a district, tolerant of unknown keys.
export function zoneSpeedScale(zone) {
  return (ZONE_TUNING[zone] ?? ZONE_TUNING.downtown).speed;
}

/*
 * How much of its nominal density a district still accepts while the commute
 * is running: side streets in the old town and the marina empty out as people
 * funnel downtown, so those zones shed more traffic than the core does.
 */
export const RUSH_HOUR = {
  oldtown: 0.8,
  downtown: 0.94,
  modern: 0.74,
};

// Density factor for a district at spawn time, tolerant of unknown keys.
export function trafficCalm(zone) {
  const base = (ZONE_TUNING[zone] ?? ZONE_TUNING.downtown).density / 1.3;
  const damp = RUSH_HOUR[zone] ?? RUSH_HOUR.downtown;
  return base * damp;
}

// Cars per district, plus the busiest one — handy for a HUD or debug overlay.
export function trafficDensityByDistrict(city, list) {
  const out = { oldtown: 0, downtown: 0, modern: 0, total: 0, busiest: null };
  if (!Array.isArray(list)) return out;

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const zone = zoneFor(city, c.x, c.y);
    if (out[zone] === undefined) out[zone] = 0;
    out[zone] += 1;
    out.total += 1;
  }

  let best = null, bestCount = -1;
  for (let i = 0; i < ZONE_ORDER.length; i++) {
    const key = ZONE_ORDER[i];
    if ((out[key] ?? 0) > bestCount) { bestCount = out[key] ?? 0; best = key; }
  }
  out.busiest = bestCount > 0 ? best : null;
  return out;
}

/*
 * How hard the commute is running, 0 (quiet night) .. 1 (peak). Accepts
 * minutes since midnight; peaks are the morning and evening commutes.
 */
export function rushFactor(minutes) {
  if (!Number.isFinite(minutes)) return 0.15;
  const m = ((minutes % 1440) + 1440) % 1440;
  const bump = (centre, width) => {
    const raw = Math.abs(m - centre);
    const dist = Math.min(raw, 1440 - raw);
    return Math.max(0, 1 - dist / width);
  };
  const morning = bump(7 * 60 + 45, 100);
  const evening = bump(17 * 60 + 30, 125);
  return clamp(Math.max(morning, evening), 0, 1);
}

/* ------------------------------------------------------------------ */
/* 2. driver archetypes                                                */
/* ------------------------------------------------------------------ */

/*
 * Each fleet car draws one of these and then jitters it slightly, so no two
 * cars accelerate, brake, queue or turn exactly alike.
 *
 *   speed     cruise speed multiplier
 *   patience  how long it waits at a junction before pushing through
 *   brake     deceleration multiplier
 *   pull      acceleration multiplier
 *   gap       following-distance multiplier (small = tailgater)
 *   turn      appetite for turning and cornering speed multiplier
 *   nerve     resistance to a cruiser's presence (0 timid .. 1 unbothered)
 */
export const DRIVER_PROFILES = [
  { key: 'cruiser', label: 'Sunday cruiser', weight: 22, speed: 0.82, patience: 0.7, brake: 0.8, pull: 0.7, gap: 1.35, turn: 0.6, nerve: 0.3 },
  { key: 'commuter', label: 'Commuter', weight: 30, speed: 1.0, patience: 1.0, brake: 1.0, pull: 1.0, gap: 1.0, turn: 1.0, nerve: 0.55 },
  { key: 'brisk', label: 'Brisk driver', weight: 20, speed: 1.16, patience: 0.75, brake: 1.2, pull: 1.25, gap: 0.78, turn: 1.3, nerve: 0.7 },
  { key: 'taxi', label: 'Taxi', weight: 12, speed: 1.08, patience: 1.3, brake: 1.35, pull: 1.15, gap: 0.7, turn: 1.4, nerve: 0.75 },
  { key: 'courier', label: 'Courier van', weight: 8, speed: 1.12, patience: 0.6, brake: 1.15, pull: 1.3, gap: 0.72, turn: 1.1, nerve: 0.65 },
  { key: 'truck', label: 'Delivery truck', weight: 9, speed: 0.7, patience: 1.4, brake: 0.62, pull: 0.55, gap: 1.6, turn: 0.45, nerve: 0.45 },
  { key: 'tourist', label: 'Lost tourist', weight: 7, speed: 0.62, patience: 1.6, brake: 0.7, pull: 0.5, gap: 1.8, turn: 0.35, nerve: 0.2 },
];

// Weighted pick over DRIVER_PROFILES. Returns a shared profile object (never
// mutated); callers that need per-car values should copy it, as the fleet does.
export function sampleDriver(rng) {
  const roll = typeof rng === 'function' ? rng() : Math.random();
  let total = 0;
  for (let i = 0; i < DRIVER_PROFILES.length; i++) total += DRIVER_PROFILES[i].weight;
  let point = roll * total;
  for (let i = 0; i < DRIVER_PROFILES.length; i++) {
    point -= DRIVER_PROFILES[i].weight;
    if (point <= 0) return DRIVER_PROFILES[i];
  }
  return DRIVER_PROFILES[1];
}

/* ------------------------------------------------------------------ */
/* 3. public helpers                                                   */
/* ------------------------------------------------------------------ */

// Unit vector for a compass leg index (0 east, 1 south, 2 west, 3 north).
export function dirVector(dir) {
  return DIRS[dir] ?? DIRS[0];
}

export function dirAngle(dir) {
  const d = DIRS[dir] ?? DIRS[0];
  return Math.atan2(d.y, d.x);
}

/* ------------------------------------------------------------------ */
/* 4. the fleet                                                        */
/* ------------------------------------------------------------------ */

export function createTraffic(city, rng) {
  const fleet = [];

  // Wall clock for this traffic system, in seconds; drives speed wander and
  // the density wave. Kept separate from any world time the caller passes in.
  let clock = 0;

  const stats = {
    spawned: 0, recycled: 0, retired: 0, yields: 0, pulledOver: 0,
    overtakes: 0, panics: 0, waives: 0, convoys: 0,
    busYields: 0, busMerges: 0, sirenYields: 0,
  };

  const density = {
    value: 1,
    desired: clamp(Math.round(TRAFFIC.count), 2, Math.max(4, Math.round(TRAFFIC.count * FLEET.maxFraction))),
    min: Math.max(2, Math.round(TRAFFIC.count * FLEET.minFraction)),
    max: Math.max(6, Math.round(TRAFFIC.count * (FLEET.maxFraction + FLEET.rushBonus))),
    surge: 0,
    surgeT: rng.range(4, 12),
    phase: rng.range(0, Math.PI * 2),
  };

  // Rush-hour bookkeeping: how busy the commute is, and when the next platoon
  // is allowed onto the street.
  const rush = { value: 0, nextConvoy: rng.range(24, 46) };
  const convoys = { id: 0 };

  /* ---- lanes and legs ------------------------------------------- */

  /*
   * Does this street have room for a reserved kerb-side strip? The grid is
   * one lane each way at TRAFFIC.lane, so the kerb-side half of the
   * carriageway gains BUS_LANE.offset of reserved width on top of the
   * running lane. `minRoadWidth` is expressed in running lanes, and the
   * generated city always gives us at least one each way, so the real test
   * is whether the corridor is wide enough to hold lane + offset without
   * pushing a bus onto the pavement.
   */
  function busLaneAvailable() {
    const lane = Number.isFinite(TRAFFIC.lane) ? TRAFFIC.lane : 21;
    const road = Number.isFinite(city.roadWidth) ? city.roadWidth : lane * 4;
    /* The strip needs room for a lane, its offset, and half a bus body. */
    const need = (lane + BUS_LANE.offset) * 2 + 34;
    return BUS_LANE.minRoadWidth >= 1 && road >= Math.max(need * 0.5, lane * 2 + BUS_LANE.offset);
  }

  /*
   * Where a car sits laterally. `bus` asks for the reserved strip, which is
   * pushed one BUS_LANE.offset further toward the kerb than the ordinary
   * running lane on that side of the road.
   */
  function laneOffset(bus) {
    return bus ? TRAFFIC.lane + BUS_LANE.offset : TRAFFIC.lane;
  }

  function lanePt(axis, line, dir, node, bus = false) {
    const off = laneOffset(bus);
    if (axis === 'h') {
      return { x: city.vx[node], y: city.hy[line] + (dir === 0 ? off : -off) };
    }
    return { x: city.vx[line] + (dir === 1 ? -off : off), y: city.hy[node] };
  }

  function grid(car) {
    return car.axis === 'h'
      ? { across: car.line, along: car.node }
      : { across: car.node, along: car.line };
  }

  function setLeg(car, axis, line, dir, node) {
    car.axis = axis;
    car.line = line;
    car.dir = dir;
    car.node = node;
    /* A bus that prefers the reserved strip rides it whenever the street
     * has one; the flag is sticky so the whole leg keeps the same line. */
    car.inBusLane = !!(car.isBus && car.busLanePrefer && busLaneAvailable() && (car.busLaneCooldown ?? 0) <= 0);
    car.path = [lanePt(axis, line, dir, node, car.inBusLane)];
    car.legAge = 0;
  }

  function legCount(axis) {
    return axis === 'h' ? city.cols : city.rows;
  }

  function pickNext(car) {
    const { across, along } = grid(car);
    const opts = [];

    if (car.axis === 'h') {
      if (along < city.cols) opts.push(['h', across, 0, along + 1]);
      if (along > 0) opts.push(['h', across, 2, along - 1]);
      if (across < city.rows) opts.push(['v', along, 1, across + 1]);
      if (across > 0) opts.push(['v', along, 3, across - 1]);
    } else {
      if (across < city.rows) opts.push(['v', along, 1, across + 1]);
      if (across > 0) opts.push(['v', along, 3, across - 1]);
      if (along < city.cols) opts.push(['h', across, 0, along + 1]);
      if (along > 0) opts.push(['h', across, 2, along - 1]);
    }

    if (!opts.length) return false;

    // Straight-on is the safe default; how strongly a driver prefers it is
    // part of the archetype (taxis turn often, delivery trucks keep going).
    const bias = clamp(car.driver?.turn ?? 1, 0.3, 2);
    let straightWeight = clamp(Math.round(5 / bias), 1, 9);
    let turnWeight = clamp(Math.round(4 * bias), 1, 9);

    // Platoon members stay on their street for a while so the column holds.
    if ((car.convoyT ?? 0) > 0) {
      straightWeight += 8;
      turnWeight = Math.max(1, turnWeight - 2);
    }

    const straight = opts.filter(l => l[2] === car.dir);
    const turns = opts.filter(l => l[2] !== car.dir && l[2] !== (car.dir + 2) % 4);
    const pool = [];
    for (let i = 0; i < straightWeight; i++) for (const l of straight) pool.push(l);
    for (let i = 0; i < turnWeight; i++) for (const l of turns) pool.push(l);
    for (const l of opts) pool.push(l);

    const choice = rng.pick(pool);
    if (!choice) return false;

    const turned = choice[2] !== car.dir;
    setLeg(car, choice[0], choice[1], choice[2], choice[3]);
    car.turnIn = turned;
    return true;
  }

  // Position `t` of the way along a leg, 0 at the previous junction and 1 at
  // this one. Pure, so callers can test a spot before moving a car onto it.
  // `bus` selects the reserved strip, matching lanePt().
  function pointOnLeg(axis, line, dir, node, t, bus = false) {
    const forward = dir === 0 || dir === 1;
    const back = forward ? node - 1 : node + 1;
    const lim = legCount(axis);
    const from = clamp(back, 0, lim);
    const to = clamp(node, 0, lim);
    const tt = clamp(t, 0, 1);
    const mix = (a, b) => a + (b - a) * tt;
    const off = laneOffset(bus);

    if (axis === 'h') {
      return { x: mix(city.vx[from], city.vx[to]), y: city.hy[line] + (dir === 0 ? off : -off) };
    }
    return { x: city.vx[line] + (dir === 1 ? -off : off), y: mix(city.hy[from], city.hy[to]) };
  }

  function placeOnLeg(car, axis, line, dir, node, t) {
    const p = pointOnLeg(axis, line, dir, node, t, car?.inBusLane === true);
    car.x = p.x;
    car.y = p.y;
  }

  // Which way the kerb lies in lateral-coordinate space (y for a horizontal
  // leg, x for a vertical one), i.e. away from the road centre.
  function kerbSign(car) {
    if (car.axis === 'h') return car.dir === 0 ? 1 : -1;
    return car.dir === 1 ? -1 : 1;
  }

  /* ---- construction -------------------------------------------- */

  // Copies an archetype onto a car and rolls its personal habits.
  function dressCar(car) {
    const base = sampleDriver(rng);
    car.driver = {
      key: base.key,
      label: base.label,
      speed: base.speed * rng.range(0.94, 1.06),
      patience: base.patience * rng.range(0.88, 1.15),
      brake: base.brake * rng.range(0.9, 1.1),
      pull: base.pull * rng.range(0.9, 1.12),
      gap: base.gap * rng.range(0.88, 1.14),
      turn: base.turn * rng.range(0.85, 1.15),
      nerve: clamp((base.nerve ?? 0.5) * rng.range(0.85, 1.15), 0, 1),
    };

    // Per-car cruise band inside TRAFFIC.minSpeed..maxSpeed, then scaled by
    // the archetype. This is what makes one car drift past another.
    const band = rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed);
    car.cruise = clamp(band * car.driver.speed, TRAFFIC.minSpeed * 0.5, TRAFFIC.maxSpeed * 1.35);
    car.speed = car.cruise * rng.range(0.4, 0.7);

    // Slow sinusoidal breath on the cruise speed: nobody holds a pin-perfect
    // throttle down a whole block.
    car.wanderPhase = rng.range(0, Math.PI * 2);
    car.wanderRate = rng.range(WANDER.rateMin, WANDER.rateMax);
    car.wanderDepth = rng.range(WANDER.depthMin, WANDER.depthMax);

    car.waitT = 0;
    car.holdT = 0;
    car.yielding = false;
    car.courtesyYield = false;
    car.turnIn = false;
    car.blocked = 0;
    car.makingWay = false;
    car.wayT = 0;
    car.ttl = rng.range(EDGE.ttlMin, EDGE.ttlMax);
    car.reborn = 0;
    car.recycled = 0;

    // lane discipline / passing
    car.laneShift = 0;
    car.overSide = 0;
    car.overtakeT = 0;
    car.stallT = 0;

    // nerve
    car.panicT = 0;
    car.panicMode = null;

    // platoon
    car.convoy = 0;
    car.convoyT = 0;
    car.gapTight = 1;

    // bus lane
    car.isBus = car.type === 'bus';
    car.inBusLane = false;
    car.busLaneCooldown = 0;
    car.busLanePrefer = car.isBus && rng.chance(BUS_LANE.preferChance);
    car.merging = 0;          // >0 while pulling out of the strip to rejoin
    car.busYieldT = 0;        // gives-way-to-a-bus flag, for stats/HUD

    // siren yield
    car.sirenYieldT = 0;
    car.sirenYieldSide = 0;
    car.sirenCheckT = rng.range(0, SIREN_YIELD.checkInterval);
    car.sirenNear = false;    // a lit cruiser is inside the reaction radius
    car.sirenResumeT = 0;     // easing back up to pace after it passes

    car.zone = zoneFor(city, car.x, car.y);
  }

  function spawnOne() {
    if (fleet.length >= density.max) return null;

    for (let attempt = 0; attempt < 60; attempt++) {
      const horiz = rng.chance(0.55);
      const axis = horiz ? 'h' : 'v';
      const lim = legCount(axis);
      if (lim < 1) continue;

      const line = rng.int(0, horiz ? city.rows : city.cols);
      const dir = horiz ? (rng.chance(0.5) ? 0 : 2) : (rng.chance(0.5) ? 1 : 3);
      const node = rng.int(1, lim);
      const t = rng.range(0.15, 0.85);

      const at = pointOnLeg(axis, line, dir, node, t);

      // Busy districts get more cars than quiet ones, even at base density.
      const zone = zoneFor(city, at.x, at.y);
      const appetite = trafficCalm(zone);
      if (!rng.chance(clamp(appetite, 0.35, 1))) continue;

      const car = createCar(0, 0, dirAngle(dir), rng.pick(CAR_COLORS), 'npc');
      placeOnLeg(car, axis, line, dir, node, t);

      if (Math.hypot(car.x - city.spawn.x, car.y - city.spawn.y) < 170) continue;

      let crowded = false;
      for (const o of fleet) {
        if (Math.hypot(o.x - car.x, o.y - car.y) < 72) { crowded = true; break; }
      }
      if (crowded) continue;

      setLeg(car, axis, line, dir, node);
      placeOnLeg(car, axis, line, dir, node, t);
      car.angle = dirAngle(dir);
      dressCar(car);
      car.zone = zone;
      fleet.push(car);
      stats.spawned++;
      return car;
    }
    return null;
  }

  /*
   * A rush-hour platoon: several cars nose-to-tail on one street, one block
   * apart, all pointing the same way. They follow each other tightly and
   * prefer to keep their heading for a few seconds, which reads as a column
   * of commuters rather than loose traffic.
   */
  function spawnConvoy(size) {
    const count = Math.max(0, Math.min(Math.round(size) || 0, density.max - fleet.length));
    if (count < 1) return 0;

    const horiz = rng.chance(0.55);
    const axis = horiz ? 'h' : 'v';
    const lim = legCount(axis);
    if (lim < 2) return 0;

    const line = rng.int(0, horiz ? city.rows : city.cols);
    const dir = horiz ? (rng.chance(0.5) ? 0 : 2) : (rng.chance(0.5) ? 1 : 3);
    const forward = dir === 0 || dir === 1;
    const head = forward ? rng.int(2, lim) : rng.int(1, Math.max(1, lim - 1));
    const tag = ++convoys.id;

    let made = 0;
    for (let k = 0; k < count; k++) {
      const node = forward ? head - k : head + k;
      if (node < 1 || node > lim) break;

      const t = rng.range(CONVOY.spacing[0], CONVOY.spacing[1]);
      const p = pointOnLeg(axis, line, dir, node, t);
      if (Math.hypot(p.x - city.spawn.x, p.y - city.spawn.y) < 150) continue;

      let crowded = false;
      for (let i = 0; i < fleet.length; i++) {
        const o = fleet[i];
        if (Math.hypot(o.x - p.x, o.y - p.y) < CONVOY.clearance) { crowded = true; break; }
      }
      if (crowded) continue;

      const car = createCar(0, 0, dirAngle(dir), rng.pick(CAR_COLORS), 'npc');
      setLeg(car, axis, line, dir, node);
      placeOnLeg(car, axis, line, dir, node, t);
      car.angle = dirAngle(dir);
      dressCar(car);
      car.convoy = tag;
      car.convoyT = CONVOY.keep;
      car.gapTight = CONVOY.tight;
      car.cruise *= 0.96;
      car.zone = zoneFor(city, car.x, car.y);

      fleet.push(car);
      stats.spawned++;
      made++;
    }

    if (made > 0) stats.convoys++;
    return made;
  }

  for (let i = 0; i < TRAFFIC.count; i++) spawnOne();

  /*
   * A 4% share means most fleets never roll a bus at all, which would leave
   * the reserved strip empty and the whole bus-lane rule invisible. The
   * opening fleet therefore guarantees one, and only one, city bus on a
   * street with a usable strip; density control may add more later through
   * the normal weighted path.
   */
  function seedBus() {
    if (!busLaneAvailable()) return null;
    if (fleet.some(c => c.isBus)) return null;
    if (fleet.length >= density.max) return null;

    for (let attempt = 0; attempt < 40; attempt++) {
      const horiz = rng.chance(0.6);
      const axis = horiz ? 'h' : 'v';
      const lim = legCount(axis);
      if (lim < 1) continue;

      const line = rng.int(0, horiz ? city.rows : city.cols);
      const dir = horiz ? (rng.chance(0.5) ? 0 : 2) : (rng.chance(0.5) ? 1 : 3);
      const node = rng.int(1, lim);
      const t = rng.range(0.2, 0.8);

      const probe = pointOnLeg(axis, line, dir, node, t, true);
      if (Math.hypot(probe.x - city.spawn.x, probe.y - city.spawn.y) < 220) continue;

      let crowded = false;
      for (const o of fleet) {
        if (Math.hypot(o.x - probe.x, o.y - probe.y) < 110) { crowded = true; break; }
      }
      if (crowded) continue;

      const bus = createTypedCar(0, 0, dirAngle(dir), 'bus', undefined, 'npc');
      setLeg(bus, axis, line, dir, node);
      placeOnLeg(bus, axis, line, dir, node, t);
      bus.angle = dirAngle(dir);
      dressCar(bus);
      /* Buses are the stateliest thing on the road: slow to pull away, so
       * they get a driver that will not be rear-ended by its own cruise. */
      bus.cruise = Math.min(bus.cruise, TRAFFIC.maxSpeed * 0.72);
      bus.zone = zoneFor(city, bus.x, bus.y);
      fleet.push(bus);
      stats.spawned++;
      return bus;
    }
    return null;
  }

  seedBus();

  /* ---- following -------------------------------------------------- */

  /*
   * Nearest thing sitting in this car's path. Returns null when the lane is
   * clear, otherwise { x, y, ahead, lat, speed } describing the obstruction.
   * Solid bodies (cars, cruisers, the player) all go through the same test so
   * passing logic can reason about any of them.
   */
  function scanAhead(car, world, reachScale = 1) {
    const look = DIRS[car.dir] ?? DIRS[0];
    const gapScale = clamp((car.driver?.gap ?? 1) * (car.gapTight ?? 1), 0.6, 2.4);
    const follow = 56 * gapScale * reachScale;
    const probe = 34;                                   // tight bubble at the bumper
    const corridor = car.overtakeT > 0 ? 16 : 26;       // lateral half-width
    let best = null;

    function consider(x, y, dirIdx, speed, solid) {
      const sx = x - car.x, sy = y - car.y;
      const ahead = sx * look.x + sy * look.y;
      if (ahead < -12 || ahead > follow) return;
      const lat = Math.abs(sx * look.y - sy * look.x);

      if (dirIdx !== null) {
        const od = DIRS[dirIdx] ?? DIRS[0];
        const facing = od.x * look.x + od.y * look.y;
        // Oncoming traffic in the far lane passes us; it is not a queue.
        if (facing < -0.85 && lat > TRAFFIC.lane * 1.3) return;
        // Perpendicular traffic belongs to the junction, not to our lane.
        if (Math.abs(facing) < 0.35 && lat > 26) return;
      }

      const near = ahead <= probe + 4 && lat < corridor;
      const queued = ahead > 0 && lat < corridor;
      if (!near && !queued) return;
      if (best && ahead >= best.ahead) return;

      best = { x, y, ahead, lat, speed: speed ?? 0, solid: solid !== false };
    }

    for (let i = 0; i < fleet.length; i++) {
      const o = fleet[i];
      if (o === car) continue;
      consider(o.x, o.y, o.dir, Math.abs(o.speed ?? 0), true);
    }

    const p = world?.player;
    if (p) {
      if (!p.car) {
        consider(p.x, p.y, null, 0, false);
      } else if (p.car !== car) {
        consider(p.car.x, p.car.y, p.car.dir, Math.abs(p.car.speed ?? 0), true);
      }
    }

    // Cruisers are solid bodies too: an NPC queuing behind one that is
    // sitting in its lane must not drive through it. After a few seconds of
    // being stuck the NPC squeezes past instead, so an abandoned cruiser
    // cannot gridlock a lane for good.
    const units = world?.police?.cars;
    if (Array.isArray(units) && (car.blocked ?? 0) < 6) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i]?.car ?? units[i];
        if (!u || u === car || u.wrecked) continue;
        consider(u.x, u.y, u.dir, Math.abs(u.speed ?? 0), true);
      }
    }

    return best;
  }

  /*
   * Is the next lane over clear enough to pass in? Tests a long box on one
   * side of the car, against traffic, cruisers and the player alike.
   */
  function passingClear(car, side, world) {
    const look = DIRS[car.dir] ?? DIRS[0];
    const perpX = -look.y, perpY = look.x;
    const shift = side * TRAFFIC.lane * OVERTAKE.shift;

    function clear(x, y) {
      const sx = x - car.x, sy = y - car.y;
      const ahead = sx * look.x + sy * look.y;
      if (ahead < OVERTAKE.back || ahead > OVERTAKE.ahead) return true;
      const lat = sx * perpX + sy * perpY;
      return Math.abs(lat - shift) > OVERTAKE.halfWidth;
    }

    for (let i = 0; i < fleet.length; i++) {
      const o = fleet[i];
      if (o === car) continue;
      if (!clear(o.x, o.y)) return false;
    }

    const p = world?.player?.car;
    if (p && p !== car && !clear(p.x, p.y)) return false;

    const units = world?.police?.cars;
    if (Array.isArray(units)) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i]?.car ?? units[i];
        if (!u || u === car || u.wrecked) continue;
        if (!clear(u.x, u.y)) return false;
      }
    }
    return true;
  }

  /*
   * Commit to a pass when the driver has been stuck long enough, the blocker
   * is actually stopped, and one side is free. Timid archetypes only try
   * occasionally, so an obstruction produces a mix of waits and swerves.
   */
  function tryOvertake(car, blocker, world) {
    if (!blocker) return false;
    // Time spent crawling behind something that has stopped, not the generic
    // "blocked" clock: a queued car creeps and never fills that one.
    if ((car.stallT ?? 0) < OVERTAKE.after) return false;
    if (blocker.ahead < 6 || blocker.ahead > OVERTAKE.ahead) return false;
    if ((blocker.speed ?? 0) > 34) return false;          // it is moving: just queue
    if (car.overtakeT > 0) return false;

    // Willingness to swing out: cornering appetite plus raw nerve. The timid
    // tail-enders below the threshold only try now and then.
    const bold = clamp((car.driver?.turn ?? 1) * 0.7 + (car.driver?.nerve ?? 0.5) * 0.6, 0.4, 1.6);
    if (bold < OVERTAKE.grit && !rng.chance(0.22)) return false;

    let side = 0;
    if (passingClear(car, 1, world)) side = 1;
    else if (passingClear(car, -1, world)) side = -1;
    if (!side) return false;

    car.overtakeT = rng.range(OVERTAKE.hold[0], OVERTAKE.hold[1]);
    car.overSide = side * TRAFFIC.lane * OVERTAKE.shift;
    car.stallT = 0;
    stats.overtakes++;
    return true;
  }

  function approach(car, want, dt) {
    const diff = want - car.speed;
    const brake = BRAKE * (car.driver?.brake ?? 1);
    const pull = PULL * (car.driver?.pull ?? 1);
    const rate = diff < 0 ? brake : pull;
    car.speed = Math.max(0, car.speed + clamp(diff, -rate * dt, rate * dt));
  }

  // Cruise speed with the driver's slow wander and the district's pace.
  function cruiseNow(car) {
    const zone = ZONE_TUNING[car.zone] ?? ZONE_TUNING.downtown;
    const wobble = 1 + Math.sin(clock * car.wanderRate + car.wanderPhase) * car.wanderDepth;
    return clamp(car.cruise * zone.speed * wobble, 26, TRAFFIC.maxSpeed * 1.4);
  }

  /* ---- police: making way, and losing your nerve ------------------ */

  /*
   * Making way for a cruiser. Returns the speed this car is willing to do
   * right now (Infinity when no cruiser is about), so the caller can just
   * take the minimum with everything else it wants.
   *
   * A cruiser running its lights owns the road: NPCs ease off while it is
   * anywhere nearby, and stop outright if it is bearing down in their own
   * lane. Ordinary neighbourhood patrols (lights off) are ignored so traffic
   * does not crawl past parked cruisers all day.
   */
  function policeCap(car, world) {
    const units = world?.police?.cars;
    if (!Array.isArray(units) || !units.length) return Infinity;

    const look = DIRS[car.dir] ?? DIRS[0];
    let cap = Infinity;

    for (let i = 0; i < units.length; i++) {
      const p = units[i]?.car ?? units[i];
      if (!p || p === car || p.wrecked) continue;
      // Lights on, or clearly under way — a parked dark cruiser is scenery.
      if (p.siren !== true && Math.abs(p.speed ?? 0) < 4) continue;

      const dx = p.x - car.x, dy = p.y - car.y;
      const d = Math.hypot(dx, dy);
      if (d > POLICE.scan) continue;

      // Only defer to a cruiser that is not already behind and pulling away.
      const ahead = dx * look.x + dy * look.y;
      const closing = ahead > -30 && d < POLICE.scan;
      if (!closing) continue;

      const lat = Math.abs(dx * look.y - dy * look.x);
      const inLane = lat < TRAFFIC.lane * 1.8;
      const moving = Math.abs(p.speed ?? 0) > 4;
      // A car that has already been stuck a while stops insisting on a full
      // halt, so a cruiser left sitting in a lane cannot lock traffic up.
      const stubborn = (car.blocked ?? 0) < 6;

      // Stop only for a cruiser that is actually under way and squarely in
      // our lane; a parked one just gets a slow pass so lanes never gridlock.
      if (stubborn && inLane && moving && ahead < POLICE.hold) { cap = 0; continue; }

      cap = Math.min(cap, POLICE.slow);
    }

    return cap;
  }

  // 0..1: how badly a lit cruiser has this driver rattled.
  function policeFear(car, world) {
    const units = world?.police?.cars;
    if (!Array.isArray(units) || !units.length) return 0;

    let fear = 0;
    for (let i = 0; i < units.length; i++) {
      const p = units[i]?.car ?? units[i];
      if (!p || p === car || p.wrecked) continue;
      if (p.siren !== true) continue;
      const d = Math.hypot(p.x - car.x, p.y - car.y);
      if (d > POLICE.panic) continue;
      fear = Math.max(fear, 1 - d / POLICE.panic);
    }
    return fear;
  }

  /*
   * A flustered driver either bolts (floors it, wanders a bit) or ducks
   * (tucks against the kerb and crawls) for a moment. Brave drivers mostly
   * ignore the whole thing.
   */
  function tickPanic(car, world, dt, driven) {
    if (driven) { car.panicT = 0; return 0; }

    const fear = policeFear(car, world);
    if (fear <= 0.05) {
      if ((car.panicT ?? 0) > 0) car.panicT = Math.max(0, car.panicT - dt);
      return 0;
    }

    const nerve = clamp(car.driver?.nerve ?? 0.5, 0, 1);
    const fluster = fear * (1 - nerve * 0.55);

    if ((car.panicT ?? 0) <= 0 && fluster > PANIC.trigger && rng.chance(dt * PANIC.rate * fluster)) {
      car.panicT = rng.range(PANIC.cool[0], PANIC.cool[1]);
      // Brave drivers bolt; timid ones tuck against the kerb and crawl.
      car.panicMode = rng.chance(0.35 + nerve * 0.45) ? 'bolt' : 'duck';
      stats.panics++;
      if (car.panicMode === 'duck') {
        car.overtakeT = 0;
        car.overSide = kerbSign(car) * TRAFFIC.lane * PANIC.kerb;
      } else {
        car.overSide = 0;
      }
    }

    if ((car.panicT ?? 0) > 0) {
      car.panicT = Math.max(0, car.panicT - dt);
      if (car.panicT === 0) {
        car.panicMode = null;
        car.overSide = 0;
      }
    }
    return fluster;
  }

  /* ------------------------------------------------------------------ */
  /* 6b. bus lane                                                       */
  /* ------------------------------------------------------------------ */

  /*
   * Is a bus actually bearing down on this car's lane? A bus only counts
   * when it is a live NPC bus, it is riding the reserved strip, and it is
   * behind-and-closing or alongside — a bus parked far ahead is not a
   * reason to give up a lane. Returns the bus body or null.
   */
  function busBearingDown(car) {
    if (car.isBus) return null;

    const look = DIRS[car.dir] ?? DIRS[0];
    let best = null;
    let bestD = BUS_LANE.yieldRadius * BUS_LANE.yieldRadius;

    for (let i = 0; i < fleet.length; i++) {
      const o = fleet[i];
      if (o === car || !o.isBus || o.wrecked) continue;
      if (!o.inBusLane) continue;

      /* Same street, same direction, or it could never run us down. */
      if (o.axis !== car.axis || o.dir !== car.dir) continue;

      const dx = o.x - car.x;
      const dy = o.y - car.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > bestD) continue;

      /* Behind us, in our lane, or closing from slightly ahead. */
      const ahead = dx * look.x + dy * look.y;
      const lat = Math.abs(dx * look.y - dy * look.x);
      if (lat > BUS_LANE.corridor) continue;
      if (ahead > 20) continue;

      bestD = d2;
      best = o;
    }
    return best;
  }

  /*
   * Bus-lane pass. Two jobs, both at the kerb:
   *
   *   - a bus with a clear strip pulls wide into it and runs at full pace,
   *     so the reserved lane actually reads as faster;
   *   - everything else tucks a little off the strip and eases off when a
   *     bus is closing, so the bus can merge back out at a stop.
   *
   * Returns the speed cap this car is willing to do (Infinity = no change)
   * and writes the lateral target into car.busShift for the glue pass.
   */
  function busLaneStep(car, world, dt, driven) {
    /* Nobody in the fleet is a bus, so there is nothing to reserve. */
    car.busShift = 0;

    if ((car.busLaneCooldown ?? 0) > 0) car.busLaneCooldown = Math.max(0, car.busLaneCooldown - dt);
    if ((car.busYieldT ?? 0) > 0) car.busYieldT = Math.max(0, car.busYieldT - dt);

    if (driven) return Infinity;
    if (!busLaneAvailable()) return Infinity;

    if (car.isBus) {
      /*
       * A bus stuck behind something in its own strip drops out into the
       * general lane to get round it, then needs `mergeCooldown` before it
       * is allowed back onto the strip. That keeps the reserved lane from
       * reading as a wall the bus grinds against.
       */
      const stuckInStrip = car.inBusLane && (car.stallT ?? 0) > OVERTAKE.after;
      if (stuckInStrip) {
        car.inBusLane = false;
        car.busLaneCooldown = BUS_LANE.mergeCooldown;
        car.merging = BUS_LANE.mergeCooldown;
        car.busShift = 0;
        stats.busMerges = (stats.busMerges ?? 0) + 1;
        return Infinity;
      }

      /* Back onto the strip once the cool-down has run out. */
      if (!car.inBusLane && car.busLanePrefer && (car.busLaneCooldown ?? 0) <= 0) {
        car.inBusLane = true;
      }
      if (car.merging > 0) car.merging = Math.max(0, car.merging - dt);

      /* In the strip, a bus holds its pace: the lane is reserved for it. */
      if (car.inBusLane) return Infinity;

      /* Out of it: it still wants a little width back toward the kerb. */
      car.busShift = kerbSign(car) * BUS_LANE.carInset * 0.5;
      return Infinity;
    }

    /* General traffic: give the reserved strip a berth. */
    const bus = busBearingDown(car);
    if (!bus) return Infinity;

    car.busYieldT = BUS_LANE.hold;
    return Math.max(cruiseNow(car) * BUS_LANE.yieldSpeed, 40);
  }

  /* ------------------------------------------------------------------ */
  /* 6c. siren courtesy                                                 */
  /* ------------------------------------------------------------------ */

  /*
   * How close the nearest lit cruiser is, and whether it is coming up
   * behind or meeting us head-on. Only a cruiser with its siren on counts —
   * a dark patrol car parked on a corner is scenery, and traffic should not
   * freeze for it all day.
   */
  function sirenNear(car, world) {
    const units = world?.police?.cars;
    if (!Array.isArray(units) || !units.length) return null;

    let best = null;
    let bestD = SIREN_YIELD.radius;

    for (let i = 0; i < units.length; i++) {
      const u = units[i]?.car ?? units[i];
      if (!u || u === car || u.wrecked) continue;
      if (u.siren !== true) continue;

      const dx = u.x - car.x;
      const dy = u.y - car.y;
      const d = Math.hypot(dx, dy);
      if (d > bestD) continue;
      bestD = d;
      best = u;
    }
    return best;
  }

  /*
   * Pull over for a siren. Real traffic splits two ways at an emergency:
   * the near lane hugs the kerb and stops, the far lane just slows and
   * keeps rolling. Both get a lateral nudge so the corridor through the
   * middle of the road stays clear for the cruiser.
   *
   * Returns the speed cap (Infinity when nothing is happening) and writes
   * car.sirenShift / car.sirenStop for the motion pass.
   */
  function sirenYieldStep(car, world, dt, driven) {
    car.sirenShift = 0;
    car.sirenStop = false;

    if (driven) {
      car.sirenNear = false;
      car.sirenYieldT = 0;
      return Infinity;
    }

    /* Re-evaluate on a slow clock: this sweeps the police list, and nothing
     * about a siren changes in a single 16ms frame. */
    car.sirenCheckT = (car.sirenCheckT ?? 0) - dt;
    if (car.sirenCheckT <= 0) {
      car.sirenCheckT = SIREN_YIELD.checkInterval;
      car.sirenNear = sirenNear(car, world) !== null;
    }

    /* A car that has been pinned against the kerb too long gives up and
     * creeps on, so one long chase cannot gridlock a whole street. */
    if ((car.sirenYieldT ?? 0) > 0) car.sirenYieldT = Math.max(0, car.sirenYieldT - dt);

    if (car.sirenNear) {
      car.sirenYieldT = SIREN_YIELD.stopHold;
      car.sirenResumeT = SIREN_YIELD.resumeHold;

      /* Both directions tuck toward their own kerb. */
      car.sirenShift = kerbSign(car) * TRAFFIC.lane * SIREN_YIELD.kerbShift;

      const abandon = (car.blocked ?? 0) > SIREN_YIELD.abandon;
      if (!abandon) {
        const near = sirenNear(car, world);
        const d = near ? Math.hypot(near.x - car.x, near.y - car.y) : SIREN_YIELD.radius;
        if (d < SIREN_YIELD.stopRadius) {
          car.sirenStop = true;
          return 0;
        }
        return Math.min(cruiseNow(car) * 0.35, 55);
      }
    }

    /* Siren has passed but the flag lingers: ease back up, don't bolt. */
    if ((car.sirenResumeT ?? 0) > 0) {
      car.sirenResumeT = Math.max(0, car.sirenResumeT - dt);
      return cruiseNow(car) * SIREN_YIELD.resumeSpeed;
    }

    return Infinity;
  }

  /* ------------------------------------------------------------------ */
  /* 7. intersection right-of-way                                       */
  /* ------------------------------------------------------------------ */

  // The junction this car is currently heading for.
  function nodePoint(car) {
    return car.axis === 'h'
      ? { x: city.vx[car.node], y: city.hy[car.line] }
      : { x: city.vx[car.line], y: city.hy[car.node] };
  }

  // Junction identity as grid indices — two cars share a junction iff these
  // match, which is cheaper and exact compared to comparing coordinates.
  function nodeIndex(car) {
    return car.axis === 'h'
      ? { col: car.node, row: car.line }
      : { col: car.line, row: car.node };
  }

  // Forward distance to the junction; negative once it has been crossed.
  function approachGap(car) {
    const look = DIRS[car.dir] ?? DIRS[0];
    const p = nodePoint(car);
    return (p.x - car.x) * look.x + (p.y - car.y) * look.y;
  }

  // Do two legs want the same piece of tarmac?
  function conflicts(a, b) {
    const da = DIRS[a.dir] ?? DIRS[0];
    const db = DIRS[b.dir] ?? DIRS[0];
    const dot = da.x * db.x + da.y * db.y;
    if (dot === 0) return true;                 // perpendicular: paths cross
    if (dot > 0) return false;                  // same heading: just a queue
    return a.turnIn === true || b.turnIn === true; // head-on: only a turn cuts across
  }

  // Rough seconds-to-junction, used to decide who arrived first.
  function arrivalTime(car) {
    return Math.max(0, approachGap(car)) / Math.max(48, Math.abs(car.speed));
  }

  // True when `other` should go first.
  function holdsRightOfWay(other, car) {
    const waitOther = other.waitT ?? 0;
    const waitCar = car.waitT ?? 0;

    // Deadlock breaker: a car that has sat through its patience is released.
    if (waitOther > WAIT_PATIENCE && waitCar <= WAIT_PATIENCE) return true;
    if (waitCar > WAIT_PATIENCE && waitOther <= WAIT_PATIENCE) return false;

    const mine = arrivalTime(car);
    const theirs = arrivalTime(other);
    if (Math.abs(mine - theirs) > ETA_TIEBREAK) return theirs < mine;
    if (car.axis !== other.axis) return other.axis === 'h';   // main road wins ties
    return (other.id ?? 0) < (car.id ?? 0);                   // stable tiebreak
  }

  /*
   * Courtesy: a patient driver who has been sitting a good while will wave
   * through a car that has been stuck even longer, even if the rules say it
   * goes first. Only one side of a pair can satisfy this, and the margin
   * keeps it from flickering back and forth.
   */
  function courtesyWaive(car, at) {
    const patience = car.driver?.patience ?? 1;
    if (patience < COURTESY.patience) return false;

    const hold = car.holdT ?? 0;
    if (hold < COURTESY.hold) return false;

    for (let i = 0; i < fleet.length; i++) {
      const o = fleet[i];
      if (o === car || !o.path?.length) continue;
      if (Math.abs(o.x - car.x) > YIELD_ZONE * 2 || Math.abs(o.y - car.y) > YIELD_ZONE * 2) continue;

      const oAt = nodeIndex(o);
      if (oAt.col !== at.col || oAt.row !== at.row) continue;

      const oGap = approachGap(o);
      if (oGap > YIELD_ZONE || oGap < -STOP_LINE) continue;
      if (!conflicts(car, o)) continue;
      if ((o.holdT ?? 0) < hold + COURTESY.margin) continue;
      if (Math.abs(o.speed ?? 0) > 12) continue;

      car.courtesyYield = true;
      return true;
    }
    return false;
  }

  function mustYield(car) {
    car.courtesyYield = false;

    const gap = approachGap(car);
    if (gap > YIELD_ZONE || gap < -STOP_LINE) return false;

    const at = nodeIndex(car);
    for (let i = 0; i < fleet.length; i++) {
      const o = fleet[i];
      if (o === car || !o.path?.length) continue;
      if (Math.abs(o.x - car.x) > YIELD_ZONE * 2 || Math.abs(o.y - car.y) > YIELD_ZONE * 2) continue;

      const oAt = nodeIndex(o);
      if (oAt.col !== at.col || oAt.row !== at.row) continue;

      const oGap = approachGap(o);
      if (oGap > YIELD_ZONE || oGap < -STOP_LINE) continue;
      if (!conflicts(car, o)) continue;
      if (holdsRightOfWay(o, car)) return true;
    }

    return courtesyWaive(car, at);
  }

  /* ------------------------------------------------------------------ */
  /* 8. the edge gate                                                   */
  /* ------------------------------------------------------------------ */

  function onPerimeter(car) {
    return car.axis === 'h'
      ? car.line === 0 || car.line === city.rows
      : car.line === 0 || car.line === city.cols;
  }

  // A spot on a perimeter road, near one end of town, pointing inward along it.
  function pickEdgeSpot() {
    const horiz = rng.chance(0.5);
    const axis = horiz ? 'h' : 'v';
    const span = legCount(axis);
    const line = rng.chance(0.5) ? 0 : (horiz ? city.rows : city.cols);
    const inwardDir = rng.chance(0.5);           // true = east/south, false = west/north
    const dir = horiz ? (inwardDir ? 0 : 2) : (inwardDir ? 1 : 3);
    const node = inwardDir
      ? rng.int(1, Math.max(1, Math.min(2, span - 1)))
      : rng.int(Math.max(1, span - 2), Math.max(1, span - 1));
    return { axis, line, dir, node, t: rng.range(0.12, 0.55) };
  }

  /*
   * Pulls a car off the road and drops it back in at the edge of town. The
   * body, driver, colour and identity survive; only the position and the
   * freshness clock are new, so a renderer can fade it back in.
   */
  function recycle(car, world) {
    const at = world?.player?.car ?? world?.player;

    for (let attempt = 0; attempt < 20; attempt++) {
      const spot = pickEdgeSpot();
      const p = pointOnLeg(spot.axis, spot.line, spot.dir, spot.node, spot.t);

      if (at && Math.hypot(p.x - at.x, p.y - at.y) < EDGE.playerGap) continue;

      let crowded = false;
      for (let i = 0; i < fleet.length; i++) {
        const o = fleet[i];
        if (o === car) continue;
        if (Math.hypot(o.x - p.x, o.y - p.y) < EDGE.clearance) { crowded = true; break; }
      }
      if (crowded) continue;

      setLeg(car, spot.axis, spot.line, spot.dir, spot.node);
      placeOnLeg(car, spot.axis, spot.line, spot.dir, spot.node, spot.t);
      car.angle = dirAngle(spot.dir);
      car.speed = car.cruise * EDGE.speed;
      car.turnIn = false;
      car.waitT = 0;
      car.holdT = 0;
      car.yielding = false;
      car.courtesyYield = false;
      car.makingWay = false;
      car.blocked = 0;
      car.legAge = 0;
      car.laneShift = 0;
      car.overSide = 0;
      car.overtakeT = 0;
      car.stallT = 0;
      car.panicT = 0;
      car.panicMode = null;
      car.convoy = 0;
      car.convoyT = 0;
      car.gapTight = 1;
      car.inBusLane = false;
      car.busLaneCooldown = 0;
      car.merging = 0;
      car.busYieldT = 0;
      car.busYielded = false;
      car.busShift = 0;
      car.busShiftNow = 0;
      car.sirenYieldT = 0;
      car.sirenNear = false;
      car.sirenStop = false;
      car.sirenShift = 0;
      car.sirenShiftNow = 0;
      car.sirenResumeT = 0;
      car.ttl = rng.range(EDGE.ttlMin, EDGE.ttlMax);
      car.reborn = EDGE.fadeIn;
      car.recycled = (car.recycled ?? 0) + 1;
      car.zone = zoneFor(city, car.x, car.y);
      stats.recycled++;
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* 9. density                                                         */
  /* ------------------------------------------------------------------ */

  function tickDensity(dt, world) {
    // world.clock runs in minutes since midnight; fall back to a slow
    // internal day so the system still breathes without a world clock.
    const minutes = Number.isFinite(world?.clock) ? world.clock : (clock * 3) % 1440;
    rush.value = rushFactor(minutes);

    density.surgeT -= dt;
    if (density.surgeT <= 0) {
      density.surge = rng.chance(0.45) ? rng.range(0.1, 0.28) : -rng.range(0.08, 0.22);
      density.surgeT = rng.range(FLEET.surgeEvery[0], FLEET.surgeEvery[1]);
    }
    density.surge *= Math.max(0, 1 - 0.35 * dt);

    const wave = 0.5 + 0.5 * Math.sin(clock * FLEET.waveRate + density.phase);
    density.value = clamp(0.32 + 0.8 * wave + density.surge + rush.value * 0.42, 0.2, 1.42);
    density.desired = clamp(Math.round(TRAFFIC.count * density.value), density.min, density.max);
  }

  // Retires one car that the player cannot see, when density drops.
  function retireOne(world) {
    const at = world?.player?.car ?? world?.player;
    let worst = -1, worstDist = -Infinity;

    for (let i = 0; i < fleet.length; i++) {
      const car = fleet[i];
      if (car.occupied) continue;
      if (world?.player?.car === car) continue;
      const d = at ? Math.hypot(car.x - at.x, car.y - at.y) : Infinity;
      if (d < FLEET.fadeDistance) continue;
      if (d > worstDist) { worstDist = d; worst = i; }
    }

    if (worst < 0) return false;
    fleet.splice(worst, 1);
    stats.retired++;
    return true;
  }

  /*
   * The bus panel is part of the traffic system, not scenery, so an empty
   * strip is a bug the sim should fix itself. Re-seeding is gated by a
   * cooldown and a fleet check so it cannot fight the density controller
   * or turn the street into a bus depot.
   */
  let busReseed = 0;

  function ensureBus(dt) {
    if (busReseed > 0) { busReseed = Math.max(0, busReseed - dt); return; }
    if (fleet.some(c => c.isBus)) return;
    if (fleet.length >= density.max - 1) return;
    if (seedBus()) busReseed = 12;
  }

  function rebalance(world) {
    if (fleet.length < density.desired) { spawnOne(); return; }
    if (fleet.length > density.desired) retireOne(world);
  }

  /*
   * During the commute, columns of cars appear together instead of ones and
   * twos. Size scales with how deep into rush hour we are, and the platoon
   * only enters if the fleet has room for it.
   */
  function maybeConvoy(world) {
    if (rush.value < 0.4) return 0;
    if (clock < rush.nextConvoy) return 0;

    const room = density.max - fleet.length;
    if (room < CONVOY.size[0]) {
      rush.nextConvoy = clock + 6;
      return 0;
    }

    const want = rng.int(CONVOY.size[0], CONVOY.size[0] + Math.round(rush.value * 3));
    const made = spawnConvoy(Math.min(want, room));
    const gap = rng.range(14, 30) * (1.5 - rush.value);
    rush.nextConvoy = clock + Math.max(6, gap);
    return made;
  }

  /* ------------------------------------------------------------------ */
  /* 10. per-frame update                                               */
  /* ------------------------------------------------------------------ */

  function update(dt, world) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    clock += dt;
    tickDensity(dt, world);
    rebalance(world);
    ensureBus(dt);
    maybeConvoy(world);

    const player = world?.player;
    const driving = player?.car ?? null;

    for (let i = 0; i < fleet.length; i++) {
      const car = fleet[i];
      const driven = driving === car;

      // District pace follows the car around the map.
      car.zone = zoneFor(city, car.x, car.y);

      if (!car.path?.length) { if (!pickNext(car)) continue; }
      const target = car.path[0];

      const wantAng = Math.atan2(target.y - car.y, target.x - car.x);
      const err = angleDelta(car.angle, wantAng);
      const maxT = TRAFFIC.turnRate * (car.driver?.turn ?? 1) * dt;
      car.angle += clamp(err, -maxT, maxT);

      // Cornering speed limits, softened or sharpened by the archetype.
      const corner = clamp(0.5 + 0.5 * (car.driver?.turn ?? 1), 0.45, 1.25);
      let want = cruiseNow(car);

      // A driver who has just been spooked by a cruiser floors it away.
      if (!driven && (car.panicT ?? 0) > 0 && car.panicMode === 'bolt') {
        want = Math.max(want, Math.min(cruiseNow(car) * PANIC.boost, TRAFFIC.maxSpeed * 1.25));
      }

      const turn = Math.abs(err);
      if (turn > 0.55) want = Math.min(want, 42 * corner);
      else if (turn > 0.26) want = Math.min(want, 88 * corner);
      else if (turn > 0.1) want = Math.min(want, 128 * corner);

      const gap = approachGap(car);
      if (gap > -STOP_LINE && gap < 40) want = Math.min(want, 78);

      // Somebody in the lane: pass it if we have been stuck a while, queue
      // otherwise. Passing is a short, laterally shifted burst. Braking uses
      // the short scan; the pass decision gets a longer view of the lane.
      const blocker = scanAhead(car, world);
      const queued = scanAhead(car, world, 2.2);
      const stalled = queued && (queued.speed ?? 0) <= 34 && (queued.ahead ?? 0) <= OVERTAKE.ahead;
      if (stalled && Math.abs(car.speed) < 26 && car.overtakeT <= 0) car.stallT = (car.stallT ?? 0) + dt;
      else if (!stalled) car.stallT = Math.max(0, (car.stallT ?? 0) - dt * 2.5);

      if (queued && !driven && car.overtakeT <= 0) tryOvertake(car, queued, world);
      if (blocker) {
        if (car.overtakeT > 0) {
          want = Math.min(want, Math.min(cruiseNow(car) * OVERTAKE.speed, OVERTAKE.cap));
        } else {
          want = 0;
        }
      }

      // Make way for a cruiser running its lights.
      const police = driven ? Infinity : policeCap(car, world);
      if (police < want) want = police;
      car.makingWay = Number.isFinite(police);
      if (car.makingWay) {
        if (car.wayT === undefined) car.wayT = 0;
        if (car.wayT === 0) stats.pulledOver++;
        car.wayT = POLICE.cool;
      } else if (car.wayT > 0) {
        car.wayT = Math.max(0, car.wayT - dt);
      }

      /*
       * Bus lane and siren courtesy. Both are kerb-lateral decisions run
       * after the queuing and police passes so they can only ever slow a
       * car down or pull it sideways — never speed it up past what the
       * lane, the junction or a cruiser already allows.
       */
      const busCap = busLaneStep(car, world, dt, driven);
      if (busCap < want) want = busCap;

      const sirenCap = sirenYieldStep(car, world, dt, driven);
      if (sirenCap < want) want = sirenCap;
      if (car.sirenStop || car.sirenShift !== 0) {
        if (car.sirenYielding !== true) {
          stats.sirenYields = (stats.sirenYields ?? 0) + 1;
          car.sirenYielding = true;
        }
      } else {
        car.sirenYielding = false;
      }
      if (car.sirenStop) {
        want = 0;
        if (car.overtakeT > 0) car.overtakeT = 0;
      }
      if (car.busYieldT > 0 && car.busYielded !== true) {
        stats.busYields = (stats.busYields ?? 0) + 1;
        car.busYielded = true;
      } else if (car.busYieldT <= 0) {
        car.busYielded = false;
      }

      // Nerves by the roadside: bolts and kerb-hugging.
      tickPanic(car, world, dt, driven);
      if ((car.panicT ?? 0) > 0 && car.panicMode === 'duck') {
        want = Math.min(want, PANIC.duck);
        if (car.overtakeT > 0) car.overtakeT = 0;
      }

      // Give way at the junction unless this car is the one being driven.
      let yielding = false;
      if (!driven && gap < YIELD_ZONE && gap > -STOP_LINE) {
        yielding = mustYield(car);
      }

      if (yielding) {
        const zonePatience = (ZONE_TUNING[car.zone] ?? ZONE_TUNING.downtown).patience;
        const patience = WAIT_PATIENCE * (car.driver?.patience ?? 1) * zonePatience;
        car.waitT = Math.min(14, (car.waitT ?? 0) + dt);
        if (!car.yielding) stats.yields++;
        if (car.courtesyYield && !car.waivedOnce) { stats.waives++; car.waivedOnce = true; }
        if (gap > STOP_LINE) want = Math.min(want, HOLD_CREEP);
        else want = Math.min(want, car.waitT > patience ? 30 : 0);
      } else {
        car.waitT = Math.max(0, (car.waitT ?? 0) - dt * 1.8);
      }
      if (!car.courtesyYield) car.waivedOnce = false;
      car.yielding = yielding;

      approach(car, want, dt);

      const before = Math.hypot(target.x - car.x, target.y - car.y);
      car.x += Math.cos(car.angle) * car.speed * dt;
      car.y += Math.sin(car.angle) * car.speed * dt;

      const after = Math.hypot(target.x - car.x, target.y - car.y);
      car.legAge = (car.legAge ?? 0) + dt;
      const overshot = after > before && before < 34;
      if (after < ARRIVE || overshot || car.legAge > LEG_TIMEOUT) {
        car.path.shift();
        if (!car.path.length) pickNext(car);
      }

      /*
       * Ease every lateral intent back toward the lane line. Three things
       * can pull a car off its centre: passing a stopped car, ducking a
       * cruiser, and pulling over for a siren (or off a bus strip). They
       * are smoothed separately so a siren arriving mid-overtake does not
       * snap the body sideways, then summed into one displacement.
       */
      if ((car.overtakeT ?? 0) > 0) car.overtakeT = Math.max(0, car.overtakeT - dt);
      if (car.overtakeT <= 0 && (car.panicT ?? 0) <= 0) car.overSide = 0;

      const ease = (now, want, rate) => now + (want - now) * Math.min(1, rate * dt);
      car.laneShift = ease(car.laneShift ?? 0, car.overSide ?? 0, 4);
      car.sirenShiftNow = ease(car.sirenShiftNow ?? 0, car.sirenShift ?? 0, 3.2);
      car.busShiftNow = ease(car.busShiftNow ?? 0, car.busShift ?? 0, 2.6);

      const lateral = (car.laneShift ?? 0) + (car.sirenShiftNow ?? 0) + (car.busShiftNow ?? 0);
      const pull = Math.min(1, 5 * dt);

      /*
       * Build the target line the same way the legs do: road centre, then
       * one lane (or the reserved strip) toward the kerb, then any lateral
       * displacement. kerbSign() is the single source of truth for which
       * way "toward the kerb" points on this axis, so a siren pull-over and
       * a bus-strip offset both land on the correct side of the road.
       */
      const base = laneOffset(car.inBusLane === true);
      const out = kerbSign(car) * (base + lateral);

      if (car.axis === 'h') {
        const laneY = city.hy[car.line] + out;
        car.y += (laneY - car.y) * pull;
      } else {
        const laneX = city.vx[car.line] + out;
        car.x += (laneX - car.x) * pull;
      }

      // How long this car has been sitting still near a junction; used by the
      // courtesy rule to decide who has waited longest.
      if (Math.abs(car.speed) < 8 && gap > -STOP_LINE && gap < YIELD_ZONE) {
        car.holdT = (car.holdT ?? 0) + dt;
      } else {
        car.holdT = Math.max(0, (car.holdT ?? 0) - dt * 0.6);
      }

      if (want <= 0.01 && Math.abs(car.speed) < 6) car.blocked = (car.blocked ?? 0) + dt;
      else car.blocked = 0;

      if ((car.convoyT ?? 0) > 0) car.convoyT = Math.max(0, car.convoyT - dt);

      if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.angle)) {
        car.x = city.vx[0];
        car.y = city.hy[0];
        car.angle = car.speed = 0;
        car.path = [];
      }
      car.x = clamp(car.x, 20, city.width - 20);
      car.y = clamp(car.y, 20, city.height - 20);

      if (car.reborn > 0) car.reborn = Math.max(0, car.reborn - dt);

      // Lifetime: head out of town, but never vanish in front of the player
      // and never while the human is at the wheel.
      if (!driven) {
        car.ttl = (car.ttl ?? 30) - dt;
        const at = driving ?? player;
        const away = !at || Math.hypot(car.x - at.x, car.y - at.y) > EDGE.farAway;
        if (car.ttl <= 0 && (away || onPerimeter(car))) recycle(car, world);
      }
    }

    // Loose separation pass so cars never share a body. A car in the middle
    // of a pass is left alone by the softer push so it can actually get by.
    for (let i = 0; i < fleet.length; i++) {
      const a = fleet[i];
      for (let j = i + 1; j < fleet.length; j++) {
        const b = fleet[j];
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 > 1600 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const passing = (a.overtakeT ?? 0) > 0 || (b.overtakeT ?? 0) > 0;
        const push = (passing ? Math.min(30, 40 - d) : 40 - d) * 0.5;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
        a.speed = Math.min(a.speed, 52);
        b.speed = Math.min(b.speed, 52);
      }
    }

    // The push above can nudge a car a hair past the map edge; keep bodies in.
    for (let i = 0; i < fleet.length; i++) {
      const c = fleet[i];
      c.x = clamp(c.x, 20, city.width - 20);
      c.y = clamp(c.y, 20, city.height - 20);
    }
  }

  return {
    list: fleet,
    update,
    spawn: spawnOne,
    convoy: spawnConvoy,
    count: () => fleet.length,
    // additive surface: useful for debug overlays and HUD readouts
    density: () => density.value,
    target: () => density.desired,
    rush: () => rush.value,
    districts: () => trafficDensityByDistrict(city, fleet),
    zoneAt: (x, y) => zoneFor(city, x, y),
    profiles: DRIVER_PROFILES,
    stats: () => ({ ...stats }),
    // bus-lane queries
    busLaneOpen: busLaneAvailable,
    buses: () => fleet.filter(c => c.isBus === true),
    busLaneOffset: laneOffset,
    // siren queries
    sirenReacting: () => fleet.filter(c => c.sirenNear === true).length,
    sirenStopped: () => fleet.filter(c => c.sirenStop === true).length,
  };
}
