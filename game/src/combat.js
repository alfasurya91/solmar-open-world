/*
 * combat.js — fists and the sidearm.
 *
 * Layout of this file:
 *   1. tuning and tuning resolution
 *   2. geometry helpers (segments against circles and rects)
 *   3. createCombat — the state bag plus its bound methods
 *   4. per-frame update — bullets, punch contacts, particles, pickups
 *   5. melee — punch(), contact resolution, hitStagger(), knockback
 *   5b. kick — the shove that puts a body on the pavement
 *   5c. blunt weapons — street pipes and bats, durability and swings
 *   6. firearm — shootPistol(), reload(), givePistol(), hostile fire
 *   6b. ammunition — chamber rounds, staged reloads, reserve caps
 *   7. damage plumbing shared by both
 *   8. officer assaults — baton, tackle, warning shot, volley
 *
 * The rest of the game already knows this shape:
 *   - render.js reads combat.bullets / particles / sparks / pickups /
 *     muzzle / fists and nothing else;
 *   - hud.js reads player.weapon and player.ammo;
 *   - police.js calls world.hurtPlayer(player, damage), so the same
 *     hurtPlayer this module re-exports from player.js is what a world
 *     object should be given.
 *
 * Everything is world units and seconds, matching config.js's COMBAT
 * block; every constant there is overridable through options.combat.
 */

import { COMBAT } from './config.js';
import { angleDelta, clamp, TAU } from './utils.js';
import { startPunch, hurtPlayer } from './player.js';

/*
 * player.js owns the swing animation and the body's damage bookkeeping.
 * Re-exporting both keeps a single import site for whoever wires the world
 * (police.js's `w.hurtPlayer` included) while leaving player.js untouched.
 */
export { startPunch, hurtPlayer };

/* ------------------------------------------------------------------ */
/* 1. tuning                                                           */
/* ------------------------------------------------------------------ */

/* Frame at which a started swing actually connects. player.js holds the arm
 * out for 0.28 s; contact lands early in that window. */
const PUNCH_CONTACT = 0.11;
const PUNCH_ARC = 1.05;        // half-angle of the cone a punch covers
const PUNCH_REACH_PAD = 6;     // slack past punchRange so edges connect
const MIN_STAMINA = 2;         // below this a body is too gassed to swing

/* A kick lands earlier than a punch: the leg is already up. A blunt weapon
 * lands late, because the whole arc of the pipe has to come round. */
const KICK_CONTACT = 0.09;
const BLUNT_CONTACT = 0.15;

/* Street weapons the player can pick up and wear out. `hits` is the life of
 * one weapon in landed connections; `damageMul` scales COMBAT.bluntDamage. */
const BLUNT_KINDS = Object.freeze({
  pipe: { key: 'pipe', label: 'Steel pipe', damageMul: 0.9, hits: 9, reach: 0 },
  bat: { key: 'bat', label: 'Ball bat', damageMul: 1.35, hits: 6, reach: 4 },
});

const PISTOL_SPEED = 2600;     // world units per second
const BULLET_STEP = 9;         // collision sub-step, stops tunnelling
const BULLET_RADIUS = 2;
const PLAYER_PAD = 3;          // extra hit radius on a body
const OFFICER_RADIUS = 11;
const PED_RADIUS = 9;

const MUZZLE_OFFSET = 18;      // barrel tip ahead of the body centre
const MUZZLE_KICK = 26;        // rearward velocity nudge on the shooter
const PICKUP_RADIUS = 22;
const PICKUP_BOB_RATE = 1.6;
const CORPSE_LIMIT = 12;

const MAX_BULLETS = 48;
const MAX_PARTICLES = 160;
const MAX_SPARKS = 64;

const DEFAULT_TUNING = Object.freeze({
  punchDamage: 12,
  punchRange: 34,
  punchCooldown: 0.42,
  punchKnockback: 120,
  punchStamina: 6,
  pistolDamage: 34,
  pistolRange: 520,
  pistolFalloff: 0.55,
  pistolCooldown: 0.55,
  pistolSpread: 0.035,
  pistolAmmo: 12,
  pistolReserve: 96,
  pistolReload: 1.6,
  meleeArmorPierce: 0.25,
  bulletPenetration: 1,
  muzzleFlashLife: 0.07,
  muzzleFlashLength: 18,
  hitFlashLife: 0.12,
  hitStagger: 0.22,
  deathFade: 2.4,

  /* --- kick: shorter reach, wider arc, drops whoever it connects with --- */
  kickDamage: 7,
  kickRange: 30,
  kickCooldown: 0.7,
  kickKnockback: 235,
  kickStamina: 13,
  kickDownTime: 2.6,          // seconds a kicked pedestrian stays on the deck

  /* --- blunt weapons: heavier, slower, deadlier than a fist --- */
  bluntDamage: 19,
  bluntRange: 42,
  bluntCooldown: 0.78,
  bluntKnockback: 190,
  bluntStamina: 9,
  bluntStagger: 0.55,

  /* --- ammunition depth --- */
  pistolReserveMax: 144,      // ceiling on the reserve a pickup can top up
  pistolEmptyReloadMul: 1.35, // slide-lock reload is slower than a speed reload
  pistolChamber: true,        // a tactical reload keeps one up the spout

  /* --- officer assaults --- */
  officerBatonDamage: 9,
  officerBatonRange: 30,
  officerTackleDamage: 6,
  officerTackleRange: 42,
  officerAssaultCooldown: 1.9,
  officerAssaultStamina: 0,   // damage the player takes is health, not fuel
});

/*
 * Merge config.js's COMBAT under whatever a caller passes. A missing or
 * partially written config entry never leaves a NaN in the maths.
 */
