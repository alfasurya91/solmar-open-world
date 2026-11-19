// The law in Solmar, in three stacked layers that only speak downward:
//
//   heat      the whole stars on the board, the fraction banked toward the next, and the cooldown
//   dispatch  how large a response the heat is worth and where a unit may step onto the map
//   pursuit   what a single officer or a single cruiser does with one step
//
// Nothing here draws, writes to a HUD or touches money. Officers and cruisers are plain objects so
// render.js can read them straight off the array (a cruiser hides its body under `unit.car`). The
// callback quartet onWanted / onArrest / onToast / onRam is the only path back into main.js.

import { angleDelta, clamp, distance, resolveCircleRect } from './utils.js';
import { carsTouching, createCar, driveCar, moveCar } from './vehicles.js';
import { policeFire } from './combat.js';

/** Five stars is the whole scale. */
export const MAX_STARS = 5;

/**
 * Heat tuning. `quietFor` is the grace window after a crime before any countdown runs; `coolFor`
 * the hidden seconds that buy a star back; `seenRecovery` how quickly that countdown unwinds while
 * a unit still has eyes on the player; `carSightBonus` the extra reach a cruiser's lights give.
 */
const HEAT = {
  quietFor: 5,
  coolFor: 9,
  seenRadius: 430,
  carSightBonus: 90,
  seenRecovery: 0.8,
};

/** A patrolman on foot: a touch quicker than a walk, a touch slower than a run, short reach. */
const FOOT = {
  speed: 188,
  radius: 9,
  hp: 58,
  arrestReach: 17,
  max: 7,
  wallFollow: 2.2, // tan of the lean along an obstacle: >1 means more sideways than forward
  slidePatience: 0.35, // seconds without progress before a pocketed officer commits to backing out
  backOut: 0.6, // how long that retreat lasts — long enough to clear the mouth of a pocket
  staggerShare: 0.25,
  fireFrom: 4,
  fireRange: 340,
  fireGap: [1.7, 2.6],
};

/** The cruiser: arrives off-screen, shunts a fleeing car, leaves a man at the kerb. */
const CRUISER = {
  max: 3,
  gap: 1.1,
  retireBeyond: 1700,
  deployWithin: 168,
  stopFoot: 84,
  stopCar: 52,
  ramCooldown: 1.1,
  ramKeep: 0.55,
  ramPush: 7,
  slowWithin: 96,
  slowTo: 95,
  stuckGain: 2.4,
  stuckLose: 1.6,
  stuckLimit: 0.65,
  reverseFor: 0.85,
  parkingGap: 0.7,
};

const PATROL_PAINT = '#243252';

/** Build the wanted state. `city` supplies station and road grid, `rng` places arrivals. */
export function createPolice(city, rng, options = {}) {
  return {
    city,
    rng,
    level: 0, // whole stars, 0 .. MAX_STARS
    progress: 0, // fraction of the next star already banked
    quiet: HEAT.quietFor, // seconds since the last crime
    cool: 0, // hidden seconds banked toward losing a star
    seen: true, // does the force have eyes on the player right now?
    officers: [],
    cars: [],
    station: stationFor(city),
    spawnTimer: 0,
    time: 0,
    flash: 0, // 0..1 sawtooth driving the light bar and the HUD blink
    arrests: 0,
    onWanted: options.onWanted ?? null,
    onArrest: options.onArrest ?? null,
    onToast: options.onToast ?? null,
    onRam: options.onRam ?? null,
  };
}

// --- Heat -------------------------------------------------------------------------------------

/** Stars on the board right now; zero means a clean player. */
export function getWanted(police) {
  return police.level;
}

/** True while at least one unit has a reason to look for the player. */
export function isWanted(police) {
  return police.level > 0;
}

/**
 * Add heat. One whole star per unit by default; fractional amounts let a run of small offences add
 * up to one. The first offence off a clean slate always costs a full star and banks the remainder.
 */
export function addWanted(police, amount = 1, reason = '') {
  const gain = Number(amount);
  if (!(gain > 0)) return police.level;

  const before = police.level;
  police.quiet = 0;
  police.cool = 0;
  bank(police, gain);

  if (police.level !== before) {
    police.onWanted?.(police.level, reason || 'The police are on you', police.level - before);
  }
  return police.level;
}

/** Pour heat into the meter, whole stars at a time, capped at the top. */
function bank(police, gain) {
  if (police.level === 0) {
    police.level = 1;
    police.progress = clamp(gain - 1, 0, 0.85);
    return;
  }

  police.progress += gain;
  while (police.level < MAX_STARS && police.progress >= 1) {
    police.level += 1;
    police.progress -= 1;
  }
  if (police.level >= MAX_STARS) police.progress = 0;
}

