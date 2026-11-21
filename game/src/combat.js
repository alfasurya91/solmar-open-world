// The player's two ways of hurting: bare fist, and a pistol found in the park.
// Exports: createCombat, placePistol, givePistol, canAttack, updateCombat, punch, shoot, policeFire, resetCombat

import { COLORS } from './config.js';
import { clamp, distance } from './utils.js';
import { carCircles } from './vehicles.js';

/** Fist: short reach, wide arc, slow enough that mashing isn't a strategy. */
const KNUCKLE = {
  cooldown: 0.34,
  swing: 0.18,
  range: 34,
  arc: Math.PI * 0.8,
  damage: 22,
  push: 9,
  stagger: 0.42,
  maxTargets: 2,
};

/** Pistol: flat, fast, auto-reloads when magazine empties. */
const SIDEARM = {
  cooldown: 0.2,
  flash: 0.075,
  muzzleDistance: 17,
  spread: 0.055,
  bulletSpeed: 1080,
  bulletLife: 0.45,
  bulletRadius: 3,
  damage: 34,
  push: 3,
  stagger: 0.22,
  magazine: 12,
  reload: 1.15,
  maxBullets: 40,
};

/** Effect caps — never unbounded growth. */
const EFFECTS = {
  maxParticles: 180,
  maxSparks: 60,
  sparkLife: 0.5,
};

/** Pickup reach for the pistol on the ground. */
const PICKUP_REACH = 26;

/** Officer's return fire: ranged, less accurate at distance, never one-shot. */
const SERVICE_FIRE = {
  reach: 420,
  speedShare: 0.7,
  spread: 0.16,
  accuracyBase: 0.62,
  accuracyFalloff: 900,
  minChance: 0.18,
  damageMin: 7,
  damageSpread: 6,
};

/** Build the combat state. `city` for collision, `rng` for deterministic spread/sparks. */
export function createCombat(city, rng, options = {}) {
  return {
    city,
    rng,

    // Fist state
    fists: false,
    fistTimer: 0,
    fistCooldown: 0,

    // Pistol state
    gunCooldown: 0,
    muzzle: 0,
    hasGun: false,
    ammo: 0,
    reload: 0,
    reloading: false,

    // Projectiles & effects
    bullets: [],
    particles: [],
    sparks: [],   // {x, y, life, max, kind}
    hits: 0,
    shots: 0,
    pickups: [],

    // Callbacks filled by main.js
    onAttack: options.onAttack ?? null, // (kind) => void
    onHit: options.onHit ?? null,       // (target, amount, kind) => void
    playerHurt: options.playerHurt ?? null, // (amount) => void
  };
}

/** Drop the pistol in the first park, south of center. */
export function placePistol(combat, city, rng) {
  const park = city.parks[0] ?? null;
  const spot = park
    ? { x: park.x + park.w * 0.5 + rng.range(-24, 24), y: park.y + park.h * 0.5 + 26 }
    : { x: city.spawn.x + 90, y: city.spawn.y + 40 };

  const drop = {
    kind: 'pistol',
    x: clamp(spot.x, 40, city.shoreline - 40),
    y: clamp(spot.y, 40, city.height - 40),
    bob: rng.range(0, Math.PI * 2),
    taken: false,
  };

  // One pistol, one spot: replace any existing pistol drop.
  combat.pickups = combat.pickups.filter((item) => item.kind !== 'pistol');
  combat.pickups.push(drop);
  return drop;
}

/** Hand over the pistol with a full magazine. */
export function givePistol(combat) {
  combat.hasGun = true;
  combat.ammo = SIDEARM.magazine;
  combat.reload = 0;
  combat.reloading = false;
}

/** Player may attack only when on foot. */
export function canAttack(combat, world) {
  return !world.player.car;
}

/** Advance weapons: timers, magazine, bullets in flight, ground pickup. */
export function updateCombat(combat, world, dt) {
  tick(combat, dt);
  stepOnPickup(combat, world);
  flyBullets(combat, world, dt);
  fade(combat, dt);
}