function resolveTuning(overrides) {
  const out = {};
  for (const key of Object.keys(DEFAULT_TUNING)) {
    const raw = overrides?.[key] ?? COMBAT?.[key];
    out[key] = Number.isFinite(raw) ? raw : DEFAULT_TUNING[key];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. geometry helpers                                                 */
/* ------------------------------------------------------------------ */

/* Distance from a point to a segment, squared — used for bullet paths. */
function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;

  let t = 0;
  if (len2 > 1e-9) t = clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1);

  const nx = x1 + dx * t;
  const ny = y1 + dy * t;
  const ex = cx - nx;
  const ey = cy - ny;
  return ex * ex + ey * ey <= r * r;
}

/* Liang-Barsky clip of a segment against an axis-aligned rect. */
function segmentHitsRect(x1, y1, x2, y2, rect) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - rect.x, rect.x + rect.w - x1, y1 - rect.y, rect.y + rect.h - y1];

  let t0 = 0;
  let t1 = 1;

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

/*
 * Does the segment cross any world collider? Returns the collider that
 * stopped it, or null, so a caller can spark at the impact point.
 */
function blocker(combat, x1, y1, x2, y2) {
  const city = combat.city;
  if (!city || typeof city.collidersNear !== 'function') return null;

  const mx = (x1 + x2) * 0.5;
  const my = (y1 + y2) * 0.5;
  const reach = Math.hypot(x2 - x1, y2 - y1) * 0.5 + 4;

  for (const c of city.collidersNear(mx, my, reach)) {
    if (c.kind === 'circle') {
      if (segmentHitsCircle(x1, y1, x2, y2, c.x, c.y, c.r)) return c;
    } else if (segmentHitsRect(x1, y1, x2, y2, c)) {
      return c;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 3. construction                                                     */
/* ------------------------------------------------------------------ */

/*
 * createCombat(city, world, options)
 *
 *   options.combat  overrides on config.js's COMBAT
 *   options.rng     () => 0..1; spread and particle jitter draw from it
 *   options.pickups  false skips seeding a pistol pickup at spawn
 *
 * The returned object is both state and controller. `world.combat` is
 * pointed at it and `world.hurtPlayer` is filled in when nothing else has
 * claimed the name, so police.js's return fire and player.js's damage path
 * agree out of the box.
 */
export function createCombat(city, world = {}, options = {}) {
  /* Tolerate (world, city) argument order, like createPolice does. */
  if (city && world && city.player !== undefined && world.player === undefined) {
    const swap = city;
    city = world;
    world = swap;
  }

  const T = resolveTuning(options.combat ?? {});

  const combat = {
    /* presentation pools read by render.js */
    bullets: [],
    particles: [],
    sparks: [],
    pickups: [],
    corpses: [],

    /* timers and flags */
    muzzle: 0,
    fists: true,
    pistolT: 0,
    reloadT: 0,

    /* melee variety: a kick has its own cooldown, a swing its own slot */
    kickT: 0,
    bluntT: 0,
    lastMelee: null,       // 'punch' | 'kick' | 'blunt' — what landed last

    /* bookkeeping */
    strikes: [],          // punches still travelling to their contact frame
    reloader: null,       // body whose magazine is being swapped
    reloadStage: null,    // 'tactical' | 'empty' | 'staged' while a swap runs
    city: city ?? null,
    world: world ?? null,
    player: world?.player ?? null,
    tuning: T,
  };

  combat.rand = typeof options.rng === 'function' ? options.rng : Math.random;

  combat.punch = (player) => punch(combat, player);
  combat.kick = (player) => kick(combat, player);
  combat.swingBlunt = (player) => swingBlunt(combat, player);
  combat.giveBlunt = (player, kind, hits) => giveBlunt(combat, player, kind, hits);
  combat.shoot = (player, opts) => shootPistol(combat, player, opts);
  combat.reload = (player) => reload(combat, player);
  combat.givePistol = (player, ammo) => givePistol(combat, player, ammo);
  combat.topUpAmmo = (player, rounds) => topUpAmmo(combat, player, rounds);
  combat.spawnPickup = (x, y, opts) => spawnPickup(combat, x, y, opts);
  combat.spawnWeapon = (x, y, kind) => spawnWeaponPickup(combat, x, y, kind);
  combat.assault = (officer, target) => officerAssault(combat, officer, target);
  combat.hurtPlayer = hurtPlayer;
  combat.update = (dt, w) => updateCombat(combat, w ?? combat.world, dt);

  if (world && typeof world === 'object') {
    world.combat = combat;
    if (typeof world.hurtPlayer !== 'function') world.hurtPlayer = hurtPlayer;
  }

  return combat;
}

/* ------------------------------------------------------------------ */
/* 4. per-frame update                                                 */
/* ------------------------------------------------------------------ */

/*
 * updateCombat(combat, world, dt)
 *
 * Accepts (combat, dt) as a convenience: the second argument is a number
 * then, and the world stored at construction is used. The world matters
 * only for reading officers, the crowd and the player back out again.
 */
export function updateCombat(combat, world, dt) {
  if (!combat) return combat;

  let w = world;
  let step = dt;
  if (typeof world === 'number') {
    step = world;
    w = combat.world ?? null;
  }

  const amount = Number(step);
  if (!Number.isFinite(amount) || amount <= 0) return combat;
  const s = Math.min(amount, 0.1);

  if (w) combat.world = w;
  const player = w?.player ?? combat.player ?? null;
  if (player) combat.player = player;

  tickTimers(combat, s);
  stepStrikes(combat, s);
  stepBullets(combat, w, s);
  stepParticles(combat, s);
  stepPickups(combat, w, s);
  stepOfficerAssaults(combat, w, s);

  if (player) {
    combat.fists = player.weapon !== 'pistol' && !player.car;
    if (player.car) combat.strikes.length = 0;
  }

  return combat;
}

/* Advance every one-shot timer, including the tail of a reload. */
function tickTimers(combat, dt) {
  const T = combat.tuning;

  if (combat.muzzle > 0) combat.muzzle = Math.max(0, combat.muzzle - dt);
  if (combat.pistolT > 0) combat.pistolT = Math.max(0, combat.pistolT - dt);
  if (combat.kickT > 0) combat.kickT = Math.max(0, combat.kickT - dt);
  if (combat.bluntT > 0) combat.bluntT = Math.max(0, combat.bluntT - dt);

  if (combat.reloadT > 0) {
    combat.reloadT = Math.max(0, combat.reloadT - dt);
    if (combat.reloadT === 0 && combat.reloader) {
      finishReload(combat, combat.reloader);
      combat.reloader = null;
      combat.reloadStage = null;
    }
  }

  /* The flash is capped at its configured life even if a shot is spammed. */
  if (combat.muzzle > T.muzzleFlashLife) combat.muzzle = T.muzzleFlashLife;
}

/* Punch, kick and pipe contacts land a set time after the swing begins. */
function stepStrikes(combat, dt) {
  for (let i = combat.strikes.length - 1; i >= 0; i--) {
    const strike = combat.strikes[i];
    strike.t -= dt;
    if (strike.t > 0) continue;

    combat.strikes.splice(i, 1);

    /* Hurt mid-swing: player.js has cancelled the punch, so it whiffs. */
    const p = strike.player;
    if (!p || !p.punching) continue;

    if (strike.kind === 'kick') resolveKick(combat, p);
    else if (strike.kind === 'blunt') resolveBlunt(combat, p, strike);
    else resolveMelee(combat, p);
  }
}

/* Move every live bullet in short sub-steps so nothing is shot through. */
function stepBullets(combat, w, dt) {
  const list = combat.bullets;

  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    b.px = b.x;
    b.py = b.y;

    const sx = b.vx * dt;
    const sy = b.vy * dt;
    const travel = Math.hypot(sx, sy);
    const steps = Math.max(1, Math.ceil(travel / BULLET_STEP));
    const dx = sx / steps;
    const dy = sy / steps;

    let done = false;

    for (let k = 0; k < steps && !done; k++) {
      const nx = b.x + dx;
      const ny = b.y + dy;

      const hit = blocker(combat, b.x, b.y, nx, ny);
      if (hit) {
        impactSpark(combat, nx, ny, 'wall');
        done = true;
        break;
      }

      const victim = raycastTarget(combat, w, b, b.x, b.y, nx, ny);
      if (victim) {
        applyBulletHit(combat, w, b, victim);
        done = true;
        break;
      }

      b.x = nx;
      b.y = ny;
      b.travelled += Math.hypot(dx, dy);
      if (b.travelled >= b.range) { done = true; break; }
    }

    b.life -= dt;
    if (done || b.life <= 0) list.splice(i, 1);
  }
}

/* Particle and spark pools: age in place, compact when they run long. */
function stepParticles(combat, dt) {
  agePool(combat.particles, dt);
  agePool(combat.sparks, dt);
  agePool(combat.corpses, dt);

  if (combat.corpses.length > CORPSE_LIMIT) {
    combat.corpses.splice(0, combat.corpses.length - CORPSE_LIMIT);
  }
}

function agePool(pool, dt) {
  for (let i = pool.length - 1; i >= 0; i--) {
    pool[i].life -= dt;
    if (pool[i].life <= 0) pool.splice(i, 1);
  }
}

/* Bob the glowing pickups and let a body on foot collect one. */
function stepPickups(combat, w, dt) {
  const player = w?.player ?? combat.player;
  const list = combat.pickups;

  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    if (it.taken) { list.splice(i, 1); continue; }

    it.bob = (it.bob ?? 0) + dt * PICKUP_BOB_RATE;

    if (!player || player.car || player.down) continue;

    const dx = player.x - it.x;
    const dy = player.y - it.y;
    if (dx * dx + dy * dy > PICKUP_RADIUS * PICKUP_RADIUS) continue;

    if (it.kind === 'pipe' || it.kind === 'bat') {
      /* A street weapon already in hand is swapped, not stacked. */
      giveBlunt(combat, player, it.kind, it.hits);
    } else if (it.kind === 'ammo') {
      if (!topUpAmmo(combat, player, it.rounds)) continue;
    } else {
      givePistol(combat, player);
    }
    it.taken = true;
    list.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ */
/* 5. melee                                                            */
/* ------------------------------------------------------------------ */

/*
 * Throw a punch. The swing itself belongs to player.js (startPunch), so a
 * staggered or seated body refuses here for the same reasons it does there;
 * combat only adds the stamina bill and the contact frame.
 */
export function punch(combat, player) {
  if (!combat || !player) return false;
  const T = combat.tuning;

  if ((player.stamina ?? 0) < MIN_STAMINA) return false;
  if (!startPunch(player)) return false;

  player.stamina = Math.max(0, (player.stamina ?? 0) - T.punchStamina);
  combat.strikes.push({ t: PUNCH_CONTACT, player });
  combat.fists = true;
  return true;
}

/*
 * Everything a punch could land on: live officers first (they are the
 * aggressors), then the walking crowd. Bodies already down are skipped.
 */
function gatherTargets(combat, w) {
  const out = [];
  const police = w?.police ?? combat.world?.police;
  const crowd = w?.pedestrians?.list ?? combat.world?.pedestrians?.list;

  if (Array.isArray(police?.officers)) {
    for (const o of police.officers) {
      if (!o || (o.hp ?? 1) <= 0) continue;
      out.push(o);
    }
  }

  if (Array.isArray(crowd)) {
    for (const ped of crowd) {
      if (!ped || ped.down || (ped.hp ?? 1) <= 0) continue;
      out.push(ped);
    }
  }
  return out;
}

/* The contact frame of a swing: cone test, damage, shove, spark. */
function resolveMelee(combat, attacker) {
  const T = combat.tuning;
  const reach = T.punchRange + PUNCH_REACH_PAD;
  const facing = Number.isFinite(attacker.facing) ? attacker.facing : 0;

  let landed = 0;

  for (const target of gatherTargets(combat, combat.world)) {
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const d = Math.hypot(dx, dy);
    if (d > reach + (target.radius ?? 0)) continue;

    const bearing = Math.atan2(dy, dx);
    if (Math.abs(angleDelta(facing, bearing)) > PUNCH_ARC) continue;

    const dealt = damageTarget(combat, target, T.punchDamage, { kind: 'melee' });
    if (dealt <= 0) continue;

    hitStagger(target, T.hitStagger);
    knockback(target, bearing, T.punchKnockback);

    if (target.hurtFlash !== undefined) target.hurtFlash = T.hitFlashLife;
    if (target.hurt !== undefined) target.hurt = Math.max(target.hurt ?? 0, 0.35);

    impactSpark(combat, target.x, target.y, 'melee');
    burst(combat, target.x, target.y, 4, '#f6e2ae');
    report(combat, 'hitPed');
    landed++;
  }

  return landed;
}

/*
 * Stun a body for `seconds` (default COMBAT.hitStagger) and cut off any
 * swing it had going. Exported because police officers, pedestrians and the
 * player all need the same three lines, and because callers that only have
 * a target in hand should not have to reach into the damage path.
 */
export function hitStagger(target, seconds) {
  if (!target) return 0;

  const raw = Number(seconds);
  const length = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TUNING.hitStagger;
  if (target.hp !== undefined && target.hp <= 0) return 0;

  target.stagger = Math.max(target.stagger ?? 0, length);

  if (target.punching) {
    target.punching = false;
    target.punchT = 0;
  }
  return length;
}

/* ------------------------------------------------------------------ */
/* 5b. kick — the shove that puts a body on the pavement               */
/* ------------------------------------------------------------------ */

/*
 * A push kick. Geometry is the same cone the punch uses, but shorter, wider
 * and far heavier: it does less health damage than a punch and instead drops
 * the target. The swing still comes from player.js's startPunch() so the
 * animation, cooldown and stagger rules stay in one place; combat only owns
 * the contact frame, the stamina bill and its own repeat gate.
 */
export function kick(combat, player) {
  if (!combat || !player) return false;
  const T = combat.tuning;

  if (player.down || player.car) return false;
  if (player.weapon !== 'fist') return false;      // no kicking with a gun out
  if ((player.stamina ?? 0) < T.kickStamina) return false;
  if (combat.kickT > 0) return false;
  if (!startPunch(player)) return false;

  player.stamina = Math.max(0, (player.stamina ?? 0) - T.kickStamina);
  combat.kickT = T.kickCooldown;
  combat.strikes.push({ t: KICK_CONTACT, player, kind: 'kick' });
  combat.fists = true;
  return true;
}

/* Contact frame of a kick: knock the target base over and leave it there. */
function resolveKick(combat, attacker) {
  const T = combat.tuning;
  const reach = T.kickRange + PUNCH_REACH_PAD;
  const facing = Number.isFinite(attacker.facing) ? attacker.facing : 0;
  const arc = PUNCH_ARC * 1.2;

  let landed = 0;

  for (const target of gatherTargets(combat, combat.world)) {
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const d = Math.hypot(dx, dy);
    if (d > reach + (target.radius ?? 0)) continue;

    const bearing = Math.atan2(dy, dx);
    if (Math.abs(angleDelta(facing, bearing)) > arc) continue;

    const dealt = damageTarget(combat, target, T.kickDamage, { kind: 'melee' });
    if (dealt <= 0) continue;

    knockback(target, bearing, T.kickKnockback);
    hitStagger(target, T.hitStagger * 1.4);

    /* Pedestrians carry a numeric `down` timer; a kick is what fills it in.
     * Officers are standing bodies on a schedule, so they only get shoved. */
    if (target.down !== undefined && !target.walkPhase) {
      target.down = Math.max(target.down === true ? 0 : (target.down ?? 0), T.kickDownTime);
      target.hurt = Math.max(target.hurt ?? 0, T.kickDownTime);
      target.speed = 0;
      target.fear = 0;
      target.panic = 0;
      target.paused = 0;
      if (target.state !== undefined) target.state = 'down';
    }

    if (target.hurtFlash !== undefined) target.hurtFlash = T.hitFlashLife;
    impactSpark(combat, target.x, target.y, 'melee');
    burst(combat, target.x, target.y, 6, '#e8d6bb');
    report(combat, 'hitPed');
    combat.lastMelee = 'kick';
    landed++;
  }

  return landed;
}

/* ------------------------------------------------------------------ */
/* 5c. blunt weapons — street pipes and bats                           */
/* ------------------------------------------------------------------ */

/*
 * Put a length of pipe or a bat in a body's hands. The weapon rides in
 * `player.meleeWeapon` rather than `player.weapon`, so the HUD's weapon line
 * and the pistol's rules keep meaning exactly what they did. Returns how many
 * connections the weapon has left (0 when the kind was unknown).
 */
export function giveBlunt(combat, player, kind = 'pipe', hits) {
  if (!player) return 0;
  const spec = BLUNT_KINDS[kind];
  if (!spec) return 0;

  player.meleeWeapon = spec.key;
  player.meleeLabel = spec.label;
  player.meleeHits = Number.isFinite(hits) && hits > 0 ? hits : spec.hits;

  /* A gun and a pipe in the same hands is nonsense: the pipe wins. */
  if (player.weapon === 'pistol') player.weapon = 'fist';

  if (combat) {
    combat.fists = true;
    combat.lastMelee = 'blunt';
  }
  return player.meleeHits;
}

/* Read the weapon a body is holding, if any. */
function bluntOf(player) {
  if (!player?.meleeWeapon) return null;
  return BLUNT_KINDS[player.meleeWeapon] ?? null;
}

/*
 * Swing whatever blunt weapon is in hand. Wears one connection off the
 * weapon at the contact frame, whether or not it connected — pipe against
 * a brick wall dents too. With nothing in hand it falls through to a punch,
 * so a caller can bind one button to "attack" and never wonder.
 */
export function swingBlunt(combat, player) {
  if (!combat || !player) return false;
  const T = combat.tuning;

  const spec = bluntOf(player);
  if (!spec) return punch(combat, player);

  if (player.down || player.car) return false;
  if (player.weapon !== 'fist') return false;
  if ((player.meleeHits ?? 0) <= 0) return punch(combat, player);
  if ((player.stamina ?? 0) < T.bluntStamina) return false;
  if (combat.bluntT > 0) return false;
  if (!startPunch(player)) return false;

  player.stamina = Math.max(0, (player.stamina ?? 0) - T.bluntStamina);
  combat.bluntT = T.bluntCooldown;
  combat.strikes.push({ t: BLUNT_CONTACT, player, kind: 'blunt', spec });
  combat.fists = true;
  return true;
}

/* Contact frame of a pipe or bat swing. */
function resolveBlunt(combat, attacker, strike) {
  const T = combat.tuning;
  const spec = strike?.spec ?? bluntOf(attacker);
  if (!spec) return 0;

  const reach = T.bluntRange + spec.reach + PUNCH_REACH_PAD;
  const facing = Number.isFinite(attacker.facing) ? attacker.facing : 0;
  const damage = T.bluntDamage * spec.damageMul;

  let landed = 0;

  for (const target of gatherTargets(combat, combat.world)) {
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const d = Math.hypot(dx, dy);
    if (d > reach + (target.radius ?? 0)) continue;

    const bearing = Math.atan2(dy, dx);
    if (Math.abs(angleDelta(facing, bearing)) > PUNCH_ARC) continue;

    const dealt = damageTarget(combat, target, damage, { kind: 'melee' });
    if (dealt <= 0) continue;

    hitStagger(target, T.bluntStagger);
    knockback(target, bearing, T.bluntKnockback);

    if (target.hurtFlash !== undefined) target.hurtFlash = T.hitFlashLife;
    if (target.hurt !== undefined) target.hurt = Math.max(target.hurt ?? 0, 0.5);

    impactSpark(combat, target.x, target.y, 'melee');
    burst(combat, target.x, target.y, 7, '#ffd9a0');
    report(combat, 'hitPed');
    combat.lastMelee = 'blunt';
    landed++;
  }

  /* The weapon takes the wear either way — a miss is a swing into a wall. */
  attacker.meleeHits = Math.max(0, (attacker.meleeHits ?? spec.hits) - 1);
  if (attacker.meleeHits <= 0) {
    attacker.meleeWeapon = null;
    attacker.meleeLabel = null;
    if (combat.player === attacker) combat.fists = true;
  }

  return landed;
}

/*
 * Shove a body along `angle` with `force`. Anything that integrates its own
 * velocity (the player, the crowd) keeps the impulse; officers are moved by
 * police.js straight to a position each tick, so they get an offset too.
 */
export function knockback(target, angle, force) {
  if (!target) return false;

  const amount = Number(force);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const dir = Number.isFinite(angle) ? angle : 0;
  const fx = Math.cos(dir) * amount;
  const fy = Math.sin(dir) * amount;

  if (Number.isFinite(target.vx)) target.vx += fx;
  if (Number.isFinite(target.vy)) target.vy += fy;

  /* Officers carry no velocity: nudge them so the punch visibly moves them. */
  if (!Number.isFinite(target.vx) && !Number.isFinite(target.vy)) {
    target.x += fx * 0.06;
    target.y += fy * 0.06;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 6. firearm                                                          */
/* ------------------------------------------------------------------ */

/*
 * Fire the sidearm. Fails (false) with no ammo, mid-reload, mid-cooldown,
 * while staggered or seated, or with something other than the pistol in
 * hand. A dry trigger pull starts a reload instead of clicking into the void.
 */
export function shootPistol(combat, player, options = {}) {
  if (!combat || !player) return false;
  const T = combat.tuning;

  if (player.down || player.car) return false;
  if ((player.stagger ?? 0) > 0) return false;
  if (player.weapon !== 'pistol') return false;
  if (combat.reloadT > 0 || combat.pistolT > 0) return false;

  if ((player.ammo ?? 0) <= 0) {
    reload(combat, player);
    return false;
  }

  const facing = Number.isFinite(player.facing) ? player.facing : 0;
  const angle = Number.isFinite(options.angle) ? options.angle : facing;
  const spreadDial = Number.isFinite(options.spread)
    ? options.spread
    : (options.spread === false ? 0 : T.pistolSpread);
  const spread = (combat.rand() * 2 - 1) * spreadDial;
  const shot = angle + spread;

  const mx = player.x + Math.cos(angle) * MUZZLE_OFFSET;
  const my = player.y + Math.sin(angle) * MUZZLE_OFFSET;

  player.ammo = Math.max(0, (player.ammo ?? 0) - 1);
  player.vx = (player.vx ?? 0) - Math.cos(angle) * MUZZLE_KICK;
  player.vy = (player.vy ?? 0) - Math.sin(angle) * MUZZLE_KICK;

  combat.pistolT = T.pistolCooldown;
  combat.muzzle = T.muzzleFlashLife;
  combat.fists = false;

  spawnBullet(combat, {
    x: mx,
    y: my,
    angle: shot,
    damage: T.pistolDamage,
    range: T.pistolRange,
    hostile: false,
  });

  /* Muzzle debris and the flash cone's bright core. */
  burst(combat, mx, my, 3, '#ffe6a8');
  impactSpark(combat, mx, my, 'gun');

  report(combat, 'gunshot');
  return true;
}

/*
 * Kick off a magazine swap. Returns true only when one actually starts;
 * a full magazine or an empty reserve leaves the weapon alone.
 *
 * Two flavours, and the difference matters under fire:
 *   - TACTICAL swap: there is still a round in the chamber, so the swap is
 *     quick and the chambered round survives — the magazine comes out with
 *     `ammo - 1` rounds still in it.
 *   - EMPTY swap (slide locked back): slower by `pistolEmptyReloadMul`, and
 *     the follower has to strip a fresh round out of the new magazine.
 */
export function reload(combat, player) {
  if (!combat || !player) return false;
  const T = combat.tuning;

  if (player.weapon !== 'pistol') return false;
  if (combat.reloadT > 0 || combat.reloader) return false;
  if ((player.ammo ?? 0) >= T.pistolAmmo) return false;
  if ((player.ammoReserve ?? 0) <= 0) return false;

  const chambered = (player.ammo ?? 0) > 0;
  const stage = chambered ? 'tactical' : 'empty';
  const mul = chambered ? 1 : T.pistolEmptyReloadMul;

  combat.reloadT = T.pistolReload * mul;
  combat.reloader = player;
  combat.reloadStage = stage;
  player.reloadStage = stage;
  player.reloadTotal = combat.reloadT;

  return true;
}

/* The instant a reload completes: top the magazine up from the reserve. */
function finishReload(combat, player) {
  const T = combat.tuning;
  const mag = T.pistolAmmo;
  const have = Math.max(0, player.ammo ?? 0);
  const reserve = Math.max(0, player.ammoReserve ?? 0);

  /* A tactical swap keeps the chambered round, so only `mag - 1` rounds come
   * out of the reserve; an empty swap needs the full magazine plus a round
   * to chamber. Rounds left in the ejected magazine are simply lost, which
   * is what makes reloading early cost something. */
  const keep = T.pistolChamber && have > 0 ? 1 : 0;
  const need = Math.max(0, mag - keep);
  const moved = Math.min(need, reserve);

  player.ammo = Math.min(mag, keep + moved);
  player.ammoReserve = reserve - moved;
  player.weapon = 'pistol';
  player.reloadStage = null;
  player.reloadTotal = 0;
}

/*
 * Top the reserve up without touching the magazine — an ammo box on the
 * pavement. Capped by `pistolReserveMax` so a lucky streak cannot print
 * infinite rounds. Returns how many actually went into the pockets.
 */
export function topUpAmmo(combat, player, rounds) {
  if (!player) return 0;
  const T = combat?.tuning ?? DEFAULT_TUNING;

  const want = Number.isFinite(rounds) && rounds > 0 ? rounds : T.pistolAmmo;
  const cap = Math.max(T.pistolReserve, T.pistolReserveMax);
  const have = Math.max(0, player.ammoReserve ?? 0);
  if (have >= cap) return 0;

  const added = Math.min(want, cap - have);
  player.ammoReserve = have + added;
  /* A fresh box in hand is a reason to have the sidearm out. */
  if ((player.ammoReserve ?? 0) > 0 && (player.weapon === 'fist' || !player.weapon)
      && (player.ammo ?? 0) > 0) {
    player.weapon = 'pistol';
  }
  if (combat) combat.fists = player.weapon !== 'pistol' && !combat.player?.car;
  return added;
}

/*
 * Put the pistol in a body's hands. Picking one up loads a full magazine and
 * tops the reserve up to the configured figure; calling it again on an armed
 * body only ever adds ammo, never resets progress.
 */
export function givePistol(combat, player, ammo) {
  if (!player) return 0;
  const T = combat?.tuning ?? DEFAULT_TUNING;

  player.weapon = 'pistol';
  player.ammo = Math.max(player.ammo ?? 0, T.pistolAmmo);

  const reserveWant = Number.isFinite(ammo) ? Math.max(0, ammo) : T.pistolReserve;
  player.ammoReserve = Math.max(player.ammoReserve ?? 0, reserveWant);

  if (combat) {
    combat.fists = false;
    if (combat.reloadT > 0) {
      combat.reloadT = 0;
      combat.reloader = null;
    }
  }
  return player.ammo;
}

/*
 * Drop an item on the ground; render.js draws `pickups` as bobbing icons.
 * `kind` is 'pistol' (default) or 'ammo'; `hits` and `rounds` tune the item.
 */
export function spawnPickup(combat, x, y, options = {}) {
  if (!combat) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const pickup = {
    x,
    y,
    kind: options.kind ?? 'pistol',
    hits: Number.isFinite(options.hits) ? options.hits : undefined,
    rounds: Number.isFinite(options.rounds) ? options.rounds : undefined,
    bob: combat.rand() * TAU,
    taken: false,
  };
  combat.pickups.push(pickup);
  return pickup;
}

/*
 * Drop a blunt weapon on the street. Pipes and bats lie about in the alleys,
 * so this is the pickup the kick-and-bat system hangs off.
 */
export function spawnWeaponPickup(combat, x, y, kind = 'pipe') {
  if (!BLUNT_KINDS[kind]) return null;
  return spawnPickup(combat, x, y, { kind, hits: BLUNT_KINDS[kind].hits });
}

/*
 * Scatter street weapons around a set of points — call it once at world build
 * so the alleys have something in them. Returns the pickups it managed to
 * place; points outside the map or already holding an item are skipped.
 */
export function seedStreetWeapons(combat, points, kinds = ['pipe', 'bat']) {
  if (!combat || !Array.isArray(points)) return [];
  const made = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const kind = kinds[i % kinds.length];
    const it = spawnWeaponPickup(combat, p.x, p.y, kind);
    if (it) made.push(it);
  }
  return made;
}

/*
 * A bullet from anyone but the player — officer return fire, for instance.
 * Police.js currently deals its damage directly, so this exists for the
 * wiring that wants a visible tracer plus the same hit rules.
 */
export function shootAt(combat, shooter, target, options = {}) {
  if (!combat || !shooter || !target) return null;
  const T = combat.tuning;

  const angle = Math.atan2(target.y - shooter.y, target.x - shooter.x);
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);

  const bullet = spawnBullet(combat, {
    x: shooter.x + fx * MUZZLE_OFFSET,
    y: shooter.y + fy * MUZZLE_OFFSET,
    angle,
    damage: Number.isFinite(options.damage) ? options.damage : T.pistolDamage * 0.5,
    range: Number.isFinite(options.range) ? options.range : T.pistolRange * 0.6,
    hostile: true,
  });

  combat.muzzle = T.muzzleFlashLife;
  burst(combat, shooter.x + fx * MUZZLE_OFFSET, shooter.y + fy * MUZZLE_OFFSET, 2, '#ffe6a8');
  return bullet;
}

/* Build the projectile render.js reads: a short trail from px/py to x/y. */
function spawnBullet(combat, spec) {
  const T = combat.tuning;
  if (combat.bullets.length >= MAX_BULLETS) combat.bullets.shift();

  const speed = PISTOL_SPEED;
  const bullet = {
    x: spec.x,
    y: spec.y,
    px: spec.x,
    py: spec.y,
    vx: Math.cos(spec.angle) * speed,
    vy: Math.sin(spec.angle) * speed,
    angle: spec.angle,
    damage: spec.damage,
    range: spec.range,
    travelled: 0,
    life: Math.max(0.08, spec.range / speed),
    max: Math.max(0.08, spec.range / speed),
    hostile: !!spec.hostile,
    bounces: T.bulletPenetration,
  };

  combat.bullets.push(bullet);
  return bullet;
}

/* ------------------------------------------------------------------ */
/* 7. damage plumbing                                                  */
/* ------------------------------------------------------------------ */

/*
 * Apply damage to whatever was hit and return how much actually landed.
 * A body with `health` is the player and goes through player.js's own
 * hurtPlayer, so regen timers and the down transition stay authoritative.
 * Officers and pedestrians carry `hp` and are handled here.
 */
export function damageTarget(combat, target, amount, options = {}) {
  if (!target) return 0;

  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  if (Number.isFinite(target.health) && target.hp === undefined) {
    const dealt = hurtPlayer(target, raw);
    if (dealt > 0 && options.kind === 'bullet') {
      burst(combat, target.x, target.y, 3, '#ffb4a2');
    }
    return dealt;
  }

  const armour = Number(target.armour ?? target.armor ?? 0);
  let dmg = raw;
  if (armour > 0) {
    const pierce = options.kind === 'melee' ? combat.tuning.meleeArmorPierce : 1;
    dmg = Math.max(1, raw - armour * (1 - pierce));
  }

  const before = Number.isFinite(target.hp) ? target.hp : 100;
  target.hp = Math.max(0, before - dmg);

  if (target.hp <= 0 && before > 0) fell(combat, target, options.kind ?? 'bullet');
  return before - target.hp;
}

/* A body dropped: leave a fading mark the renderer can paint as a corpse. */
function fell(combat, target, kind) {
  if (target.down !== undefined) target.down = true;
  if (combat.corpses.length >= CORPSE_LIMIT) combat.corpses.shift();

  combat.corpses.push({
    x: target.x,
    y: target.y,
    facing: target.facing ?? 0,
    kind,
    life: combat.tuning.deathFade,
    max: combat.tuning.deathFade,
  });
}

/* First live body the bullet path crosses, considering hostility. */
function raycastTarget(combat, w, bullet, x1, y1, x2, y2) {
  if (!w) return null;

  if (bullet.hostile) {
    const p = w.player;
    if (!p || p.down || p.car) return null;
    const r = (p.radius ?? 9) + PLAYER_PAD;
    return segmentHitsCircle(x1, y1, x2, y2, p.x, p.y, r) ? p : null;
  }

  for (const target of gatherTargets(combat, w)) {
    const r = target.radius ?? (target.hp !== undefined && target.walkPhase !== undefined
      ? OFFICER_RADIUS
      : PED_RADIUS);
    if (target === combat.player) continue;
    if (segmentHitsCircle(x1, y1, x2, y2, target.x, target.y, r)) return target;
  }
  return null;
}

/* Landed bullet: falloff, damage, stagger, impact effects. */
function applyBulletHit(combat, w, bullet, target) {
  const T = combat.tuning;
  const frac = clamp(bullet.travelled / Math.max(1, bullet.range), 0, 1);
  const falloff = 1 + (T.pistolFalloff - 1) * frac;
  const dmg = bullet.damage * falloff;

  const dealt = damageTarget(combat, target, dmg, { kind: 'bullet' });
  if (dealt > 0) {
    hitStagger(target, T.hitStagger);
    knockback(target, bullet.angle, T.punchKnockback * 0.25);
    if (target.hurtFlash !== undefined) target.hurtFlash = T.hitFlashLife;
  }

  impactSpark(combat, bullet.x, bullet.y, 'bullet');
  burst(combat, bullet.x, bullet.y, 5, '#ffb4a2');
  if (!bullet.hostile) report(combat, 'hitPed');
}

/* A bright four-ray spark; render.js draws these with `kind`. */
function impactSpark(combat, x, y, kind) {
  if (combat.sparks.length >= MAX_SPARKS) combat.sparks.shift();
  combat.sparks.push({
    x,
    y,
    kind,
    life: 0.16,
    max: 0.16,
  });
}

/* Small radial puff of debris or dust. */
function burst(combat, x, y, count, colour) {
  for (let i = 0; i < count; i++) {
    if (combat.particles.length >= MAX_PARTICLES) combat.particles.shift();

    const a = combat.rand() * TAU;
    const speed = 30 + combat.rand() * 70;
    const life = 0.18 + combat.rand() * 0.22;

    combat.particles.push({
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      r: 1.2 + combat.rand() * 1.8,
      colour,
      life,
      max: life,
    });
  }
}

/* Report a crime to the police controller, if one is wired up. */
function report(combat, type) {
  const api = combat.world?.police;
  if (!api || typeof api.crime !== 'function') return;
  api.crime(type);
}

/* ------------------------------------------------------------------ */
/* 8. officer assaults                                                 */
/* ------------------------------------------------------------------ */

/*
 * police.js shoots at anything between 26 and 210 units and stands still
 * inside 26 waiting for the cuffs. That leaves the close quarter dull and
 * perfectly safe, so combat owns the gap: an officer at arm's length picks
 * one of four answers, and which one depends on range, how many colleagues
 * are alongside, and how hot the street is.
 *
 *   baton    short, quick, staggers; the bread-and-butter swing
 *   tackle   a body check that puts the player on the floor and costs ground
 *   warning  a aimed shot into the pavement — no damage, a big stagger, and
 *            the whole crowd hears it
 *   volley   two or more officers firing together, only when the player has
 *            already drawn blood
 *
 * Everything is driven from updateCombat(), so no wiring is needed elsewhere:
 * an officer just has to exist in world.police.officers with x / y.
 */

const ASSAULT_REACH = 46;      // inner ring an officer will step into
const ASSAULT_VOLLEY_HEAT = 40; // heat above which a pair fires together

/*
 * Run one officer's assault attempt against `target`. Returns the kind that
 * landed, or null. Exported and bound on the combat object so a caller can
 * force an attack (a scripted scene, a mission beat) without waiting for the
 * per-frame pass.
 */
export function officerAssault(combat, officer, target) {
  if (!combat || !officer || !target) return null;
  const T = combat.tuning;

  if (target.down) return null;
  if (target.car) return null;                 // a car is the ramming problem
  if ((officer.hp ?? 1) <= 0) return null;
  if ((officer.__assaultT ?? 0) > 0) return null;

  const dx = target.x - officer.x;
  const dy = target.y - officer.y;
  const d = Math.hypot(dx, dy);
  if (d > ASSAULT_REACH) return null;

  const bearing = Math.atan2(dy, dx);
  const heat = Number(combat.world?.heat ?? 0);

  /* Colleagues standing shoulder to shoulder can volley. */
  let mates = 0;
  const officers = combat.world?.police?.officers;
  if (Array.isArray(officers)) {
    for (const other of officers) {
      if (other === officer || !other || (other.hp ?? 1) <= 0) continue;
      if (Math.hypot(other.x - officer.x, other.y - officer.y) < 70) mates++;
    }
  }

  let kind;
  if (heat >= ASSAULT_VOLLEY_HEAT && mates >= 1 && d > T.officerBatonRange) kind = 'volley';
  else if (d <= T.officerBatonRange) kind = 'baton';
  else if (d <= T.officerTackleRange) kind = 'tackle';
  else kind = combat.rand() < 0.5 ? 'warning' : 'baton';

  officer.__assaultT = T.officerAssaultCooldown * (0.85 + combat.rand() * 0.4);
  officer.facing = bearing;
  officer.swingT = 0.12;

  switch (kind) {
    case 'baton': {
      const damage = T.officerBatonDamage;
      const dealt = damageTarget(combat, target, damage, { kind: 'melee' });
      hitStagger(target, T.hitStagger * 1.2);
      knockback(target, bearing, 90);
      burst(combat, target.x, target.y, 4, '#d9c8a6');
      if (dealt > 0) report(combat, 'hitPed');
      break;
    }
    case 'tackle': {
      const damage = T.officerTackleDamage;
      damageTarget(combat, target, damage, { kind: 'melee' });
      hitStagger(target, T.hitStagger * 2.4);
      knockback(target, bearing, 200);
      officer.x += Math.cos(bearing) * 6;
      officer.y += Math.sin(bearing) * 6;
      burst(combat, target.x, target.y, 6, '#c9d4de');
      break;
    }
    case 'warning': {
      /* Aimed at the pavement, but the report alone buckles the knees. */
      const mx = officer.x + Math.cos(bearing) * MUZZLE_OFFSET;
      const my = officer.y + Math.sin(bearing) * MUZZLE_OFFSET;
      combat.muzzle = T.muzzleFlashLife;
      burst(combat, mx, my, 2, '#ffe6a8');
      impactSpark(combat, mx, my, 'gun');
      hitStagger(target, T.hitStagger * 2);
      if (officer.lastShot === undefined) officer.lastShot = { x: mx, y: my, t: 0 };
      else { officer.lastShot.x = mx; officer.lastShot.y = my; }
      report(combat, 'gunshot');
      break;
    }
    case 'volley':
    default: {
      for (const other of officers ?? [officer]) {
        if (!other || (other.hp ?? 1) <= 0) continue;
        if (other !== officer && Math.hypot(other.x - target.x, other.y - target.y) > 260) continue;
        shootAt(combat, other, target, { damage: T.pistolDamage * 0.34 });
      }
      break;
    }
  }

  return kind;
}

/*
 * The per-frame pass: advance every officer's assault clock, then let anyone
 * inside the ring take a swing. Officers are only aggressive while the street
 * is hot; a calm patrol walks past.
 */
function stepOfficerAssaults(combat, w, dt) {
  const player = w?.player;
  const officers = w?.police?.officers;
  if (!player || !Array.isArray(officers) || !officers.length) return;
  if (player.down) return;

  const heat = Number(w?.heat ?? 0);
  if (!(heat > 0)) return;

  for (const o of officers) {
    if (!o || (o.hp ?? 1) <= 0) continue;
    const left = Number.isFinite(o.__assaultT) ? o.__assaultT : 0;
    if (left > 0) o.__assaultT = Math.max(0, left - dt);

    const dx = player.x - o.x;
    const dy = player.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d > ASSAULT_REACH) continue;
    if ((o.__assaultT ?? 0) > 0) continue;

    /* Officers hold back at one star: warnings and batons only. */
    const kind = officerAssault(combat, o, player);
    if (kind) combat.lastAssault = kind;
  }
}

export default createCombat;