/** Wipe the board: no stars, every unit sent home. `silent` skips the callback. */
export function clearWanted(police, silent = false) {
  const had = police.level > 0;

  police.level = 0;
  police.progress = 0;
  police.cool = 0;
  police.quiet = HEAT.quietFor;
  sendHome(police);

  if (had && !silent) police.onWanted?.(0, 'Case closed', -1);
  return police.level;
}

// --- The step ---------------------------------------------------------------------------------

/** One fixed step: cooling, roll call, the men on foot, the cruisers, their return fire. */
export function updatePolice(police, world, dt) {
  police.time += dt;
  police.flash = (police.flash + dt) % 1;
  police.quiet += dt;

  if (police.level === 0) {
    // A clean player is nobody's business; anything still out there goes home.
    if (police.officers.length || police.cars.length) sendHome(police);
    return;
  }

  police.seen = watched(police, world.player);
  if (bleed(police, dt)) return; // the last star went out on this step

  police.spawnTimer = Math.max(0, police.spawnTimer - dt);
  rollCall(police, world);
  walkTheBeat(police, world, dt);
  runCruisers(police, world, dt);
  returnFire(police, world, dt);
}

/**
 * Shed a star while the player stays out of sight. True when the chase ended on this step, which
 * tells updatePolice to stop before it moves units that no longer exist.
 */
function bleed(police, dt) {
  if (police.seen) {
    // Back in view: the countdown unwinds, but the crime is still recent enough to count.
    police.cool = Math.max(0, police.cool - dt * HEAT.seenRecovery);
    return false;
  }
  if (police.quiet <= HEAT.quietFor) return false;

  police.cool += dt;
  if (police.cool < HEAT.coolFor) return false;

  police.cool = 0;
  police.level -= 1;
  police.progress = 0;

  if (police.level > 0) {
    police.onWanted?.(police.level, 'The trail is going cold', -1);
    return false;
  }

  sendHome(police);
  police.onWanted?.(0, 'You lost the police', -1);
  police.onToast?.('You lost the police.');
  return true;
}

// --- Station and road entries -----------------------------------------------------------------

/** The station is the lot nearest downtown, or the middle block when the seed has no lots. */
function stationFor(city) {
  let spot = null;
  let nearest = Infinity;

  for (const lot of city.lots ?? []) {
    const cx = lot.x + lot.w / 2;
    const cy = lot.y + lot.h / 2;
    const d = distance(cx, cy, city.downtown.x, city.downtown.y);
    if (d < nearest) {
      nearest = d;
      spot = lot;
    }
  }

  if (!spot) {
    const block = city.blocks[Math.floor(city.blocks.length / 2)];
    return {
      x: block.x,
      y: block.y,
      w: block.w,
      h: block.h,
      door: { x: block.x + block.w / 2, y: block.y + 10 },
    };
  }

  return {
    x: spot.x,
    y: spot.y,
    w: spot.w,
    h: spot.h,
    door: { x: spot.x + spot.w / 2, y: spot.y - 8 },
  };
}

/**
 * A point on a street centre line between `minR` and `maxR` of (px, py). Fifty rolls against the
 * grid, then a slide along the nearest avenue so a spawn can never fail outright.
 */
function roadEntry(city, rng, px, py, minR, maxR) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const across = rng.chance(0.5);
    const point = across
      ? { x: rng.range(70, city.width - 70), y: city.hy[rng.int(0, city.rows)] }
      : { x: city.vx[rng.int(0, city.cols)], y: rng.range(70, city.height - 70) };
    const d = distance(point.x, point.y, px, py);
    if (d >= minR && d <= maxR) return point;
  }

  let avenue = city.vx[0];
  for (const x of city.vx) {
    if (Math.abs(x - px) < Math.abs(avenue - px)) avenue = x;
  }
  const drift = (rng.chance(0.5) ? 1 : -1) * maxR;
  return { x: avenue, y: clamp(py + drift, 80, city.height - 80) };
}

// --- Muster -----------------------------------------------------------------------------------

/** A cruiser plus the book-keeping its driver needs: deployment, un-sticking, ram timing. */
function musterCruiser(police, player) {
  const spot = roadEntry(police.city, police.rng, player.x, player.y, 480, 900);
  const car = createCar(
    spot.x,
    spot.y,
    Math.atan2(player.y - spot.y, player.x - spot.x),
    PATROL_PAINT,
    'police',
  );

  car.speed = 0;
  car.cruise = 300;
  car.police = true;

  return {
    car,
    deployed: false,
    stuck: 0,
    reverse: 0,
    ramCooldown: 0,
    phase: police.rng(),
  };
}