function tick(combat, dt) {
  combat.fistTimer = Math.max(0, combat.fistTimer - dt);
  combat.fistCooldown = Math.max(0, combat.fistCooldown - dt);
  combat.gunCooldown = Math.max(0, combat.gunCooldown - dt);
  combat.muzzle = Math.max(0, combat.muzzle - dt);
  combat.fists = combat.fistTimer > 0;

  if (!combat.reloading) return;

  combat.reload = Math.max(0, combat.reload - dt);
  if (combat.reload > 0) return;

  // Reload complete: magazine seated, pistol live again.
  combat.reloading = false;
  combat.ammo = SIDEARM.magazine;
}

/** Walk over the dropped pistol to pick it up. */
function stepOnPickup(combat, world) {
  if (combat.hasGun) return;

  for (const item of combat.pickups) {
    if (item.taken) continue;
    if (distance(item.x, item.y, world.player.x, world.player.y) >= PICKUP_REACH) continue;

    item.taken = true;
    givePistol(combat);
    world.onPickup?.(item.kind);
    return;
  }
}

/** Throw a punch. Returns true if swing happened (cooldown paid even on whiff). */
export function punch(combat, world) {
  const player = world.player;
  if (player.car) return false;
  if (combat.fistCooldown > 0) return false;

  combat.fistCooldown = KNUCKLE.cooldown;
  combat.fistTimer = KNUCKLE.swing;
  combat.fists = true;
  combat.onAttack?.('fist');

  let landed = 0;

  for (const target of inReach(world)) {
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const d = Math.hypot(dx, dy);
    if (d > KNUCKLE.range + 10 || d < 0.001) continue;

    const bearing = Math.atan2(dy, dx);
    if (Math.abs(shortestTurn(bearing - player.facing)) > KNUCKLE.arc / 2) continue;

    strike(combat, world, target, KNUCKLE.damage, 'fist', dx / d, dy / d);
    landed += 1;
    if (landed >= KNUCKLE.maxTargets) break;
  }

  // Whiff still rings parked cars.
  if (landed === 0) rapOnCar(combat, world, player);
  return true;
}

function rapOnCar(combat, world, player) {
  for (const car of world.parked.concat(world.traffic.list)) {
    if (distance(car.x, car.y, player.x, player.y) < 40) {
      spark(combat, car.x, car.y, 'thud');
      return;
    }
  }
}

/** Fire the pistol along player's facing. True if round left barrel. */
export function shoot(combat, world) {
  const player = world.player;
  if (player.car) return false;
  if (!combat.hasGun) return false;
  if (combat.reloading) return false;

  // Empty magazine starts reload on this pull, not next.
  if (combat.ammo <= 0) {
    beginReload(combat);
    return false;
  }
  if (combat.gunCooldown > 0) return false;

  combat.gunCooldown = SIDEARM.cooldown;
  combat.muzzle = SIDEARM.flash;
  combat.shots += 1;
  combat.ammo -= 1;
  combat.onAttack?.('gun');

  const angle = player.facing + (combat.rng() - 0.5) * SIDEARM.spread;
  const muzzleX = player.x + Math.cos(angle) * SIDEARM.muzzleDistance;
  const muzzleY = player.y + Math.sin(angle) * SIDEARM.muzzleDistance;

  launch(combat, muzzleX, muzzleY, angle, 1, false);
  smoke(combat, muzzleX, muzzleY, angle);
  return true;
}

function beginReload(combat) {
  combat.reloading = true;
  combat.reload = SIDEARM.reload;
  combat.ammo = 0;
}

