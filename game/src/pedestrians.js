// Pedestrians: the crowd. Each walker is pinned to one of the city's closed walkway loops — the
// sidewalk ring inside a block, the promenade strip along the coast, the pier deck — and slides
// along it at its own pace, offset to one side so the two directions of foot traffic pass each
// other. There is no pathfinding and no collision solver: the loop *is* the pavement, so nobody can
// wander into the road. Crowds bunch and spread by themselves because every person has a slightly
// different stride, and they step aside for the player and bolt when a car comes at them.

import { PEDS, PED_SHIRTS, PED_SKINS } from './config.js';
import { clamp, distance, lerp } from './utils.js';

/** How long a flattened pedestrian lies on the tarmac before getting up. */
const DOWN_TIME = 4.5;

/** How long they hurry once back on their feet. */
const HURT_TIME = 0.7;

/** Distance within which somebody makes room for the player. */
const PERSONAL_SPACE = 30;

/** How far away a car is felt as a threat. */
const CAR_FEAR = 46;

/** Speed at which a passing car becomes frightening. */
const SCARY_SPEED = 55;

/** How quickly a shove away from the pavement fades once the danger has passed. */
const RECOVER = 2.4;

/** Sideways shove limit, in pixels: enough to step round somebody, not enough to reach the road. */
const OFFSET_LIMIT = 9;

/** A walkway is usable only if it is a loop of at least two points. */
function hasRoute(walkway) {
  return !!walkway && Array.isArray(walkway.points) && walkway.points.length >= 2;
}

/** Perimeter of a closed loop of points, in pixels. */
function routeLength(points) {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += distance(a.x, a.y, b.x, b.y);
  }
  return total;
}

/**
 * Build the crowd and hand back the live list, the step function and the knock-down helper. Most
 * walkers circle the blocks; every seventh one is out on the promenade or the pier. The block rings
 * come first in `city.walkways`, so the list splits at the block count.
 */