/** One officer, sworn in wherever the dispatcher aimed or the cruiser stopped. */
function musterOfficer(police, player, x, y) {
  const rng = police.rng;

  return {
    x,
    y,
    facing: Math.atan2(player.y - y, player.x - x),
    hp: FOOT.hp,
    hurt: 0,
    stagger: 0,
    slideSide: rng.chance(0.5) ? 1 : -1,
    slideDry: 0,
    backTimer: 0,
    walkPhase: rng.range(0, Math.PI * 2),
    speed: FOOT.speed + rng.range(-10, 14),
    scale: rng.range(0.98, 1.06),
    deployFlash: 0,
    fireTimer: rng.range(FOOT.fireGap[0] * 0.6, FOOT.fireGap[1]),
  };
}

/** Everyone home: the street empties and the next chase starts from nothing. */
function sendHome(police) {
  police.officers = [];
  police.cars = [];
  police.spawnTimer = 0;
}

/** Does any unit have the player in view? A cruiser's lights reach further than a man. */
function watched(police, player) {
  for (const officer of police.officers) {
    if (distance(officer.x, officer.y, player.x, player.y) < HEAT.seenRadius) return true;
  }
  for (const unit of police.cars) {
    const reach = HEAT.seenRadius + HEAT.carSightBonus;
    if (distance(unit.car.x, unit.car.y, player.x, player.y) < reach) return true;
  }
  return false;
}

/**
 * How many units the star count is worth. One cruiser per single star, a second at three, a third
 * at five; foot patrols only take the pavement from two stars up.
 */
function rollCall(police, world) {
  const player = world.player;
  cull(police, player);

  if (police.spawnTimer > 0) return;

  const wantCars = Math.min(CRUISER.max, 1 + Math.floor((police.level - 1) / 2));
  const wantFoot = Math.min(FOOT.max, 1 + police.level);

  if (police.cars.length < wantCars) {
    police.cars.push(musterCruiser(police, player));
    police.spawnTimer = CRUISER.gap;
    return;
  }

  if (police.level >= 2 && police.officers.length < wantFoot) {
    const spot = roadEntry(police.city, police.rng, player.x, player.y, 260, 470);
    police.officers.push(musterOfficer(police, player, spot.x, spot.y));
    police.spawnTimer = CRUISER.gap * 1.7;
  }
}

/** Retire the dead, and anything far enough behind to be irrelevant. */
function cull(police, player) {
  police.cars = police.cars.filter(
    (unit) => distance(unit.car.x, unit.car.y, player.x, player.y) < CRUISER.retireBeyond,
  );
  police.officers = police.officers.filter(
    (officer) =>
      officer.hp > 0 && distance(officer.x, officer.y, player.x, player.y) < CRUISER.retireBeyond,
  );
}

// --- Officers on foot -------------------------------------------------------------------------

/** A round collider becomes its bounding box, so one push-out routine serves both shapes. */
function shapeOf(collider) {
  return collider.kind === 'circle'
    ? { x: collider.x - collider.r, y: collider.y - collider.r, w: collider.r * 2, h: collider.r * 2 }
    : collider;
}

/** Walk every officer in, sidestep what they hit, and make the arrest if they get close. */
function walkTheBeat(police, world, dt) {
  const player = world.player;

  for (const officer of police.officers) {
    if (officer.hp <= 0) continue;

    officer.hurt = Math.max(0, officer.hurt - dt);
    officer.stagger = Math.max(0, officer.stagger - dt);
    officer.deployFlash = Math.max(0, officer.deployFlash - dt);

    const dx = player.x - officer.x;
    const dy = player.y - officer.y;
    const gap = Math.hypot(dx, dy) || 1;
    const nx = dx / gap;
    const ny = dy / gap;
    officer.facing = Math.atan2(ny, nx);

    const pace = officer.stagger > 0 ? officer.speed * FOOT.staggerShare : officer.speed;

    // Steering: straight at the player when the pavement is clear, along the obstacle when it is
    // not. The side chosen is held for a beat so a long facade is worked along rather than
    // shuttled against.
    const nav = clearWalk(police.city, officer, nx, ny, pace, dt)
      ? { x: nx, y: ny }
      : slideAround(police.city, officer, nx, ny, pace, dt);

    if (gap > FOOT.arrestReach + 4) {
      officer.x += nav.x * pace * dt;
      officer.y += nav.y * pace * dt;
      officer.walkPhase += pace * dt * 0.2;
      officer.facing = Math.atan2(nav.y, nav.x);
    } else {
      officer.facing = Math.atan2(ny, nx);
    }

    settle(officer, police.city, FOOT.radius);

    // Caught: a man on foot can only ever arrest someone else on foot.
    if (!player.car && gap < FOOT.arrestReach + player.radius) {
      bust(police, world);
      return;
    }
  }
}

