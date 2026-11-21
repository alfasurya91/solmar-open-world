// Car factory and the one arcade driving model the whole town shares.
//
// Every body in Solmar — kerbside wrecks, NPC hatchbacks, police cruisers, the car the player
// steals — is a rectangle with two collision circles riding on its centre line. That single shape
// is what bullets test against, what shunts resolve against and what the city's walls push back on,
// so all three systems always agree about where a given car is.
//
// The handling is deliberately crude: throttle, a brake pedal that becomes reverse once the car has
// almost stopped, steering that only bites when the wheels are rolling, drag that grows with speed,
// and a handbrake that scrubs speed off. Nothing here paints, reads input, or knows about the crowd.

import { CAR_COLORS, VEHICLE } from './config.js';
import { clamp, resolveCircleRect } from './utils.js';

/** Every car gets a monotonically increasing id, so other systems can name one body. */
let nextCarId = 1;

/** Beneath this speed the wheels are effectively locked and steering does nothing. */
const STEER_FLOOR = 16;

/** Speed band above the floor over which the steering goes from nothing to full bite. */
const STEER_FULL = 110;

/** A contact deeper than this is a real shunt, worth a camera shake. */
const HARD_CONTACT = 0.4;

/** Fraction of the speed that survives a wall contact. */
const CRASH_KEEP = 0.36;

/** A contact faster than this is head-on: the car is knocked back to a crawl. */
const HARD_CRASH = 130;

/** The crawl that a head-on leaves behind. */
const HARD_CRASH_SPEED = 45;

/** Speeds below this skip collision work altogether. */
const STILL = 0.001;

/**
 * Build a car sitting at (x, y) and pointing along `angle` radians, where 0 is east and +y grows
 * south. `kind` is 'parked' | 'npc' | 'stolen' | 'police' and tells the rest of the game what the
 * body means; the AI-only fields start neutral so a parked car can be upgraded in place.
 */
export function createCar(x, y, angle, color, kind = 'parked') {
  return {
    id: nextCarId++,
    x,
    y,
    angle,
    speed: 0,
    steer: 0,
    color: color ?? CAR_COLORS[0],
    kind,
    length: VEHICLE.length,
    width: VEHICLE.width,
    occupied: false,
    // Only the NPC drivers and patrol units fill these in; they are harmless on a parked body.
    dir: 0,
    target: null,
    cruise: 0,
    blocked: 0,
  };
}

/**
 * The pair of circles standing in for the body: one pushed ahead of the centre, one behind, each
 * slightly wider than half the car so the flanks are covered as well. Everything that has to decide
 * "did this car hit that?" resolves against these two.
 */
export function carCircles(car) {
  const offset = (car.length ?? VEHICLE.length) * 0.25;
  const radius = (car.width ?? VEHICLE.width) * 0.52;
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);

  return [
    { x: car.x + cos * offset, y: car.y + sin * offset, r: radius },
    { x: car.x - cos * offset, y: car.y - sin * offset, r: radius },
  ];
}

/** Axis-aligned bounding box of the rotated body, used by bays, culling and the minimap. */
export function carExtents(car) {
  const length = car.length ?? VEHICLE.length;
  const width = car.width ?? VEHICLE.width;
  const cos = Math.abs(Math.cos(car.angle));
  const sin = Math.abs(Math.sin(car.angle));

  return {
    w: length * cos + width * sin,
    h: length * sin + width * cos,
  };
}

/** Squared centre-to-centre distance, so hot loops never need the square root. */
export function carDistance2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Advance the player's pedals by one step.
 *
 * `throttle` is +1 for forward, -1 for brake-then-reverse, 0 to coast. `steer` runs -1..1 with +1
 * to the right. `handbrake` locks the wheels. The return value is the speed change over the step,
 * which the callers use to pitch the engine or light the brake lamps.
 */
export function driveCar(car, throttle, steer, handbrake, dt) {
  const startSpeed = car.speed;
  const gas = clamp(throttle, -1, 1);

  if (gas > 0) {
    car.speed += VEHICLE.accel * gas * dt;
  } else if (gas < 0) {
    if (car.speed > 4) {
      // Still rolling forward, so the pedal acts as a brake; reverse only engages near a standstill.
      car.speed = Math.max(0, car.speed - VEHICLE.brake * -gas * dt);
    } else {
      car.speed -= VEHICLE.reverseAccel * -gas * dt;
    }
  } else {
    // Rolling resistance: a flat part plus one that grows with speed, standing in for air. Their sum
    // stays below the engine's pull, so a held throttle still climbs to the top speed.
    const share = Math.abs(car.speed) / VEHICLE.maxSpeed;
    const drag = VEHICLE.accel * (0.28 + 0.55 * share) * dt;
    if (car.speed > 0) car.speed = Math.max(0, car.speed - drag);
    else if (car.speed < 0) car.speed = Math.min(0, car.speed + drag);
  }

  if (handbrake) {
    const drop = VEHICLE.handbrake * dt;
    car.speed = car.speed > 0
      ? Math.max(0, car.speed - drop)
      : Math.min(0, car.speed + drop);
  }

  car.speed = clamp(car.speed, -VEHICLE.reverseMax, VEHICLE.maxSpeed);

  // The wheel bites in with speed and mirrors in reverse, so backing up turns like a real car.
  const bite = clamp((Math.abs(car.speed) - STEER_FLOOR) / STEER_FULL, 0, 1);
  const direction = car.speed < -1 ? -1 : 1;
  const loose = handbrake ? 1.35 : 1;
  const wanted = clamp(Number.isFinite(steer) ? steer : 0, -1, 1);

  car.angle += wanted * VEHICLE.turnRate * loose * bite * direction * dt;
  car.steer = wanted;

  if (!Number.isFinite(car.angle)) car.angle = 0;
  return car.speed - startSpeed;
}

