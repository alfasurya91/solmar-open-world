/*
 * Vehicles — the car factory, the arcade driving model, body damage and
 * the collision response that every road actor in town shares.
 *
 * Section order:
 *   1. tuning
 *   2. car archetypes (sedan, taxi, truck, sport, van, pickup, bus)
 *   3. damage & light-bar bookkeeping (tiered condition)
 *   4. body geometry (circles, extents, cheap distance)
 *   5. paint & weather helpers
 *   5b. handling character (drift feel, stat card)
 *   6. the factory
 *   7. driving and integration (arcade grip / drift model)
 *   8. pushing the body out of the city
 *   9. theft: checks, hotwiring, driving away
 *  10. lookup helpers (player, traffic, police)
 */

import { CAR_COLORS, POLICE, VEHICLE } from './config.js';
import { clamp, resolveCircleRect } from './utils.js';

/* ------------------------------------------------------------------ */
/* 1. tuning                                                           */
/* ------------------------------------------------------------------ */

let nextId = 1;

const STEER_FLOOR = 16;       // speed below which the wheel bites nothing
const STEER_FULL = 110;       // extra speed needed for a full steering lock
const HARD_CONTACT = 0.4;     // penetration depth counted as a hard hit
const CRASH_KEEP = 0.36;      // speed kept after clipping scenery
const HARD_CRASH = 130;       // impact speed that slams the car down to ...
const HARD_CRASH_SPEED = 45;  // ... this leftover speed
const STILL = 0.001;          // anything slower is treated as parked

const BODY_HEALTH = 100;      // hit points of a fresh body
const SMOKE_AT = 0.35;        // health fraction where the engine starts smoking
const FIRE_AT = 0.08;         // health fraction where the body catches fire
const SIREN_PHASE = 0.42;     // seconds per half of the strobe cycle

// Drift feel. Lateral slip is carried in world units/second, positive to
// the car's right-hand side; it is bled off by grip every step.
const SLIP_MAX_SHARE = 0.75;  // slip may never exceed this share of speed
const SLIP_BLEED = 1;         // base multiplier on VEHICLE.driftRecovery
const SLIP_GRIP_BITE = 0.9;   // share of the grip that suppresses slip transfer
const SLIP_MIN_SHARE = 0.04;  // even a slick tyre carries a little slip
const HANDBRAKE_SLIP_KEEP = 0.42; // slip recovery left while the handbrake is on
const DRIFT_THRESHOLD = 0.16; // slip share above which the tyres are squealing
const STEP_LOW_SPEED = 12;    // below this the handbrake is just a parking brake

// Grip envelope. effectiveGrip() clamps into this band, so a wreck that is
// also sitting on sand cannot produce a negative or runaway grip number.
const GRIP_MIN = 0.15;
const GRIP_MAX = 1.35;
const TYRE_GRIP_LOSS = 0.45;  // lateral grip lost per unit of tyreDamage
const TYRE_YAW_LOSS = 0.25;   // steering authority lost per unit of tyreDamage
const ENGINE_POWER_LOSS = 0.7; // throttle lost per unit of engineDamage

// Damage shaping on impacts.
const IMPACT_MIN_SPEED = 34;  // below this a scrape costs no hit points
const IMPACT_SCALE = 0.22;    // hit points per unit of severity

// Paint jitter for ambient traffic, per channel, as a share of the colour.
const PAINT_JITTER = 0.09;

// Read-only view of the grip model for HUD / tuning screens / tests.
export const GRIP_TUNING = Object.freeze({
  slipMaxShare: SLIP_MAX_SHARE,
  gripBite: SLIP_GRIP_BITE,
  minSlipShare: SLIP_MIN_SHARE,
  handbrakeKeep: HANDBRAKE_SLIP_KEEP,
  tyreGripLoss: TYRE_GRIP_LOSS,
  tyreYawLoss: TYRE_YAW_LOSS,
  gripMin: GRIP_MIN,
  gripMax: GRIP_MAX,
  wetGrip: VEHICLE.gripWet,
});

/* ------------------------------------------------------------------ */
/* 2. car archetypes                                                   */
/* ------------------------------------------------------------------ */

/*
 * Each archetype is a full driving profile rather than a handful of
 * multipliers: mass changes how much damage a body shrugs off, grip and
 * driftGain change how eagerly the tail steps out, and maxSpeed/accel set
 * the pace. `settle` values are the ones used by createCar, so the default
 * sedan keeps the historical VEHICLE numbers exactly.
 */