/** Officer fires back at player on foot. Hit rolled here; damage via playerHurt. */
export function policeFire(combat, world, officer) {
  const player = world.player;
  if (player.car) return false;

  const gap = distance(officer.x, officer.y, player.x, player.y);
  if (gap > SERVICE_FIRE.reach) return false;

  combat.shots += 1;

  const angle = Math.atan2(player.y - officer.y, player.x - officer.x)
    + (combat.rng() - 0.5) * SERVICE_FIRE.spread;
  const fromX = officer.x + Math.cos(angle) * 12;
  const fromY = officer.y + Math.sin(angle) * 12;

  launch(combat, fromX, fromY, angle, SERVICE_FIRE.speedShare, true);
  smoke(combat, fromX, fromY, angle);

  // Close and steady hurts most; distant officers are a nuisance, not snipers.
  const chance = clamp(
    SERVICE_FIRE.accuracyBase - gap / SERVICE_FIRE.accuracyFalloff,
    SERVICE_FIRE.minChance,
    SERVICE_FIRE.accuracyBase,
  );

  if (combat.rng() < chance) {
    const amount = SERVICE_FIRE.damageMin + Math.round(combat.rng() * SERVICE_FIRE.damageSpread);
    combat.playerHurt?.(amount);
    spark(combat, player.x, player.y, 'gun');
  }
  return true;
}

/** Put one round into the air. `slow` scales speed for officer load. */
function launch(combat, x, y, angle, slow, hostile) {
  const speed = SIDEARM.bulletSpeed * slow;

  combat.bullets.push({
    x,
    y,
    px: x,
    py: y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: SIDEARM.bulletLife * slow,
    ...(hostile ? { hostile: true } : {}),
  });
  if (combat.bullets.length > SIDEARM.maxBullets) combat.bullets.shift();
}

/** Step all bullets: swept segment collision vs people, cars, scenery. */
function flyBullets(combat, world, dt) {
  const alive = [];
  const people = inReach(world);

  for (const bullet of combat.bullets) {
    bullet.px = bullet.x;
    bullet.py = bullet.y;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;

    if (bullet.life <= 0) continue;

    // Scenery stops rounds.
    if (meetsScenery(combat, bullet)) continue;

    // Friendly bullets hit people; hostile bullets were already rolled in policeFire.
    if (!bullet.hostile && meetsPerson(combat, world, bullet, people)) continue;

    // Cars stop bullets.
    if (meetsCar(combat, world, bullet)) continue;

    // World edge.
    if (bullet.x < 4 || bullet.y < 4 || bullet.y > combat.city.height - 4) {
      spark(combat, bullet.x, bullet.y, 'wall');
      continue;
    }

    alive.push(bullet);
  }

  combat.bullets = alive;
}

function meetsScenery(combat, bullet) {
  for (const collider of combat.city.collidersNear(bullet.x, bullet.y, SIDEARM.bulletRadius + 6)) {
    if (overlaps(bullet.x, bullet.y, SIDEARM.bulletRadius, collider)) {
      spark(combat, bullet.x, bullet.y, 'wall');
      return true;
    }
  }
  return false;
}

function meetsPerson(combat, world, bullet, people) {
  for (const target of people) {
    if (target.hp <= 0 || target.down === true) continue;

    const reach = (target.radius ?? 11) + SIDEARM.bulletRadius;
    if (!segmentHits(bullet.px, bullet.py, bullet.x, bullet.y, target.x, target.y, reach)) continue;

    const dx = bullet.x - bullet.px;
    const dy = bullet.y - bullet.py;
    const d = Math.hypot(dx, dy) || 1;

    strike(combat, world, target, SIDEARM.damage, 'gun', dx / d, dy / d);
    return true;
  }
  return false;
}

function meetsCar(combat, world, bullet) {
  const cars = world.traffic.list.concat(world.parked);
  if (world.player.car) cars.push(world.player.car);

  for (const car of cars) {
    for (const circle of carCircles(car)) {
      if (!segmentHits(bullet.px, bullet.py, bullet.x, bullet.y, circle.x, circle.y, circle.r)) {
        continue;
      }
      spark(combat, bullet.x, bullet.y, 'car');
      return true;
    }
  }
  return false;
}

/** All living targets a fist or bullet can reach. */
function inReach(world) {
  const list = [];

  for (const officer of world.police?.officers ?? []) {
    if (officer.hp > 0) list.push(officer);
  }
  for (const ped of world.pedestrians.list) {
    if (ped.hp > 0 && ped.down !== true) list.push(ped);
  }
  return list;
}

