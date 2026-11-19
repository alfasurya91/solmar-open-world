// The one body the human controls: where it stands, how much momentum it still carries, which way
// it faces, whether it is sitting in a car and how it gets back out. Nothing in here listens to the
// keyboard or paints a pixel — main.js turns input into a movement vector and render.js draws
// whatever state is left behind.
//
// On foot the body is a circle. Every solid thing in Solmar — a building footprint, a kerb, a lamp
// post, a tree trunk — is pushed against that circle through the city's own collider query, so the
// rules hold everywhere. Cars live in vehicles.js; this module just rides along with the one the
// player has taken, and looks for a clear patch of pavement when they step out.

import { PLAYER } from './config.js';
import { clamp, resolveCircleRect } from './utils.js';
import { exitPosition } from './vehicles.js';

/** Inset from the map border a body is still allowed to occupy. */
const EDGE = 12;

/** Extra padding on the body radius, so the sprite never looks like it touches concrete. */
const SKIN = 1.5;

/** How fast leftover momentum bleeds off when no direction is held, in 1/seconds. */
const COAST = 16;

/** Two relaxation passes: leaving one wall can shove the body into the next. */
const PASSES = 2;

/** Below this speed a drifting body is simply frozen, so it never creeps for ever. */
const CREEP = 1;

/**
 * Build the player. The spawn point is the city's; health comes off the tuning sheet; the wallet
 * and the car start empty. `walking`, `steps` and `hurtFlash` are read by the renderer and the HUD
 * rather than by any rule in here.
 */
export function createPlayer(city) {
  const spawn = city.spawn ?? {
    x: city.downtown.x,
    y: city.downtown.y,
    facing: Math.PI / 2,
  };

  return {
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing: Number.isFinite(spawn.facing) ? spawn.facing : Math.PI / 2,
    radius: PLAYER.radius,
    health: PLAYER.maxHealth,
    money: 0,
    cash: 0,
    walking: 0,
    steps: 0,
    car: null,
    hurtFlash: 0,
    down: false,
  };
}

/**
 * Advance the player by one fixed step. Sitting in a car the body is a passenger — vehicles.js has
 * already moved the car, so copying its pose is all that is needed. On foot the body accelerates
 * towards the held direction, coasts when nothing is held, and is then shoved clear of anything
 * solid it has ended up inside.
 */
export function updatePlayer(player, city, input, dt) {
  if (player.hurtFlash > 0) {
    player.hurtFlash = Math.max(0, player.hurtFlash - dt);
  }

  // Behind the wheel, the car is the authority on position and heading.
  if (player.car) {
    const car = player.car;
    player.x = car.x;
    player.y = car.y;
    player.facing = car.angle;
    player.vx = 0;
    player.vy = 0;
    player.walking = 0;
    return;
  }

  const move = input.move();
  const running = typeof input.running === 'function' ? input.running() : false;

  // Any non-zero direction becomes a unit vector; a zero vector means "stand still".
  const len = Math.hypot(move.x, move.y);
  const dirX = len > 0 ? move.x / len : 0;
  const dirY = len > 0 ? move.y / len : 0;

  if (len > 0) {
    player.facing = Math.atan2(dirY, dirX);
    // The renderer only wants a monotonic walk clock; running swings the legs faster.
    player.walking += (running ? 1.7 : 1) * dt;
  }

  const top = running ? PLAYER.runSpeed : PLAYER.walkSpeed;

  if (len > 0) {
    // Exponential ease towards the target velocity, so 30 Hz and 60 Hz land in the same place.
    const grip = 1 - Math.exp(-PLAYER.accel * dt);
    player.vx += (dirX * top - player.vx) * grip;
    player.vy += (dirY * top - player.vy) * grip;
  } else {
    const keep = Math.exp(-COAST * dt);
    player.vx *= keep;
    player.vy *= keep;
    if (Math.abs(player.vx) < CREEP) player.vx = 0;
    if (Math.abs(player.vy) < CREEP) player.vy = 0;
  }

  // The axes are integrated one at a time, so brushing the sea or a pier rail slides the walker
  // along it instead of stopping a diagonal dead.
  const fromX = player.x;
  const fromY = player.y;

  player.x += player.vx * dt;
  if (city.isWater(player.x, player.y)) {
    player.x = fromX;
    player.vx = 0;
  }

  player.y += player.vy * dt;
  if (city.isWater(player.x, player.y)) {
    player.y = fromY;
    player.vy = 0;
  }

  pushOutOfWorld(player, city);

  // A distance, not a clock: render.js derives the stride from how far the feet actually travelled.
  player.steps += Math.hypot(player.vx, player.vy) * dt;
}