export const CAR_TYPES = {
  sedan: {
    label: 'Sedan',
    length: VEHICLE.length,
    width: VEHICLE.width,
    accel: VEHICLE.accel,
    brake: VEHICLE.brake,
    reverseAccel: VEHICLE.reverseAccel,
    reverseMax: VEHICLE.reverseMax,
    maxSpeed: VEHICLE.maxSpeed,
    turnRate: VEHICLE.turnRate,
    handbrake: VEHICLE.handbrake,
    grip: VEHICLE.gripRoad,
    driftGain: 0.85,
    health: BODY_HEALTH,
    mass: 1,
    value: 900,
    hotwire: 1.6,
    trunk: 1,
  },
  taxi: {
    label: 'Taxi',
    length: 58,
    width: 27,
    accel: 300,
    brake: 545,
    reverseAccel: 205,
    reverseMax: 128,
    maxSpeed: 312,
    turnRate: 2.2,
    handbrake: 780,
    grip: 0.98,
    driftGain: 1.05,
    health: 96,
    mass: 1.05,
    value: 1150,
    hotwire: 1.4,
    trunk: 1.1,
  },
  truck: {
    label: 'Truk',
    length: 82,
    width: 36,
    accel: 205,
    brake: 430,
    reverseAccel: 150,
    reverseMax: 96,
    maxSpeed: 236,
    turnRate: 1.42,
    handbrake: 690,
    grip: 0.92,
    driftGain: 0.6,
    health: 165,
    mass: 2.4,
    value: 1600,
    hotwire: 2.4,
    trunk: 2.6,
  },
  sport: {
    label: 'Sport',
    length: 52,
    width: 27,
    accel: 402,
    brake: 610,
    reverseAccel: 230,
    reverseMax: 142,
    maxSpeed: 392,
    turnRate: 2.32,
    handbrake: 820,
    grip: 1.06,
    driftGain: 1.35,
    health: 82,
    mass: 0.85,
    value: 2400,
    hotwire: 2.0,
    trunk: 0.65,
  },
  cruiser: {
    label: 'Cruiser',
    length: 60,
    width: 28,
    accel: 355,
    brake: 575,
    reverseAccel: 230,
    reverseMax: 150,
    maxSpeed: 348,
    turnRate: 2.15,
    handbrake: 800,
    grip: 1.02,
    driftGain: 1.0,
    health: 140,
    mass: 1.45,
    value: 0,          // nobody fences a patrol car
    hotwire: 3.2,
    trunk: 1.2,
  },
  /*
   * Delivery van: the honest workhorse. It carries more than a sedan and
   * shrugs off knocks, but it wallows into a corner and its tall body
   * gives the tail a high, lazy swing on the handbrake.
   */
  van: {
    label: 'Van Antar',
    length: 72,
    width: 31,
    accel: 252,
    brake: 500,
    reverseAccel: 178,
    reverseMax: 108,
    maxSpeed: 268,
    turnRate: 1.66,
    handbrake: 715,
    grip: 0.94,
    driftGain: 0.68,
    health: 132,
    mass: 1.75,
    value: 1450,
    hotwire: 1.9,
    trunk: 2.2,
  },
  /* Pickup truck: open bed, high torque, heavy rear. Slow to turn but can
   * shove lighter traffic aside. The bed counts as extra trunk space. */
  pickup: {
    label: 'Truk Pikap',
    length: 78,
    width: 33,
    accel: 285,
    brake: 460,
    reverseAccel: 165,
    reverseMax: 100,
    maxSpeed: 255,
    turnRate: 1.55,
    handbrake: 730,
    grip: 0.96,
    driftGain: 0.72,
    health: 155,
    mass: 2.1,
    value: 1800,
    hotwire: 2.1,
    trunk: 3.0,
  },
  /* City bus: long wheelbase, wide, heavy. Dedicated bus lane logic in
   * traffic.js lets it bypass queues. Terrible drift, massive mass. */
  bus: {
    label: 'Bus Kota',
    length: 110,
    width: 34,
    accel: 180,
    brake: 400,
    reverseAccel: 120,
    reverseMax: 80,
    maxSpeed: 200,
    turnRate: 1.1,
    handbrake: 650,
    grip: 0.88,
    driftGain: 0.35,
    health: 220,
    mass: 3.2,
    value: 0,
    hotwire: 3.5,
    trunk: 0.5,
  },
};

export const CAR_TYPE_ORDER = ['sedan', 'taxi', 'truck', 'sport', 'van', 'pickup', 'bus'];

/*
 * Handling reference. Every archetype's `driftGain` is read against the
 * sedan's, so the sedan keeps the historical feel exactly (ratio 1) while a
 * bus (0.35) refuses to rotate and a sport (1.35) lets the tail hang out.
 * Declared after CAR_TYPES because it reads the table.
 */
const DRIFT_REF = CAR_TYPES.sedan.driftGain;

const TAXI_YELLOW = '#e8c25a';

// Fleet liveries for the delivery van; picked from the car id so a given
// spawn slot always wears the same paint.
const VAN_LIVERY = ['#e6e2d6', '#c8d2d4', '#d9cdb6'];

// Work-truck paint for the pickup: municipal white, primer grey, and the
// faded red a farm hand would drive. Deterministic per car id.
const PICKUP_LIVERY = ['#d8d5cc', '#8f9296', '#a8503f'];

// City bus liveries. Public transport reads as a livery, not a colour, so a
// bus is always one of these and never inherits a sedan palette entry.
const BUS_LIVERY = ['#2f6fb0', '#2a8a63', '#b8452f'];

// Weighted pick so the street looks lived in, and so a truck stays rare.
const TYPE_WEIGHTS = [
  { type: 'sedan', share: 0.38 },
  { type: 'taxi', share: 0.18 },
  { type: 'sport', share: 0.12 },
  { type: 'truck', share: 0.12 },
  { type: 'van', share: 0.10 },
  { type: 'pickup', share: 0.06 },
  { type: 'bus', share: 0.04 },
];

/*
 * Deterministic archetype pick. Later model years, same street: the choice
 * is keyed off the car id, so a given spawn slot always yields the same
 * body style while the fleet as a whole stays mixed.
 *
 * 'parked' and anything unrecognised fall back to the sedan, which is what
 * createCar() has always produced; 'npc' gets the weighted mix so traffic
 * looks lived in.
 */
export function pickCarType(kind = 'parked', seed = 0) {
  if (kind === 'police' || kind === 'cruiser') return 'cruiser';
  if (kind === 'taxi' || kind === 'truck' || kind === 'sport' || kind === 'van' || kind === 'pickup' || kind === 'bus') return kind;
  if (kind !== 'npc') return 'sedan';

  const n = Math.abs(Math.floor(seed)) % 1000;
  let roll = ((n * 37 + 11) % 100) / 100;
  for (let i = 0; i < TYPE_WEIGHTS.length; i++) {
    roll -= TYPE_WEIGHTS[i].share;
    if (roll < 0) return TYPE_WEIGHTS[i].type;
  }
  return 'sedan';
}