/**
 * Carry the body along its heading by whatever speed it holds this step, then settle it against the
 * city. Returns the depth of the worst wall contact (0 when the road ahead was clear) so main.js can
 * shake the camera and charge the driver for a genuine crash.
 */
export function moveCar(car, city, dt) {
  if (!Number.isFinite(car.speed) || !Number.isFinite(car.x) || !Number.isFinite(car.y)) {
    car.speed = 0;
    return 0;
  }

  if (Math.abs(car.speed) < STILL) return 0;

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;

  return resolveCarCollisions(car, city);
}

/**
 * Push both body circles clear of the world. A contact moves the whole car by the same delta the
 * circle was moved, so a corner scrape twists the body off the wall instead of burying the nose.
 * Speed is scrubbed hard on any contact, and a head-on shunt drops the car to a crawl rather than
 * letting it climb the facade. Two passes, because escaping one wall can push the other circle into
 * the next.
 */
export function resolveCarCollisions(car, city) {
  let impact = 0;
  let contacts = 0;

  for (let pass = 0; pass < 2; pass += 1) {
    let touched = false;

    for (const circle of carCircles(car)) {
      for (const collider of city.collidersNear(circle.x, circle.y, circle.r)) {
        const hit = collider.kind === 'circle'
          ? pushFromCircle(circle.x, circle.y, circle.r, collider)
          : resolveCircleRect(circle.x, circle.y, circle.r, collider);
        if (!hit) continue;

        // Shift the car by the same delta the circle moved, and keep the circle in step so the
        // second body circle is tested against the corrected pose.
        car.x += hit.x - circle.x;
        car.y += hit.y - circle.y;
        circle.x = hit.x;
        circle.y = hit.y;

        contacts += 1;
        touched = true;
        impact = Math.max(impact, hit.depth);
      }
    }

    if (!touched) break;
  }

  // The map's own edges: no driving out over the water or off the sand at the top.
  const margin = (car.width ?? VEHICLE.width) * 0.7;
  if (!Number.isFinite(car.x)) car.x = limitTo(city.downtown?.x ?? 0, margin);
  if (!Number.isFinite(car.y)) car.y = limitTo(city.downtown?.y ?? 0, margin);
  if (car.x < margin) car.x = margin;
  if (car.x > city.shoreline - margin) car.x = city.shoreline - margin;
  if (car.y < margin) car.y = margin;
  if (car.y > city.height - margin) car.y = city.height - margin;

  if (contacts > 0) {
    const severity = Math.abs(car.speed);
    car.speed *= CRASH_KEEP;
    if (severity > HARD_CRASH) {
      car.speed = car.speed >= 0 ? HARD_CRASH_SPEED : -HARD_CRASH_SPEED;
    }
  }

  return impact;
}

/** Clamp a possibly-corrupt coordinate up to at least `margin`. */
function limitTo(value, margin) {
  return Number.isFinite(value) ? Math.max(margin, value) : margin;
}

/**
 * Circle against a round collider — a lamp post or a tree trunk. Return shape matches
 * resolveCircleRect on purpose, so callers can treat both the same way.
 */
function pushFromCircle(cx, cy, cr, collider) {
  const dx = cx - collider.x;
  const dy = cy - collider.y;
  const reach = cr + collider.r;
  const d2 = dx * dx + dy * dy;

  if (d2 > reach * reach) return null;

  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    // Dead centre: pick an arbitrary but stable direction.
    return { x: collider.x + reach, y: collider.y, nx: 1, ny: 0, depth: reach };
  }

  return {
    x: collider.x + (dx / d) * reach,
    y: collider.y + (dy / d) * reach,
    nx: dx / d,
    ny: dy / d,
    depth: reach - d,
  };
}

/** Do two car bodies overlap? Police shunts and patrol spacing both ask. */
export function carsTouching(a, b) {
  const one = carCircles(a);
  const two = carCircles(b);

  for (let i = 0; i < one.length; i += 1) {
    for (let j = 0; j < two.length; j += 1) {
      const dx = one[i].x - two[j].x;
      const dy = one[i].y - two[j].y;
      const reach = one[i].r + two[j].r;
      if (dx * dx + dy * dy < reach * reach) return true;
    }
  }

  return false;
}

/**
 * The nearest free car to a point, or null. Occupied bodies are skipped. The default reach is
 * generous on purpose: standing beside a car should be enough to press the interact key.
 */
export function nearestCar(cars, x, y, maxDistance = 78) {
  if (!cars) return null;

  let best = null;
  let bestD = maxDistance * maxDistance;

  for (let i = 0; i < cars.length; i += 1) {
    const car = cars[i];
    if (!car || car.occupied) continue;

    const dx = car.x - x;
    const dy = car.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = car;
    }
  }

  return best;
}

/**
 * Where a driver steps out: beside the body, on the side facing the bottom of the screen for a car
 * pointing east or west — which is the kerb for the grid's lanes. The caller checks it is clear.
 */
export function exitPosition(car) {
  const nx = -Math.sin(car.angle);
  const ny = Math.cos(car.angle);
  const side = ny > 0 ? -1 : 1;
  const reach = car.width * 0.5 + 16;

  return {
    x: car.x + nx * reach * side,
    y: car.y + ny * reach * side,
  };
}

/** True when a contact this step was hard enough to be worth a camera shake. */
export function isHardImpact(impact) {
  return impact > HARD_CONTACT;
}