/**
 * Settle the body against the city: resolve every solid overlap the move created, then keep it
 * inside the mapped area. Velocity aimed into a surface is cancelled; the rest slides along it.
 */
function pushOutOfWorld(player, city) {
  const r = player.radius + SKIN;

  for (let pass = 0; pass < PASSES; pass += 1) {
    let touched = false;

    for (const collider of city.collidersNear(player.x, player.y, r)) {
      const hit = collider.kind === 'circle'
        ? pushFromCircle(player.x, player.y, r, collider)
        : resolveCircleRect(player.x, player.y, r, collider);
      if (!hit) continue;

      player.x = hit.x;
      player.y = hit.y;
      touched = true;

      // Only the component pushing into the wall is removed, which is what makes a wall a slide.
      const into = player.vx * hit.nx + player.vy * hit.ny;
      if (into < 0) {
        player.vx -= hit.nx * into;
        player.vy -= hit.ny * into;
      }
    }

    if (!touched) break;
  }

  player.x = clamp(player.x, EDGE, city.water.x + city.water.w - EDGE);
  player.y = clamp(player.y, EDGE, city.height - EDGE);
}

/**
 * Circle against a round collider — a lamp post or a tree trunk. The return shape matches
 * resolveCircleRect, so the caller can handle both the same way.
 */
function pushFromCircle(px, py, pr, collider) {
  const dx = px - collider.x;
  const dy = py - collider.y;
  const reach = pr + collider.r;
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

/** Would a body of `radius` fit at (x, y)? Inside the map, dry, and clear of every solid. */
function fits(city, x, y, radius) {
  if (x < EDGE || y < EDGE) return false;
  if (x > city.water.x + city.water.w - EDGE || y > city.height - EDGE) return false;
  if (city.isWater(x, y)) return false;

  for (const collider of city.collidersNear(x, y, radius)) {
    if (collider.kind === 'circle') {
      if (pushFromCircle(x, y, radius, collider)) return false;
    } else if (resolveCircleRect(x, y, radius, collider)) {
      return false;
    }
  }

  return true;
}

/** Take the wheel. Refused when already driving, when there is no car, or when it is taken. */
export function enterCar(player, car) {
  if (!car || player.car || car.occupied) return false;

  car.occupied = true;
  car.speed = 0;
  car.steer = 0;

  player.car = car;
  player.walking = 0;
  player.x = car.x;
  player.y = car.y;
  player.facing = car.angle;
  player.vx = 0;
  player.vy = 0;
  return true;
}

/**
 * Get out. The kerb-side door is tried first; if that patch is walled in the search widens round the
 * car — both flanks, then nose and tail, then a further ring — so the driver never steps into a
 * facade. Should every side be blocked the body is dropped beside the car and the next collision
 * pass nudges it the rest of the way out.
 */
export function leaveCar(player, city) {
  const car = player.car;
  if (!car) return false;

  const comfortable = exitPosition(car);
  let spot = fits(city, comfortable.x, comfortable.y, player.radius) ? comfortable : null;

  if (!spot) {
    const near = car.width * 0.5 + 16;
    const far = car.width * 0.5 + 34;
    const sides = [
      car.angle + Math.PI / 2,
      car.angle - Math.PI / 2,
      car.angle + Math.PI,
      car.angle,
    ];

    for (const distance of [near, (near + far) / 2, far]) {
      for (const heading of sides) {
        const x = car.x + Math.cos(heading) * distance;
        const y = car.y + Math.sin(heading) * distance;
        if (fits(city, x, y, player.radius)) {
          spot = { x, y };
          break;
        }
      }
      if (spot) break;
    }
  }

  if (!spot) {
    spot = {
      x: clamp(comfortable.x, EDGE, city.water.x + city.water.w - EDGE),
      y: clamp(comfortable.y, EDGE, city.height - EDGE),
    };
  }

  car.occupied = false;
  car.speed = 0;
  car.steer = 0;

  player.car = null;
  player.x = clamp(spot.x, EDGE, city.water.x + city.water.w - EDGE);
  player.y = clamp(spot.y, EDGE, city.height - EDGE);
  player.vx = 0;
  player.vy = 0;
  player.facing = car.angle + Math.PI / 2;
  return true;
}