// Tolerant lookup: an unknown or missing type hands back the sedan.
export function carProfile(car) {
  const key = car?.type;
  return CAR_TYPES[key] ?? CAR_TYPES.sedan;
}

// Factory paint for an archetype that was spawned without an explicit colour.
function defaultPaint(type, seed) {
  if (type === 'taxi') return TAXI_YELLOW;
  if (type === 'van') {
    const i = Math.abs(Math.floor(seed)) % VAN_LIVERY.length;
    return VAN_LIVERY[i];
  }
  if (type === 'pickup') {
    const i = Math.abs(Math.floor(seed)) % PICKUP_LIVERY.length;
    return PICKUP_LIVERY[i];
  }
  if (type === 'bus') {
    const i = Math.abs(Math.floor(seed)) % BUS_LIVERY.length;
    return BUS_LIVERY[i];
  }
  return CAR_COLORS[0];
}

/* ------------------------------------------------------------------ */
/* 3. damage & light bar                                               */
/* ------------------------------------------------------------------ */

// Tolerant body ceiling, so hand-built car objects still work.
function maxHealthOf(car) {
  const max = Number(car?.maxHealth);
  return Number.isFinite(max) && max > 0 ? max : BODY_HEALTH;
}

/*
 * Staged condition. Tiers are ordered from healthy to dead; damageTier()
 * walks them from the top and returns the first one the body still meets,
 * so health 0.7 is 'scuffed', 0.5 is 'battered' and 0.2 is 'critical'.
 */
export const DAMAGE_TIERS = Object.freeze([
  Object.freeze({ key: 'pristine', label: 'Utuh', min: 0.9 }),
  Object.freeze({ key: 'scuffed', label: 'Baret', min: 0.6 }),
  Object.freeze({ key: 'battered', label: 'Berat', min: SMOKE_AT }),
  Object.freeze({ key: 'critical', label: 'Kritis', min: FIRE_AT }),
]);

// A body that is already bent folds faster. A fresh shell takes it square.
const TIER_FRAGILITY = Object.freeze({
  pristine: 1,
  scuffed: 1.05,
  battered: 1.15,
  critical: 1.3,
  wrecked: 1,
});

export function damageTier(car) {
  if (!car) return 'pristine';
  const max = maxHealthOf(car);
  const health = clamp(Number.isFinite(car.health) ? car.health : max, 0, max);
  const ratio = max > 0 ? health / max : 0;
  if (car.wrecked === true || health <= 0) return 'wrecked';
  for (let i = 0; i < DAMAGE_TIERS.length; i++) {
    if (ratio >= DAMAGE_TIERS[i].min) return DAMAGE_TIERS[i].key;
  }
  return 'critical';
}

// How hard a body that is already in the given tier folds on the next hit.
export function tierFragility(car) {
  return TIER_FRAGILITY[damageTier(car)] ?? 1;
}

/*
 * Removes `amount` hit points from a car and refreshes its damage flags.
 * Returns true only for the blow that actually wrecks the body, so a
 * caller can spawn an explosion exactly once.
 */
export function damageCar(car, amount) {
  if (!car) return false;

  const max = maxHealthOf(car);
  if (!Number.isFinite(car.maxHealth)) car.maxHealth = max;
  if (!Number.isFinite(car.health)) car.health = max;

  const before = car.health;
  const raw = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  // A shell that is already creased buckles under the same blow.
  const hit = raw * (TIER_FRAGILITY[damageTier(car)] ?? 1);
  car.health = Math.max(0, before - hit);

  const ratio = max > 0 ? car.health / max : 0;
  car.smoke = ratio <= SMOKE_AT || car.wrecked === true;
  car.burning = ratio <= FIRE_AT || car.wrecked === true;

  // Sub-system damage: a battered engine pulls less, shredded tyres grip
  // less. Both stay in 0..1 and are read by driveCar/moveCar.
  if (!Number.isFinite(car.engineDamage)) car.engineDamage = 0;
  if (!Number.isFinite(car.tyreDamage)) car.tyreDamage = 0;
  car.engineDamage = clamp(Math.max(car.engineDamage, 1 - ratio * 1.25), 0, 1);
  car.tyreDamage = clamp(Math.max(car.tyreDamage, 1 - ratio * 1.1), 0, 1);

  const destroyed = car.health <= 0 && before > 0;
  if (destroyed) {
    car.wrecked = true;
    car.smoke = true;
    car.burning = true;
    car.speed = 0;
    car.slip = 0;
    car.steer = 0;
    car.ignition = false;
  }

  car.lastHit = hit;
  car.damageTier = damageTier(car);
  return destroyed;
}

// Bleeds damage, repairs body and sub-systems. Returns hit points restored.
export function repairCar(car, amount) {
  if (!car) return 0;
  const max = maxHealthOf(car);
  if (!Number.isFinite(car.maxHealth)) car.maxHealth = max;
  const before = Number.isFinite(car.health) ? car.health : max;
  const heal = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  car.health = clamp(before + heal, 0, max);

  const ratio = max > 0 ? car.health / max : 0;
  car.smoke = ratio <= SMOKE_AT;
  car.burning = ratio <= FIRE_AT;
  car.engineDamage = clamp(1 - ratio * 1.25, 0, 1);
  car.tyreDamage = clamp(1 - ratio * 1.1, 0, 1);
  if (car.health > max * 0.25) {
    car.wrecked = false;
    car.ignition = true;
  }
  car.damageTier = damageTier(car);

  return car.health - before;
}