/** Land a blow: hurt, shove, mark, report. Dead bodies go down for good. */
function strike(combat, world, target, amount, kind, nx, ny) {
  combat.hits += 1;

  const gun = kind === 'gun';

  target.hp = (target.hp ?? 100) - amount;
  target.hurt = 0.26;
  target.stagger = gun ? SIDEARM.stagger : KNUCKLE.stagger;

  const push = gun ? SIDEARM.push : KNUCKLE.push;
  target.x += nx * push;
  target.y += ny * push;

  spark(combat, target.x, target.y, kind);
  burst(combat, target.x, target.y, gun ? COLORS.red : '#f7e2b4', gun ? 7 : 4);

  combat.onHit?.(target, amount, kind);

  if (target.hp <= 0) {
    target.hp = 0;
    target.down = true;
    burst(combat, target.x, target.y, '#d8cbb0', 10);
  }
}

/** Segment vs circle: swept path so fast bullets can't slip between frames. */
function segmentHits(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const along = lengthSq > 0 ? clamp(((cx - x1) * dx + (cy - y1) * dy) / lengthSq, 0, 1) : 0;

  return distance(x1 + dx * along, y1 + dy * along, cx, cy) <= radius;
}

/** Bullet vs city collider (rect or circle trunk as bbox). */
function overlaps(x, y, radius, collider) {
  const box = collider.kind === 'circle'
    ? { x: collider.x - collider.r, y: collider.y - collider.r, w: collider.r * 2, h: collider.r * 2 }
    : collider;

  const nearestX = clamp(x, box.x, box.x + box.w);
  const nearestY = clamp(y, box.y, box.y + box.h);
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

/** Shortest signed turn — arc test doesn't trip over PI seam. */
function shortestTurn(angle) {
  let d = angle % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Effects. */
function spark(combat, x, y, kind) {
  combat.sparks.push({ x, y, life: EFFECTS.sparkLife, max: EFFECTS.sparkLife, kind });
  if (combat.sparks.length > EFFECTS.maxSparks) combat.sparks.shift();
}

function smoke(combat, x, y, angle) {
  for (let i = 0; i < 3; i += 1) {
    const drift = (combat.rng() - 0.5) * 30;
    combat.particles.push({
      x,
      y,
      vx: Math.cos(angle) * 40 + drift,
      vy: Math.sin(angle) * 40 + drift,
      life: 0.22 + combat.rng() * 0.14,
      max: 0.36,
      r: 1.6 + combat.rng() * 1.6,
      colour: '#f6e2ae',
      drag: 4,
    });
  }
}

function burst(combat, x, y, colour, count) {
  for (let i = 0; i < count; i += 1) {
    const heading = combat.rng() * Math.PI * 2;
    const speed = 40 + combat.rng() * 110;
    combat.particles.push({
      x,
      y,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      life: 0.24 + combat.rng() * 0.3,
      max: 0.54,
      r: 1.2 + combat.rng() * 2.1,
      colour,
      drag: 3.4,
    });
  }
  trim(combat);
}

function trim(combat) {
  const excess = combat.particles.length - EFFECTS.maxParticles;
  if (excess > 0) combat.particles.splice(0, excess);
}

function fade(combat, dt) {
  for (let i = combat.particles.length - 1; i >= 0; i -= 1) {
    const p = combat.particles[i];
    p.life -= dt;

    if (p.life <= 0) {
      combat.particles.splice(i, 1);
      continue;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const keep = Math.max(0, 1 - p.drag * dt);
    p.vx *= keep;
    p.vy *= keep;
  }
  trim(combat);

  for (let i = combat.sparks.length - 1; i >= 0; i -= 1) {
    combat.sparks[i].life -= dt;
    if (combat.sparks[i].life <= 0) combat.sparks.splice(i, 1);
  }
}

/** Clear gunfire trace for a new run. Pistol, magazine, and park drop persist. */
export function resetCombat(combat) {
  combat.bullets = [];
  combat.particles = [];
  combat.sparks = [];
  combat.fists = false;
  combat.fistTimer = 0;
  combat.fistCooldown = 0;
  combat.gunCooldown = 0;
  combat.muzzle = 0;
  combat.reload = 0;
  combat.reloading = false;
}