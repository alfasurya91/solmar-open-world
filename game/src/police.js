// The law in Solmar — wanted stars, patrol units, pursuit, arrest, and cooldown.
// Exports: MAX_STARS, createPolice, getWanted, isWanted, addWanted, clearWanted, updatePolice

import { angleDelta, clamp, distance, resolveCircleRect } from './utils.js';
import { carsTouching, createCar, driveCar, moveCar } from './vehicles.js';
import { policeFire } from './combat.js';

/** Five stars is the whole scale. */
export const MAX_STARS = 5;

/** Heat tuning. */
const HEAT = {
  quietFor: 5,       // grace seconds after a crime before cooldown starts
  coolFor: 9,        // hidden seconds to shed one star while unseen
  seenRadius: 430,   // max distance a unit can see the player
  carSightBonus: 90, // extra sight from cruiser lights
  seenRecovery: 0.8, // cooldown unwinds this fast while seen
};

/** Foot patrol constants. */
const FOOT = {
  speed: 188,
  radius: 9,
  hp: 58,
  arrestReach: 17,
  max: 7,
  wallFollow: 2.2,
  slidePatience: 0.35,
  backOut: 0.6,
  staggerShare: 0.25,
  fireFrom: 4,        // star level when officers shoot
  fireRange: 340,
  fireGap: [1.7, 2.6], // random fire interval
};

/** Cruiser constants. */
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

/** Build the wanted state. `city` supplies station/road grid, `rng` places arrivals. */
export function createPolice(city, rng, options = {}) {
  return {
    city,
    rng,
    level: 0,           // whole stars 0..MAX_STARS
    progress: 0,        // fraction toward next star
    quiet: HEAT.quietFor,
    cool: 0,
    seen: true,
    officers: [],
    cars: [],
    station: stationFor(city),
    spawnTimer: 0,
    time: 0,
    flash: 0,           // 0..1 sawtooth for light bar / HUD blink
    arrests: 0,
    onWanted: options.onWanted ?? null,
    onArrest: options.onArrest ?? null,
    onToast: options.onToast ?? null,
    onRam: options.onRam ?? null,
  };
}

/** Stars on the board right now; zero means clean. */
export function getWanted(police) {
  return police.level;
}

/** True while at least one star is active. */
export function isWanted(police) {
  return police.level > 0;
}

/** Add heat. One whole star per unit by default; fractions bank toward the next. */
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

/** Pour heat into the meter, whole stars at a time, capped at top. */
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

/** Wipe the board: no stars, every unit sent home. `silent` skips callback. */
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

/** One fixed step: cooling, roll call, foot officers, cruisers, return fire. */
export function updatePolice(police, world, dt) {
  police.time += dt;
  police.flash = (police.flash + dt) % 1;
  police.quiet += dt;

  if (police.level === 0) {
    if (police.officers.length || police.cars.length) sendHome(police);
    return;
  }

  police.seen = watched(police, world.player);
  if (bleed(police, dt)) return; // chase ended this step

  police.spawnTimer = Math.max(0, police.spawnTimer - dt);
  rollCall(police, world);
  walkTheBeat(police, world, dt);
  runCruisers(police, world, dt);
  returnFire(police, world, dt);
}

/** Shed a star while player stays out of sight. True when chase ended this step. */
function bleed(police, dt) {
  if (police.seen) {
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

/** Station is the lot nearest downtown, or middle block if no lots. */
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

/** Road entry point between minR and maxR of (px, py). */
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

/** Build a cruiser unit with book-keeping. */
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

/** Build a foot officer at given position. */
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

/** Everyone home: street empties. */
function sendHome(police) {
  police.officers = [];
  police.cars = [];
  police.spawnTimer = 0;
}

/** Does any unit have player in view? Cruiser lights reach further. */
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

/** How many units the star count warrants. */
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

/** Retire dead and distant units. */
function cull(police, player) {
  police.cars = police.cars.filter(
    (unit) => distance(unit.car.x, unit.car.y, player.x, player.y) < CRUISER.retireBeyond,
  );
  police.officers = police.officers.filter(
    (officer) =>
      officer.hp > 0 && distance(officer.x, officer.y, player.x, player.y) < CRUISER.retireBeyond,
  );
}

/** Round collider -> bounding box. */
function shapeOf(collider) {
  return collider.kind === 'circle'
    ? { x: collider.x - collider.r, y: collider.y - collider.r, w: collider.r * 2, h: collider.r * 2 }
    : collider;
}

/** Walk officers in, sidestep obstacles, arrest if close. */
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

    // Arrest: only on foot vs on foot.
    if (!player.car && gap < FOOT.arrestReach + player.radius) {
      bust(police, world);
      return;
    }
  }
}

/** Test if a step ahead is clear of walls, trunks, water. */
function clearWalk(city, body, nx, ny, pace, dt) {
  const step = Math.max(pace * dt, 2);
  const ahead = { x: body.x + nx * (step + FOOT.radius), y: body.y + ny * (step + FOOT.radius) };

  if (city.isWater(ahead.x, ahead.y)) return false;
  for (const collider of city.collidersNear(ahead.x, ahead.y, FOOT.radius)) {
    if (resolveCircleRect(ahead.x, ahead.y, FOOT.radius, shapeOf(collider))) return false;
  }
  return true;
}

/** Slide around obstacles: follow committed edge, switch if other opens, retreat if pocketed. */
function slideAround(city, officer, nx, ny, pace, dt) {
  const along = FOOT.wallFollow;

  const sideways = { x: nx - ny * officer.slideSide * along, y: ny + nx * officer.slideSide * along };
  const len = Math.hypot(sideways.x, sideways.y) || 1;
  const edge = { x: sideways.x / len, y: sideways.y / len };

  if (clearWalk(city, officer, edge.x, edge.y, pace, dt)) {
    officer.slideDry = 0;
    return edge;
  }

  const mirrored = { x: nx + ny * officer.slideSide * along, y: ny - nx * officer.slideSide * along };
  const mLen = Math.hypot(mirrored.x, mirrored.y) || 1;
  const other = { x: mirrored.x / mLen, y: mirrored.y / mLen };

  if (clearWalk(city, officer, other.x, other.y, pace, dt)) {
    officer.slideSide = -officer.slideSide;
    officer.slideDry = 0;
    return other;
  }

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
    officer.slideSide = -officer.slideSide;
  }

  return { x: 0, y: 0 };
}

/** Push walking body clear of walls/trunks/water. */
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

/** Arrest: wipe heat, send units home, callback. */
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

/** Drive cruisers at player, keep them separated. */
function runCruisers(police, world, dt) {
  for (const unit of police.cars) {
    hunt(police, unit, world.player, dt);
  }
  spread(police.cars);
}

/** One cruiser: close in, deploy officer near walking player, ram driving player. */
function hunt(police, unit, player, dt) {
  const car = unit.car;
  const dx = player.x - car.x;
  const dy = player.y - car.y;
  const gap = Math.hypot(dx, dy) || 1;
  unit.ramCooldown = Math.max(0, unit.ramCooldown - dt);

  // Deploy officer alongside player on foot.
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

  // Ram player's car.
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

/** Keep cruisers separated so they don't pile up. */
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

/** Return fire: officers shoot at player on foot from 4 stars up. */
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