// Read-only summary for HUD / mission code.
export function carCondition(car) {
  if (!car) return null;
  const max = maxHealthOf(car);
  const health = clamp(Number.isFinite(car.health) ? car.health : max, 0, max);
  const ratio = max > 0 ? health / max : 0;
  return {
    health,
    max,
    ratio,
    tier: damageTier(car),
    smoke: car.smoke === true || ratio <= SMOKE_AT,
    burning: car.burning === true || ratio <= FIRE_AT,
    wrecked: car.wrecked === true || health <= 0,
    drivable: car.wrecked !== true && health > 0 && car.ignition !== false,
    engineDamage: clamp(car.engineDamage ?? 0, 0, 1),
    tyreDamage: clamp(car.tyreDamage ?? 0, 0, 1),
    wetness: clamp(car.wetness ?? 0, 0, 1),
  };
}

// Advances the strobe clock; a car without a siren keeps it at zero.
function tickSiren(car, dt) {
  if (!car) return;
  if (!car.siren) {
    car.sirenT = 0;
    return;
  }
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  car.sirenT = ((car.sirenT ?? 0) + step) % (SIREN_PHASE * 2);
}

// Smoke puff timer, so a renderer can emit at a steady rate.
function tickSmoke(car, dt) {
  if (!car) return;
  if (!car.smoke) {
    car.smokeT = 0;
    return;
  }
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  car.smokeT = (car.smokeT ?? 0) + step;
}

// Fire timer, only meaningful once the body is burning.
function tickFire(car, dt) {
  if (!car) return;
  if (!car.burning) {
    car.fireT = 0;
    return;
  }
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  car.fireT = (car.fireT ?? 0) + step;
}

/* ------------------------------------------------------------------ */
/* 4. body geometry                                                    */
/* ------------------------------------------------------------------ */

// Two overlapping circles down the long axis: cheap and smooth enough.
export function carCircles(car) {
  const off = (car.length ?? VEHICLE.length) * 0.25;
  const rad = (car.width ?? VEHICLE.width) * 0.52;
  const c = Math.cos(car.angle), s = Math.sin(car.angle);
  return [
    { x: car.x + c * off, y: car.y + s * off, r: rad },
    { x: car.x - c * off, y: car.y - s * off, r: rad },
  ];
}

// Axis-aligned footprint of the rotated body.
export function carExtents(car) {
  const L = car.length ?? VEHICLE.length;
  const W = car.width ?? VEHICLE.width;
  const c = Math.abs(Math.cos(car.angle)), s = Math.abs(Math.sin(car.angle));
  return { w: L * c + W * s, h: L * s + W * c };
}

export function carDistance2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// How sideways the car currently is, 0 (planted) .. 1 (fully sideways).
export function driftAmount(car) {
  if (!car) return 0;
  const slip = Math.abs(car.slip ?? 0);
  const speed = Math.abs(car.speed ?? 0);
  return clamp(slip / (speed * 0.5 + 30), 0, 1);
}

/* ------------------------------------------------------------------ */
/* 5. paint & weather helpers                                          */
/* ------------------------------------------------------------------ */

/*
 * Deterministic per-channel shade of a #rrggbb colour. Traffic uses it so
 * two cars off the same palette entry do not read as clones; the same seed
 * always produces the same paint, which keeps saves and replays stable.
 */