/** Would a step of `pace * dt` along (nx, ny) be clear of walls, trunks and water? */
function clearWalk(city, body, nx, ny, pace, dt) {
  const step = Math.max(pace * dt, 2);
  const ahead = { x: body.x + nx * (step + FOOT.radius), y: body.y + ny * (step + FOOT.radius) };

  if (city.isWater(ahead.x, ahead.y)) return false;
  for (const collider of city.collidersNear(ahead.x, ahead.y, FOOT.radius)) {
    if (resolveCircleRect(ahead.x, ahead.y, FOOT.radius, shapeOf(collider))) return false;
  }
  return true;
}

/**
 * A heading that gets an officer around whatever blocks the way.
 *
 * The straight line is preferred while it is clear. Once something is in the way the officer picks
 * an edge and follows it — mostly sideways, with a little inward lean so it keeps closing — and it
 * stays on that edge until the straight line opens again. Committing to one side is the point:
 * re-probing for the smallest clear turn every step makes a body oscillate in front of a wide wall
 * instead of walking along it.
 *
 * A body in a concave pocket can make no progress along either edge at all. That is what the
 * retreat is for, and it is the only case where an officer gives up ground.
 */
function slideAround(city, officer, nx, ny, pace, dt) {
  const along = FOOT.wallFollow;

  // Follow the committed edge: mostly sideways, slightly inward, tracing the obstacle.
  const sideways = { x: nx - ny * officer.slideSide * along, y: ny + nx * officer.slideSide * along };
  const len = Math.hypot(sideways.x, sideways.y) || 1;
  const edge = { x: sideways.x / len, y: sideways.y / len };

  if (clearWalk(city, officer, edge.x, edge.y, pace, dt)) {
    officer.slideDry = 0;
    return edge;
  }

  // That edge is blocked too; try the other one and switch if it opens up. This is how an officer
  // rounds a corner that turns the wrong way for the side it happened to pick.
  const mirrored = {
    x: nx + ny * officer.slideSide * along,
    y: ny - nx * officer.slideSide * along,
  };
  const mLen = Math.hypot(mirrored.x, mirrored.y) || 1;
  const other = { x: mirrored.x / mLen, y: mirrored.y / mLen };

  if (clearWalk(city, officer, other.x, other.y, pace, dt)) {
    officer.slideSide = -officer.slideSide;
    officer.slideDry = 0;
    return other;
  }

  // Both edges blocked: a concave pocket. The only way out is backwards, and the retreat is held
  // for a moment rather than recomputed each step — stepping back just far enough to reopen the
  // edge only walks the officer straight back into the same pocket.
  if (officer.backTimer > 0) {
    officer.backTimer = Math.max(0, officer.backTimer - dt);
    const back = { x: -nx, y: -ny };
    if (clearWalk(city, officer, back.x, back.y, pace, dt)) return back;
    officer.backTimer = 0;
  }

  officer.slideDry += dt;
  if (officer.slideDry > FOOT.slidePatience) {
    officer.slideDry = 0;
    officer.backTimer = FOOT.backOut;
    officer.slideSide = -officer.slideSide; // come at the pocket from the other flank next time
  }

  // Between retreats: hold, and let the next step try again with fresh geometry.
  return { x: 0, y: 0 };
}

/** Push a walking body clear of walls and trunks. True when it had to be moved. */
function settle(body, city, radius) {
  let moved = false;

  for (let pass = 0; pass < 2; pass += 1) {
    for (const collider of city.collidersNear(body.x, body.y, radius)) {
      const hit = resolveCircleRect(body.x, body.y, radius, shapeOf(collider));
      if (!hit) continue;
      body.x = hit.x;
      body.y = hit.y;
      moved = true;
    }
  }

  if (city.isWater(body.x, body.y)) {
    body.x = Math.min(body.x, city.shoreline - radius);
    moved = true;
  }
  body.x = clamp(body.x, 12, city.water.x + city.water.w - 12);
  body.y = clamp(body.y, 12, city.height - 12);
  return moved;
}