export function createPedestrians(city, rng) {
  const list = [];

  /**
   * Turn a walker's arc-length `s` into a place on the loop: walk the segments until the distance is
   * spent, then interpolate. `offset` shifts the walker sideways along the segment normal, which is
   * what keeps two people walking opposite ways off the same pixel. The result lands in `lx`/`ly`.
   */
  function placeOnRoute(ped) {
    const pts = ped.route;
    if (!Array.isArray(pts) || pts.length < 2) return;

    const count = pts.length;
    const length = ped.length > 0 ? ped.length : 1;

    // Wrap s into [0, length): walking backwards must not produce a negative arc length.
    let s = ((ped.s % length) + length) % length;

    for (let i = 0; i < count; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % count];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const seg = Math.hypot(dx, dy);
      if (seg < 1e-6) continue;

      if (s <= seg) {
        const t = s / seg;
        // The left-hand normal of the segment: a stable "which side of the pavement" direction.
        const nx = -dy / seg;
        const ny = dx / seg;

        ped.lx = lerp(a.x, b.x, t) + nx * ped.offset;
        ped.ly = lerp(a.y, b.y, t) + ny * ped.offset;

        const forward = Math.atan2(dy, dx);
        // A walker going round the loop backwards faces the other way.
        ped.facing = ped.dirSign > 0 ? forward : forward + Math.PI;
        return;
      }

      s -= seg;
    }

    // Only a degenerate loop reaches here: park on the first point rather than at (0, 0).
    ped.lx = pts[0].x;
    ped.ly = pts[0].y;
  }

  /** Put the visible body where the loop says, plus whatever shove is still fading out. */
  function settle(ped) {
    ped.x = ped.lx + ped.pushX;
    ped.y = ped.ly + ped.pushY;
    ped.onRoute = true;
  }

  /** One person, dropped onto a loop at `along` (0..1 of its length). */
  function spawnPed(points, along) {
    const length = routeLength(points);

    const ped = {
      route: points,
      length,
      s: clamp(along, 0, 1) * length,
      dirSign: rng.chance(0.5) ? 1 : -1,
      base: rng.range(24, 46),
      speed: 0,
      x: points[0].x,
      y: points[0].y,
      lx: points[0].x,
      ly: points[0].y,
      pushX: 0,
      pushY: 0,
      facing: 0,
      walkPhase: rng.range(0, Math.PI * 2),
      shirt: rng.pick(PED_SHIRTS),
      skin: rng.pick(PED_SKINS),
      hat: rng.chance(0.25),
      scale: rng.range(0.9, 1.08),
      offset: rng.range(-5, 5),
      paused: 0,
      down: 0,
      hurt: 0,
      // Combat writes these: a body with no hit points left stays down for good.
      hp: 100,
      stagger: 0,
      radius: 9,
      onRoute: true,
    };

    // Start already ambling rather than from a standstill.
    ped.speed = ped.base * 0.7;

    placeOnRoute(ped);
    settle(ped);
    return ped;
  }

  const blocks = Array.isArray(city.blocks) ? city.blocks.length : 0;
  const blockRoutes = city.walkways.slice(0, blocks).filter(hasRoute);
  const shoreRoutes = city.walkways.slice(blocks).filter(hasRoute);

  for (let i = 0; i < PEDS.count; i += 1) {
    const onShore = i % 7 === 0 && shoreRoutes.length > 0;
    const walkway = onShore
      ? rng.pick(shoreRoutes)
      : (blockRoutes.length > 0 ? rng.pick(blockRoutes) : rng.pick(shoreRoutes));

    if (!walkway) continue;
    list.push(spawnPed(walkway.points, rng()));
  }

  /** Beyond saving: combat sets `down` to true once hit points run out. */
  function isDead(ped) {
    return ped.down === true || ped.hp <= 0;
  }

  /**
   * One step for the crowd: advance along the loop, ease the pace, drift back to their own side of
   * the pavement, and recover from being shoved. A body that is down counts its time out and then
   * gets back up where it fell.
   */
  function update(dt, world) {
    const player = world?.player;
    const decay = Math.max(0, 1 - RECOVER * dt);

    for (let i = 0; i < list.length; i += 1) {
      const ped = list[i];

      if (isDead(ped)) {
        // Gone for good: lie still, do not advance, do not react.
        ped.down = true;
        ped.speed = 0;
        continue;
      }

      if (ped.down > 0) {
        // Knocked over: stay where the hit put them until the timer runs out.
        ped.down = Math.max(0, ped.down - dt);
        ped.speed = 0;
        if (ped.down === 0) ped.hurt = HURT_TIME;
        continue;
      }

      if (ped.hurt > 0) ped.hurt = Math.max(0, ped.hurt - dt);
      if (ped.stagger > 0) ped.stagger = Math.max(0, ped.stagger - dt);

      let pace = ped.base;

      if (ped.paused > 0) {
        ped.paused = Math.max(0, ped.paused - dt);
        pace = 0;
      }
      if (ped.hurt > 0) pace *= 1.9;
      if (ped.stagger > 0) pace *= 0.2;

      // Step aside for somebody walking straight at them: widen the gap and give a little ground.
      if (player) {
        const dx = ped.x - player.x;
        const dy = ped.y - player.y;
        const d2 = dx * dx + dy * dy;

        if (d2 < PERSONAL_SPACE * PERSONAL_SPACE && d2 > 0.01) {
          const d = Math.sqrt(d2) || 1;
          const sideways = ped.offset >= 0 ? 1 : -1;

          ped.offset = clamp(ped.offset + sideways * 18 * dt, -OFFSET_LIMIT, OFFSET_LIMIT);
          ped.pushX += (dx / d) * 12 * dt;
          ped.pushY += (dy / d) * 12 * dt;
        }
      }

      // A car close by and moving fast is worth running from for a moment.
      const threat = world?.carsNear ? world.carsNear(ped.x, ped.y, CAR_FEAR) : null;

      if (threat && Math.abs(threat.speed ?? 0) > SCARY_SPEED) {
        ped.hurt = Math.max(ped.hurt, 0.35);

        const ax = ped.x - threat.x;
        const ay = ped.y - threat.y;
        const ad = Math.hypot(ax, ay) || 1;

        ped.pushX += (ax / ad) * 95 * dt;
        ped.pushY += (ay / ad) * 95 * dt;
        ped.offset = clamp(ped.offset + (ax / ad) * 14 * dt, -OFFSET_LIMIT, OFFSET_LIMIT);
      }

      // Ease the pace, so people speed up and slow down instead of snapping between gaits.
      ped.speed += (pace - ped.speed) * Math.min(1, 3.2 * dt);
      if (pace === 0 && ped.speed < 0.4) ped.speed = 0;

      ped.s += ped.speed * ped.dirSign * dt;
      ped.walkPhase += ped.speed * dt * 0.32;

      // Recompose from the loop, then let any shove fade back onto the pavement.
      ped.pushX *= decay;
      ped.pushY *= decay;
      placeOnRoute(ped);
      settle(ped);
    }
  }

  /**
   * Flatten the nearest pedestrian within `radius` of (x, y) and return them, or null when nobody
   * was close enough. Called when the player's car ploughs through the crowd. A body already down
   * or already dead is never hit twice.
   */
  function knockAt(x, y, radius) {
    let best = null;
    let bestD = radius * radius;

    for (let i = 0; i < list.length; i += 1) {
      const ped = list[i];
      if (isDead(ped) || ped.down > 0) continue;

      const d2 = (ped.x - x) ** 2 + (ped.y - y) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        best = ped;
      }
    }

    if (!best) return null;

    best.down = DOWN_TIME;
    best.hurt = DOWN_TIME;
    best.speed = 0;
    return best;
  }

  return {
    list,
    update,
    knockAt,
    count: () => list.length,
  };
}