export function paintVariant(color, seed = 0, strength = PAINT_JITTER) {
  if (typeof color !== 'string' || color.length !== 7 || color[0] !== '#') return color;
  const hex = color.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return color;

  const n = Math.abs(Math.floor(seed)) || 0;
  const amp = clamp(Number.isFinite(strength) ? strength : PAINT_JITTER, 0, 0.4);
  let out = '#';
  for (let k = 0; k < 3; k++) {
    const roll = ((n * (17 + k * 11) + 41 * (k + 1)) % 997) / 997;
    const delta = (roll - 0.5) * 2 * amp;
    const ch = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
    const v = clamp(Math.round(ch * (1 + delta)), 0, 255);
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

/*
 * Wet-road grip. `wetness` is 0 (dry) .. 1 (standing water); the dry rating
 * is blended toward VEHICLE.gripWet so a downpour costs a sport car more
 * absolute grip than a truck.
 */
export function wetGrip(grip, wetness) {
  const w = clamp(Number.isFinite(wetness) ? wetness : 0, 0, 1);
  const dry = Number.isFinite(grip) ? grip : VEHICLE.gripRoad;
  return dry * (1 - w * (1 - VEHICLE.gripWet));
}

// Lateral bite left in the tyres after damage, 0.3 .. 1.
function tyreBite(car) {
  return clamp(1 - (car?.tyreDamage ?? 0) * TYRE_GRIP_LOSS, 0.3, 1);
}

/*
 * The single grip number driveCar works from: archetype grip, the world's
 * surface modifier (sand), tyre damage and the weather, all folded into
 * the same 0.15 .. 1.35 envelope.
 */
export function effectiveGrip(car, profile = carProfile(car)) {
  const p = profile ?? CAR_TYPES.sedan;
  const mod = Number.isFinite(car?.gripMod) ? car.gripMod : 1;
  const wet = wetGrip(p.grip, car?.wetness ?? 0);
  return clamp(wet * mod * tyreBite(car), GRIP_MIN, GRIP_MAX);
}

/*
 * Weather pass over a fleet: sets wetness on every body so effectiveGrip()
 * sees it. Returns the clamped wetness that was applied.
 */
export function applyWeather(cars, wetness) {
  const w = clamp(Number.isFinite(wetness) ? wetness : 0, 0, 1);
  if (!cars || typeof cars.length !== 'number') return w;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (c) c.wetness = w;
  }
  return w;
}

/*
 * How much of a yaw impulse becomes sideways momentum. A planted tyre
 * converts almost none of it; a loose or wet one lets most of it through.
 * Grip above 1 is honoured here (a sport car slides less than 0.1 of the
 * impulse) instead of being floored at a full unit like before.
 */
function slipShare(grip) {
  const g = clamp(grip, GRIP_MIN, GRIP_MAX);
  return clamp(1 - g * SLIP_GRIP_BITE, SLIP_MIN_SHARE, 1);
}

/*
 * How eagerly this body's tail steps out, 1 = the sedan's historic feel.
 * A city bus is long and heavy enough that its rear tyres barely break
 * loose; a sport car swings wide with a flick. Clamped so no archetype can
 * produce a spin that reads as a teleport, and so a missing/garbled value
 * falls back to the sedan instead of NaN-ing the whole grip model.
 */
export function driftCharacter(car, profile = carProfile(car)) {
  const p = profile ?? CAR_TYPES.sedan;
  const gain = Number.isFinite(p.driftGain) ? p.driftGain : DRIFT_REF;
  return clamp(gain / DRIFT_REF, 0.3, 1.7);
}

/*
 * How much extra road speed a body needs before the wheel really bites.
 * Mass above a sedan's delays the bite (a loaded bus steers like a barge at
 * low speed), mass below sharpens it. Returns 1 for the sedan, keeping the
 * historical STEER_FULL for the car the game shipped with.
 */
function heavySteer(car, profile = carProfile(car)) {
  const p = profile ?? CAR_TYPES.sedan;
  const mass = Number.isFinite(p.mass) ? p.mass : 1;
  return clamp(0.55 + mass * 0.45, 0.7, 2.1);
}

/*
 * Read-only handling card for HUD / garage screens: the numbers that
 * actually differ between a pickup and a bus, expressed in the same units
 * driveCar() consumes. Nothing here is derived from the body's condition —
 * carCondition() covers that.
 */
export function handlingStats(car) {
  const p = carProfile(car);
  const char = driftCharacter(car, p);
  return {
    type: car?.type ?? 'sedan',
    label: p.label,
    maxSpeed: p.maxSpeed,
    accel: p.accel,
    brake: p.brake,
    turnRate: p.turnRate,
    grip: p.grip,
    mass: p.mass,
    health: p.health,
    trunk: p.trunk,
    drift: char,
    /* 0..1 scores, so a garage screen can draw bars without knowing units. */
    scores: {
      speed: clamp(p.maxSpeed / 400, 0, 1),
      acceleration: clamp(p.accel / 420, 0, 1),
      braking: clamp(p.brake / 630, 0, 1),
      agility: clamp(p.turnRate / 2.4, 0, 1),
      grip: clamp(p.grip / 1.1, 0, 1),
      toughness: clamp(p.health / 225, 0, 1),
      cargo: clamp(p.trunk / 3.1, 0, 1),
      drift: clamp((char - 0.3) / 1.4, 0, 1),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 6. factory                                                         */
/* ------------------------------------------------------------------ */

export function createCar(x, y, angle, color, kind = 'parked') {
  const id = nextId++;
  const type = pickCarType(kind, id);
  const profile = CAR_TYPES[type] ?? CAR_TYPES.sedan;
  const police = kind === 'police';
  const base = color ?? defaultPaint(type, id);
  // Ambient traffic gets a deterministic shade so the street looks lived
  // in; player-facing spawns keep the exact colour they asked for.
  const paint = kind === 'npc' ? paintVariant(base, id) : base;

  return {
    id,
    kind,
    type,
    label: profile.label,
    x,
    y,
    angle,
    speed: 0,
    steer: 0,
    // lateral velocity carried through a slide (world units / second)
    slip: 0,
    color: paint,
    length: profile.length,
    width: profile.width,
    mass: profile.mass,
    occupied: false,
    dir: 0,
    target: null,
    cruise: 0,
    blocked: 0,
    // body condition
    maxHealth: profile.health,
    health: profile.health,
    engineDamage: 0,
    tyreDamage: 0,
    damageTier: 'pristine',
    smoke: false,
    smokeT: 0,
    burning: false,
    fireT: 0,
    wrecked: false,
    lastHit: 0,
    // grip modifier supplied by the world (sand / wet road)
    gripMod: 1,
    // 0 (dry) .. 1 (standing water); read by effectiveGrip()
    wetness: 0,
    gripNow: 1,
    // theft & ignition
    locked: kind === 'npc',
    ignition: true,
    alarm: false,
    stolen: false,
    stolenBy: null,
    theftHeat: 0,
    hotwireT: 0,
    hotwiring: false,
    fenceValue: profile.value,
    // light bar (cruisers only)
    siren: police,
    sirenT: 0,
  };
}

/*
 * Explicit-archetype factory. createCar() cannot take a type without
 * changing its signature, so mission / spawn code that knows exactly what
 * it wants (a getaway sport, a delivery van) goes through here.
 */
export function createTypedCar(x, y, angle, type = 'sedan', color, kind = 'parked') {
  const key = CAR_TYPES[type] ? type : 'sedan';
  const car = createCar(x, y, angle, color, kind);
  const profile = CAR_TYPES[key];
  car.type = key;
  car.label = profile.label;
  car.length = profile.length;
  car.width = profile.width;
  car.mass = profile.mass;
  car.maxHealth = profile.health;
  car.health = profile.health;
  car.fenceValue = profile.value;
  if (!color) {
    if (key === 'taxi') car.color = TAXI_YELLOW;
    else if (key === 'van' || key === 'pickup' || key === 'bus') car.color = defaultPaint(key, car.id);
  }
  car.siren = kind === 'police';
  return car;
}

/*
 * Coarse body class for systems that care about size rather than the exact
 * archetype: the traffic bus-lane rule wants "is this a bus", the collision
 * code wants "is this a long body", and neither should have to know the
 * archetype table. Never throws on a hand-built or half-built car.
 */
export function carClass(car) {
  if (!car) return 'car';
  if (car.siren === true || car.type === 'cruiser') return 'police';
  if (car.type === 'bus') return 'bus';
  if (car.type === 'pickup' || car.type === 'truck' || car.type === 'van') return 'utility';
  return 'car';
}

// True for the long, wide bodies that need extra room on a lane change.
export function isLongBody(car) {
  const p = carProfile(car);
  return p.length >= 78 || p.mass >= 2;
}

/* ------------------------------------------------------------------ */
/* 7. driving & integration                                            */
/* ------------------------------------------------------------------ */

/*
 * Arcade driving step.
 *
 * Longitudinal: throttle drives through a power curve that fades near the
 * top speed, the brake pedal is strong above walking pace and becomes
 * reverse below it, and coasting bleeds speed with a drag that grows with
 * speed share.
 *
 * Lateral: steering only bites once the car is rolling. Yaw is applied
 * directly (arcade, not a tyre model), but the resulting centripetal
 * demand is turned into slip: a car with less grip, or one on the
 * handbrake, keeps a sideways component that the body has to rotate back
 * out of. That slip is what moveCar turns into a visible slide, and it is
 * why a handbrake turn sticks the tail out.
 */
export function driveCar(car, throttle, steer, handbrake, dt) {
  const was = car.speed;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const p = carProfile(car);

  if (car.wrecked || step === 0) {
    if (car.wrecked) {
      car.speed = 0;
      car.slip = 0;
      car.steer = 0;
    }
    tickSiren(car, step);
    tickSmoke(car, step);
    tickFire(car, step);
    return car.speed - was;
  }

  const engine = clamp(1 - (car.engineDamage ?? 0) * ENGINE_POWER_LOSS, 0.22, 1);
  const tyre = tyreBite(car);
  const grip = effectiveGrip(car, p);

  // Sut off the ignition: no throttle, only drag and brakes.
  const live = car.ignition === false ? 0 : 1;
  const g = clamp(Number.isFinite(throttle) ? throttle : 0, -1, 1) * live;

  const maxSpeed = p.maxSpeed;
  const reverseMax = p.reverseMax;

  if (g > 0) {
    const head = clamp(car.speed / maxSpeed, 0, 1);
    const pull = p.accel * engine * (1 - head * head * 0.82);
    car.speed += pull * g * step;
  } else if (g < 0) {
    if (car.speed > 4) {
      car.speed = Math.max(0, car.speed - p.brake * -g * step);
    } else {
      car.speed -= p.reverseAccel * engine * -g * step;
    }
  } else {
    const share = Math.abs(car.speed) / maxSpeed;
    const drag = p.accel * (0.28 + 0.55 * share) * step;
    if (car.speed > 0) car.speed = Math.max(0, car.speed - drag);
    else if (car.speed < 0) car.speed = Math.min(0, car.speed + drag);
    // Engine braking is stronger with a damaged engine.
    car.speed *= 1 - clamp((1 - engine) * 0.35, 0, 0.2) * step;
  }

  // Handbrake: hard longitudinal bite, and it drops grip so the tail lets go.
  let sliding = false;
  if (handbrake) {
    const drop = p.handbrake * (0.65 + 0.35 * grip) * step;
    car.speed = car.speed > 0 ? Math.max(0, car.speed - drop) : Math.min(0, car.speed + drop);
    sliding = Math.abs(car.speed) > STEP_LOW_SPEED;
  }

  car.speed = clamp(car.speed, -reverseMax, maxSpeed);
  if (!Number.isFinite(car.speed)) car.speed = 0;

  const bite = clamp((Math.abs(car.speed) - STEER_FLOOR) / (STEER_FULL * heavySteer(car, p)), 0, 1);
  const dir = car.speed < -1 ? -1 : 1;
  const want = clamp(Number.isFinite(steer) ? steer : 0, -1, 1);

  const yawLoose = (sliding ? VEHICLE.driftYawBoost : 1) * (1 - (car.tyreDamage ?? 0) * TYRE_YAW_LOSS);
  const yawRate = want * p.turnRate * yawLoose * bite * dir * tyre;
  const dYaw = yawRate * step;
  car.angle += dYaw;
  car.steer = want;
  if (!Number.isFinite(car.angle)) car.angle = 0;

  /* ---- lateral slip ------------------------------------------------ */

  let slip = Number.isFinite(car.slip) ? car.slip : 0;

  // Yawing at speed pushes the body sideways unless the tyres hold. The
  // grip already includes tyre damage and weather, so a wet sport car
  // sheds the tail where a dry truck would just lean on its springs. The
  // archetype's own drift character then scales the transfer: a bus barely
  // sways, a sport car flick steps out immediately.
  const char = driftCharacter(car, p);
  const slipIn = dYaw * car.speed * slipShare(grip) * char;
  slip += slipIn;

  // Scrub the slide off. Handbrake keeps it alive, grip kills it. A body
  // that barely slips also recovers faster, so a bus is planted again
  // almost the moment it twitches instead of wallowing all block long.
  const recovery = VEHICLE.driftRecovery * grip
    * (sliding ? HANDBRAKE_SLIP_KEEP : 1)
    * (1.45 - char * 0.45)
    * SLIP_BLEED;
  slip *= Math.exp(-recovery * step);

  // Cap the slide so a spin cannot become a teleport; the cap follows the
  // drift character too, which is what stops a bus from yawing like a kart.
  const cap = Math.max(30, Math.abs(car.speed) * SLIP_MAX_SHARE * clamp(char, 0.55, 1.25));
  car.slip = clamp(slip, -cap, cap);
  if (!Number.isFinite(car.slip)) car.slip = 0;

  car.drifting = driftAmount(car) > DRIFT_THRESHOLD;
  car.yawRate = yawRate;
  car.gripNow = grip;
  car.driftChar = char;

  tickSiren(car, step);
  tickSmoke(car, step);
  tickFire(car, step);

  // Alarm only counts down while the stolen car is moving.
  if (car.alarm && Math.abs(car.speed) > 24) {
    car.theftHeat = clamp((car.theftHeat ?? 0) + step * 2.2, 0, POLICE.heatMax);
  }

  return car.speed - was;
}

export function moveCar(car, city, dt) {
  if (!Number.isFinite(car.speed) || !Number.isFinite(car.x) || !Number.isFinite(car.y)) {
    car.speed = 0;
    car.slip = 0;
    return 0;
  }

  tickSiren(car, dt);
  tickSmoke(car, dt);
  tickFire(car, dt);

  if (Math.abs(car.speed) < STILL && Math.abs(car.slip ?? 0) < STILL) return 0;

  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const c = Math.cos(car.angle), s = Math.sin(car.angle);
  const lat = Number.isFinite(car.slip) ? car.slip : 0;

  car.x += (c * car.speed - s * lat) * step;
  car.y += (s * car.speed + c * lat) * step;

  const impact = resolveCollisions(car, city);

  // Scraping a wall also scrubs the slide.
  if (impact > 0) car.slip = (car.slip ?? 0) * 0.35;

  return impact;
}

/* ------------------------------------------------------------------ */
/* 8. collision resolution                                            */
/* ------------------------------------------------------------------ */

function pushCircle(cx, cy, cr, c) {
  const dx = cx - c.x, dy = cy - c.y, reach = cr + c.r, d2 = dx * dx + dy * dy;
  if (d2 > reach * reach) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-6) return { x: c.x + reach, y: c.y, nx: 1, ny: 0, depth: reach };
  return {
    x: c.x + (dx / d) * reach,
    y: c.y + (dy / d) * reach,
    nx: dx / d,
    ny: dy / d,
    depth: reach - d,
  };
}

// Two relaxed passes, then a hard clamp inside the shoreline and map.
export function resolveCollisions(car, city) {
  let impact = 0, contacts = 0;

  for (let pass = 0; pass < 2; pass++) {
    let hitAny = false;
    for (const circ of carCircles(car)) {
      for (const c of city.collidersNear(circ.x, circ.y, circ.r)) {
        const hit = c.kind === 'circle'
          ? pushCircle(circ.x, circ.y, circ.r, c)
          : resolveCircleRect(circ.x, circ.y, circ.r, c);
        if (!hit) continue;

        car.x += hit.x - circ.x;
        car.y += hit.y - circ.y;
        circ.x = hit.x;
        circ.y = hit.y;

        contacts++;
        hitAny = true;
        impact = Math.max(impact, hit.depth);
      }
    }
    if (!hitAny) break;
  }

  const margin = (car.width ?? VEHICLE.width) * 0.7;
  if (!Number.isFinite(car.x)) car.x = margin;
  if (!Number.isFinite(car.y)) car.y = margin;
  if (car.x < margin) car.x = margin;
  if (car.x > city.shoreline - margin) car.x = city.shoreline - margin;
  if (car.y < margin) car.y = margin;
  if (car.y > city.height - margin) car.y = city.height - margin;

  if (contacts > 0) {
    const sev = Math.abs(car.speed);
    // A heavy body carries its momentum through a scrape; a light one is
    // thrown off line. Bounded so even a bus loses something on a wall.
    const mass = Math.max(0.5, car.mass ?? 1);
    const keep = clamp(CRASH_KEEP + (mass - 1) * 0.14, CRASH_KEEP, 0.72);
    car.speed *= keep;
    if (sev > HARD_CRASH) car.speed = car.speed >= 0 ? HARD_CRASH_SPEED : -HARD_CRASH_SPEED;

    // Crash damage scales with how hard and how deep the body went in.
    // Penetration is in world units, so it is normalised before it can
    // multiply the severity — otherwise one hard clip deletes the body.
    if (sev > IMPACT_MIN_SPEED && !car.wrecked) {
      const armor = mass > 1.2 ? 1.4 : 1;
      const speedShare = clamp(sev / VEHICLE.maxSpeed, 0, 1.2);
      const depth = clamp(impact / 12, 0, 1);
      // A body that is already creased folds a little faster on the next hit.
      const fragility = tierFragility(car);
      const dmg = speedShare * depth * IMPACT_SCALE * BODY_HEALTH * fragility / (armor * mass);
      if (dmg > 0.5) {
        damageCar(car, dmg);
        car.crashShake = clamp(speedShare * depth * 2, 0, 1);
      }
    }
  }

  return impact;
}

/*
 * Historical spelling of resolveCollisions(). It was the name this module
 * shipped with before the section was rewritten, and although nothing in the
 * current tree imports it, keeping the alias means any older caller — a probe
 * script, a save-game migration, an out-of-tree harness — still resolves
 * instead of dying on a missing export. Same function, so behaviour is
 * identical by construction.
 */
export const resolveCarCollisions = resolveCollisions;

/* ------------------------------------------------------------------ */
/* 9. theft                                                           */
/* ------------------------------------------------------------------ */

const THEFT_REACH = 74;       // how close a body has to be to touch a door
const THEFT_HEAT_DEFAULT = 18;
const THEFT_HEAT = POLICE.heatGain?.stealCar ?? THEFT_HEAT_DEFAULT;

/*
 * Can this body take this car right now? Returns a reason string so the
 * HUD can prompt ("LOCKED — HOTWIRE", "TOO FAR", "WRECKED") instead of
 * just failing.
 */
export function canStealCar(car, actor, distance = THEFT_REACH) {
  if (!car) return { ok: false, reason: 'missing' };
  if (car.wrecked) return { ok: false, reason: 'wrecked' };
  if (car.occupied) return { ok: false, reason: 'occupied' };
  if (car.hotwiring) {
    return { ok: false, reason: 'hotwiring', hotwireT: car.hotwireT ?? 0 };
  }
  if (actor && actor.car) return { ok: false, reason: 'seated' };
  if (actor && actor.down) return { ok: false, reason: 'down' };

  if (actor && Number.isFinite(actor.x) && Number.isFinite(actor.y)) {
    const reach = Number.isFinite(distance) ? distance : THEFT_REACH;
    const gap = Math.hypot(car.x - actor.x, car.y - actor.y);
    if (gap > reach) return { ok: false, reason: 'far', gap };
  }

  if (car.locked) {
    const p = carProfile(car);
    return {
      ok: false,
      reason: 'locked',
      needsHotwire: true,
      hotwireTime: p.hotwire * clamp(1 + (car.tyreDamage ?? 0) * 0.5, 1, 1.6),
    };
  }

  return { ok: true, reason: null };
}

/*
 * Start (or finish) taking the car.
 *
 * A locked car with a dead ignition does not open on a tug: the first call
 * begins a hotwire, and the caller must pump tickHotwire() until it
 * reports done. Anything else is a straight hop-in. Returns a small result
 * object so the caller knows whether it now owns a seat and how much heat
 * the theft earned.
 */
export function stealCar(car, actor) {
  const check = canStealCar(car, actor);
  if (!check.ok) {
    if (check.reason === 'locked' && actor) {
      car.hotwiring = true;
      car.hotwireT = 0;
      car.alarm = true;
      return {
        ok: false,
        reason: 'hotwiring',
        car,
        hotwireTime: check.hotwireTime,
        heat: THEFT_HEAT * 0.35,
      };
    }
    return { ok: false, reason: check.reason, car, heat: 0 };
  }

  return finishSteal(car, actor, false);
}

/*
 * Advance a hotwire by dt seconds. Returns the remaining seconds (0 when
 * done). Finishing hands the actor the seat and marks the body stolen.
 */
export function tickHotwire(car, actor, dt) {
  if (!car || !car.hotwiring) return 0;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const p = carProfile(car);
  const total = p.hotwire * clamp(1 + (car.tyreDamage ?? 0) * 0.5, 1, 1.6);
  car.hotwireT = clamp((car.hotwireT ?? 0) + step, 0, total);
  if (car.hotwireT < total) return total - car.hotwireT;

  car.hotwiring = false;
  finishSteal(car, actor, true);
  return 0;
}

// Shared tail of the theft: occupy, flag ownership, set the ignition live.
function finishSteal(car, actor, byHotwire) {
  car.hotwiring = false;
  car.locked = false;
  car.ignition = true;
  car.occupied = true;
  car.stolen = true;
  car.stolenBy = actor ?? null;
  car.speed = 0;
  car.slip = 0;
  car.steer = 0;
  car.theftHeat = Math.max(car.theftHeat ?? 0, THEFT_HEAT);
  delete car.driver;

  return {
    ok: true,
    reason: null,
    car,
    byHotwire,
    heat: byHotwire ? THEFT_HEAT : THEFT_HEAT * 0.6,
    value: car.fenceValue ?? carProfile(car).value,
  };
}

// After a chase: kill the alarm, drop the stolen flag, let the car re-lock.
export function coolCar(car) {
  if (!car) return;
  car.alarm = false;
  car.theftHeat = 0;
  car.stolen = false;
  car.stolenBy = null;
  if (!car.occupied) car.locked = true;
}

/* ------------------------------------------------------------------ */
/* 10. lookups                                                        */
/* ------------------------------------------------------------------ */

export function carsTouching(a, b) {
  const A = carCircles(a), B = carCircles(b);
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      const dx = A[i].x - B[j].x, dy = A[i].y - B[j].y, reach = A[i].r + B[j].r;
      if (dx * dx + dy * dy < reach * reach) return true;
    }
  }
  return false;
}

export function nearestCar(cars, x, y, maxDistance = 78) {
  if (!cars) return null;
  let best = null, bestD = maxDistance * maxDistance;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c || c.occupied || c.wrecked) continue;
    const dx = c.x - x, dy = c.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Door side away from the curb line; nudged well clear of the body.
export function exitPosition(car) {
  const nx = -Math.sin(car.angle), ny = Math.cos(car.angle);
  const side = ny > 0 ? -1 : 1;
  const width = car.width ?? VEHICLE.width;
  const reach = width * 0.5 + 16;
  return { x: car.x + nx * reach * side, y: car.y + ny * reach * side };
}

export function isHardImpact(impact) {
  return impact > HARD_CONTACT;
}