/** Hands on the player: the heat is wiped and main.js turns the arrest into a screen. */
function bust(police, world) {
  police.arrests += 1;
  police.level = 0;
  police.progress = 0;
  police.cool = 0;
  police.quiet = HEAT.quietFor;
  sendHome(police);

  police.onArrest?.({
    station: { ...police.station.door },
    level: police.arrests,
  });
  police.onWanted?.(0, 'Busted', -1);
}

// --- Cruisers ---------------------------------------------------------------------------------

/** Drive the cruisers at the player, then keep them from parking inside one another. */
function runCruisers(police, world, dt) {
  for (const unit of police.cars) {
    hunt(police, unit, world.player, dt);
  }
  spread(police.cars);
}

/** One cruiser: close in, drop a man beside a walking player, shunt a driving one. */
function hunt(police, unit, player, dt) {
  const car = unit.car;
  const dx = player.x - car.x;
  const dy = player.y - car.y;
  const gap = Math.hypot(dx, dy) || 1;
  unit.ramCooldown = Math.max(0, unit.ramCooldown - dt);

  // Pull alongside a player on foot and put an officer out to cover the pavement.
  if (!unit.deployed && !player.car && gap < CRUISER.deployWithin) {
    unit.deployed = true;
    const flank = Math.atan2(dy, dx) + Math.PI / 2;
    police.officers.push(
      musterOfficer(police, player, car.x + Math.cos(flank) * 22, car.y + Math.sin(flank) * 22),
    );
    police.onToast?.('An officer is out of the car!');
  }

  if (unit.reverse > 0) {
    unit.reverse -= dt;
    driveCar(car, -1, 0, false, dt);
  } else {
    const heading = Math.atan2(dy, dx);
    const steer = clamp(angleDelta(car.angle, heading) * 1.9, -1, 1);
    const stopAt = player.car ? CRUISER.stopCar : CRUISER.stopFoot;
    const throttle = gap > stopAt + 30 ? 1 : 0;

    driveCar(car, gap < stopAt ? -1 : throttle, steer, false, dt);
    if (gap < CRUISER.slowWithin) car.speed = Math.min(car.speed, CRUISER.slowTo);
  }

  const impact = moveCar(car, police.city, dt);
  if (impact > 0.2) unit.stuck += dt * CRUISER.stuckGain;
  else unit.stuck = Math.max(0, unit.stuck - dt * CRUISER.stuckLose);

  if (unit.stuck > CRUISER.stuckLimit) {
    unit.reverse = CRUISER.reverseFor;
    unit.stuck = 0;
  }

  // Ramming: the player's car keeps a share of its speed and the body is shoved with it.
  if (player.car && carsTouching(player.car, car) && unit.ramCooldown <= 0) {
    unit.ramCooldown = CRUISER.ramCooldown;
    const speed = Math.abs(player.car.speed);

    player.car.speed *= CRUISER.ramKeep;
    player.car.x += (dx / gap) * CRUISER.ramPush;
    player.car.y += (dy / gap) * CRUISER.ramPush;
    player.x = player.car.x;
    player.y = player.car.y;

    police.onRam?.(speed);
  }
}

/** Keep a body's width between cruisers, so a pile-up can never box the player in. */
function spread(units) {
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i].car;
      const b = units[j].car;
      if (!carsTouching(a, b)) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const half = CRUISER.parkingGap;

      a.x -= (dx / d) * half;
      a.y -= (dy / d) * half;
      b.x += (dx / d) * half;
      b.y += (dy / d) * half;
      a.speed *= 0.92;
      b.speed *= 0.92;
    }
  }
}

// --- Return fire ------------------------------------------------------------------------------

/**
 * From four stars up, an officer on foot draws on a player who is also on foot. The round, its hit
 * chance and its damage all belong to combat.js; this only decides when one is worth sending and
 * how long the officer waits before the next.
 */
function returnFire(police, world, dt) {
  const combat = world.combat;
  if (!combat || police.level < FOOT.fireFrom) return;

  const player = world.player;
  if (player.car) return;

  for (const officer of police.officers) {
    if (officer.hp <= 0) continue;

    officer.fireTimer -= dt;
    if (officer.fireTimer > 0) continue;

    if (distance(officer.x, officer.y, player.x, player.y) > FOOT.fireRange) {
      officer.fireTimer = 0.4;
      continue;
    }

    const fired = policeFire(combat, world, officer);
    officer.fireTimer = fired
      ? FOOT.fireGap[0] + police.rng() * (FOOT.fireGap[1] - FOOT.fireGap[0])
      : 0.4;
  }
}
