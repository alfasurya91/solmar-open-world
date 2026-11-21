// NPC traffic. A fleet of cars works the grid, each one keeping to the correct side of the street.
// A car knows which street it is on, which intersection it is heading for, and — on arrival — picks
// the next leg: usually straight on, a turn otherwise, never a U-turn. There is no pathfinding.
// Steering is rate-limited, the lane is corrected on every step, and a car that sees something in
// its path brakes to a halt — so corners come out as curves and queues form on their own.

import { CAR_COLORS, TRAFFIC } from './config.js';
import { angleDelta, clamp } from './utils.js';
import { createCar } from './vehicles.js';

/**
 * The heading order the whole game shares: 0 east, 1 south, 2 west, 3 north. Since +y grows
 * downwards, "south" is the direction of increasing y.
 */
const DIRS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

/** How close a car must come to a waypoint before that leg counts as driven. */
const ARRIVE = 20;

/** Hard cap on one leg, so a car that misses a waypoint cannot circle for ever. */
const LEG_TIMEOUT = 30;

/** Braking bites harder than acceleration pulls, as it does in a real car. */
const BRAKE_RATE = 380;
const PULL_RATE = 150;

/** The heading angle for a direction index. */
export function dirAngle(dir) {
  const d = DIRS[dir] ?? DIRS[0];
  return Math.atan2(d.y, d.x);
}

/**
 * Build the fleet and hand back the live list plus the step function. `TRAFFIC.count` cars are
 * dropped onto random points of random legs at construction time, clear of the player's spawn and
 * of each other.
 */
export function createTraffic(city, rng) {
  const cars = [];

  /** The lane point a car travelling `dir` on street `line` passes at intersection `node`. */
  function lanePoint(axis, line, dir, node) {
    if (axis === 'h') {
      return {
        x: city.vx[node],
        y: city.hy[line] + (dir === 0 ? TRAFFIC.lane : -TRAFFIC.lane),
      };
    }
    return {
      x: city.vx[line] + (dir === 1 ? -TRAFFIC.lane : TRAFFIC.lane),
      y: city.hy[node],
    };
  }

  /**
   * Grid indices of the street a car sits on. `across` is the row or column it runs along, `along`
   * is the index of the intersection it has reached.
   */
  function gridOf(car) {
    return car.axis === 'h'
      ? { across: car.line, along: car.node }
      : { across: car.node, along: car.line };
  }

  /** Point a car at a leg: its street, heading, target intersection and its single waypoint. */
  function applyLeg(car, axis, line, dir, node) {
    car.axis = axis;
    car.line = line;
    car.dir = dir;
    car.node = node;
    car.path = [lanePoint(axis, line, dir, node)];
    car.legAge = 0;
  }

  /** How many legs a car has room for along a given axis. */
  function legCount(axis) {
    return axis === 'h' ? city.cols : city.rows;
  }

  /**
   * Choose the next leg at the intersection the car is sitting on. Going straight is weighted
   * roughly five to four against turning, and the way back is never offered — which keeps the grid
   * flowing the way a city of one-way habits does.
   */
  function chooseLeg(car) {
    const { across, along } = gridOf(car);
    const options = [];

    if (car.axis === 'h') {
      if (along < city.cols) options.push(['h', across, 0, along + 1]);
      if (along > 0) options.push(['h', across, 2, along - 1]);
      if (across < city.rows) options.push(['v', along, 1, across + 1]);
      if (across > 0) options.push(['v', along, 3, across - 1]);
    } else {
      if (across < city.rows) options.push(['v', along, 1, across + 1]);
      if (across > 0) options.push(['v', along, 3, across - 1]);
      if (along < city.cols) options.push(['h', across, 0, along + 1]);
      if (along > 0) options.push(['h', across, 2, along - 1]);
    }

    if (options.length === 0) return false;

    // Straight gets five tickets, each turn four, and every legal option one safety ticket so even
    // a dead end still has somewhere to go.
    const straight = options.filter((leg) => leg[2] === car.dir);
    const turns = options.filter((leg) => leg[2] !== car.dir && leg[2] !== (car.dir + 2) % 4);

    const pool = [];
    for (let i = 0; i < 5; i += 1) {
      for (const leg of straight) pool.push(leg);
    }
    for (const leg of turns) pool.push(leg, leg, leg, leg);
    for (const leg of options) pool.push(leg);

    const pick = rng.pick(pool);
    if (!pick) return false;

    applyLeg(car, pick[0], pick[1], pick[2], pick[3]);
    return true;
  }

  /** Drop a car onto the lane at a point `t` of the way along the leg behind its target node. */
  function placeOnLeg(car, axis, line, dir, node, t) {
    const forward = dir === 0 || dir === 1;
    const back = forward ? node - 1 : node + 1;
    const limit = legCount(axis);
    const from = clamp(back, 0, limit);
    const to = clamp(node, 0, limit);
    const blend = (a, b) => a + (b - a) * t;

    if (axis === 'h') {
      car.y = city.hy[line] + (dir === 0 ? TRAFFIC.lane : -TRAFFIC.lane);
      car.x = blend(city.vx[from], city.vx[to]);
    } else {
      car.x = city.vx[line] + (dir === 1 ? -TRAFFIC.lane : TRAFFIC.lane);
      car.y = blend(city.hy[from], city.hy[to]);
    }
  }

  /** A new car, placed in a lane clear of the player's spawn and of everything already driving. */
  function spawnCar() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const horizontal = rng.chance(0.55);
      const axis = horizontal ? 'h' : 'v';
      const limit = legCount(axis);
      if (limit < 1) continue;

      // `line` indexes the streets running the other way; `node` is the intersection ahead.
      const line = rng.int(0, horizontal ? city.rows : city.cols);
      const dir = horizontal
        ? (rng.chance(0.5) ? 0 : 2)
        : (rng.chance(0.5) ? 1 : 3);
      const node = rng.int(1, limit);

      const car = createCar(0, 0, dirAngle(dir), rng.pick(CAR_COLORS), 'npc');
      placeOnLeg(car, axis, line, dir, node, rng.range(0.15, 0.85));

      // Never drop a car in the player's lap.
      if (Math.hypot(car.x - city.spawn.x, car.y - city.spawn.y) < 170) continue;

      // Nor on top of another car: a lane is a queue, not a pile-up.
      let crowded = false;
      for (const other of cars) {
        if (Math.hypot(other.x - car.x, other.y - car.y) < 72) {
          crowded = true;
          break;
        }
      }
      if (crowded) continue;

      applyLeg(car, axis, line, dir, node);
      car.cruise = rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed);
      car.speed = car.cruise * 0.6;
      cars.push(car);
      return car;
    }

    return null;
  }

  for (let i = 0; i < TRAFFIC.count; i += 1) spawnCar();

  /**
   * Is something in this car's way? Looks a little ahead of the nose — other cars, the player on
   * foot and the player's own car — and reports whether this car should stop for it.
   */
  function blockedAhead(car, world) {
    const look = DIRS[car.dir] ?? DIRS[0];
    const reach = 38 + Math.abs(car.speed) * 0.22;
    const ax = car.x + look.x * reach;
    const ay = car.y + look.y * reach;

    for (let i = 0; i < cars.length; i += 1) {
      const other = cars[i];
      if (other === car) continue;

      const dx = other.x - ax;
      const dy = other.y - ay;
      if (dx * dx + dy * dy < 36 * 36) return true;

      // Also stop when a body is nose-to-tail close, whatever the look-ahead point says.
      const sx = other.x - car.x;
      const sy = other.y - car.y;
      const ahead = sx * look.x + sy * look.y;
      if (ahead > 0 && ahead < 58 && Math.abs(sx * look.y - sy * look.x) < 26) return true;
    }

    const player = world?.player;
    if (player) {
      if (!player.car) {
        const dx = player.x - ax;
        const dy = player.y - ay;
        if (dx * dx + dy * dy < 32 * 32) return true;
      } else {
        // Yield to the player's car when it is in front of us, ignore it when it is behind.
        const dx = player.car.x - car.x;
        const dy = player.car.y - car.y;
        if (dx * dx + dy * dy < 66 * 66 && dx * look.x + dy * look.y > -12) return true;
      }
    }

    return false;
  }

  /** Ease the speed towards `want`; braking bites harder than acceleration pulls. */
  function approachSpeed(car, want, dt) {
    const diff = want - car.speed;
    const rate = diff < 0 ? BRAKE_RATE : PULL_RATE;
    car.speed = Math.max(0, car.speed + clamp(diff, -rate * dt, rate * dt));
  }

  /**
   * One step for every NPC car: steer towards the waypoint, pick a speed for the corner and the
   * queue, advance, then settle back into the lane. `world` supplies the player.
   */
  function update(dt, world) {
    for (let i = 0; i < cars.length; i += 1) {
      const car = cars[i];

      if (!car.path || car.path.length === 0) {
        if (!chooseLeg(car)) continue;
      }

      const target = car.path[0];

      // Steering: turn towards the waypoint only as fast as the wheels allow.
      const wanted = Math.atan2(target.y - car.y, target.x - car.x);
      const err = angleDelta(car.angle, wanted);
      const maxTurn = TRAFFIC.turnRate * dt;
      car.angle += clamp(err, -maxTurn, maxTurn);

      // Corner braking: the sharper the turn needed, the slower the approach.
      let want = car.cruise;
      const turn = Math.abs(err);
      if (turn > 0.55) want = Math.min(want, 42);
      else if (turn > 0.26) want = Math.min(want, 88);
      else if (turn > 0.1) want = Math.min(want, 128);

      const before = Math.hypot(target.x - car.x, target.y - car.y);
      if (before < 40) want = Math.min(want, 78);
      if (blockedAhead(car, world)) want = 0;

      approachSpeed(car, want, dt);

      car.x += Math.cos(car.angle) * car.speed * dt;
      car.y += Math.sin(car.angle) * car.speed * dt;

      // Arrived at — or sailed past — the waypoint, so the leg is done and the next one is chosen.
      const after = Math.hypot(target.x - car.x, target.y - car.y);
      car.legAge = (car.legAge ?? 0) + dt;
      const overshot = after > before && before < 34;
      if (after < ARRIVE || overshot || car.legAge > LEG_TIMEOUT) {
        car.path.shift();
        if (car.path.length === 0) chooseLeg(car);
      }

      // Stay in lane: a gentle pull towards the centre of this car's own half of the street.
      const pull = Math.min(1, 5 * dt);
      if (car.axis === 'h') {
        const laneY = city.hy[car.line] + (car.dir === 0 ? TRAFFIC.lane : -TRAFFIC.lane);
        car.y += (laneY - car.y) * pull;
      } else {
        const laneX = city.vx[car.line] + (car.dir === 1 ? -TRAFFIC.lane : TRAFFIC.lane);
        car.x += (laneX - car.x) * pull;
      }

      // A car that has gone numerically bad is parked back at the first intersection rather than
      // being left to poison the rest of the frame.
      if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.angle)) {
        car.x = city.vx[0];
        car.y = city.hy[0];
        car.angle = 0;
        car.speed = 0;
      }

      car.x = clamp(car.x, 20, city.width - 20);
      car.y = clamp(car.y, 20, city.height - 20);
    }

    // Light separation, so a queue does not stack every body on one pixel.
    for (let i = 0; i < cars.length; i += 1) {
      const a = cars[i];
      for (let j = i + 1; j < cars.length; j += 1) {
        const b = cars[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 40 * 40 || d2 < 1e-6) continue;

        const d = Math.sqrt(d2);
        const push = (40 - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;

        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        a.speed = Math.min(a.speed, 52);
        b.speed = Math.min(b.speed, 52);
      }
    }
  }

  return {
    list: cars,
    update,
    spawn: spawnCar,
    count: () => cars.length,
  };
}