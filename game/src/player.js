/*
 * player.js — the body the human steers.
 *
 * Responsibilities, in order:
 *   1. birth:     createPlayer() stamps out the avatar from the city spawn
 *   2. vitality:  stamina (sprint fuel), health, slow heal, hurt flash, down
 *   3. melee:     punch state machine driven by startPunch()
 *   4. firearm:   which tool is in hand and how much ammo is left
 *   5. motion:    on-foot integration, water rejection, depenetration
 *   6. dodge:     slide roll — dodge key, stamina bill, hurt immunity
 *   7. seating:   enterCar() / leaveCar() hand the body to a vehicle
 *   8. condition: animation bookkeeping — gait blend, footfalls, panting,
 *                 limp — derived here so render/HUD can stay dumb
 *
 * Every exported symbol keeps the signature the rest of the game already
 * calls: createPlayer(city), updatePlayer(p, city, input, dt),
 * enterCar(p, car), leaveCar(p, city). Combat also gets startPunch(p)
 * and hurtPlayer(p, dmg).
 *
 * Two read-only groups sit at the bottom of the file and never write
 * gameplay state on their own: gait introspection for HUD/audio
 * (getSpeedState, isMoving, facingAngle) and a save-compatible pair
 * (serializePlayer / restorePlayer) that speaks exactly the player block
 * the save layer already stores. Nothing else here is public.
 *
 * The body object stays a plain bag of numbers, strings and booleans so the
 * save layer can round-trip it without special cases. Fields added later are
 * always seeded by createPlayer() and defensively re-seeded by the tick
 * helpers, so an old save that only knows the original fields still loads.
 */

import { PLAYER, COMBAT } from './config.js';
import { clamp, resolveCircleRect, normalizeAngle } from './utils.js';
import { exitPosition } from './vehicles.js';

/* ---- geometry tuning ------------------------------------------------ */

const MARGIN = 12;          // keep the body this far from the world edge
const SKIN = 1.5;           // extra radius used only for depenetration
const RELAX_PASSES = 2;     // push-out iterations per frame
const COAST_RATE = 16;      // exponential stop rate when no input
const CREEP_THRESHOLD = 1;  // below this speed we snap to a full stop
const MOVE_EPSILON = 8;     // below this speed the body counts as standing still
const MAX_STEP = 0.25;      // never integrate more than a quarter second

/* ---- vitality tuning ------------------------------------------------ */

const STAMINA_MAX = 100;
const STAMINA_DRAIN = 26;        // spent per second of sprinting
const STAMINA_REGEN = 19;        // recovered per second when not sprinting
const STAMINA_RECOVER_GATE = 22; // must climb back to here after exhaustion
const STAMINA_MIN_SPRINT = 1;    // a sliver is enough to start a sprint

/* ---- slide / dodge tuning ------------------------------------------- */

const SLIDE_COST = 30;           // stamina spent per slide
const SLIDE_COST_MIN = 12;       // a slide always bills at least this much
const SLIDE_SPEED = 420;         // world units / second during the slide
const SLIDE_TIME = 0.35;         // seconds the slide lasts
const SLIDE_COOLDOWN = 0.6;      // seconds before another slide can start
const SLIDE_IFRAME = 0.18;       // seconds of hurt immunity during slide
const SLIDE_MIN_STAMINA = 15;    // minimum stamina required to slide
const SLIDE_DRAIN = 18;          // stamina per second spent while sliding
const SLIDE_TRAVEL_FLOOR = 0.3;  // a slide that covers less than this share of
                                 // its expected distance hit something: it ends
const DODGE_KEYS = ['Space'];    // on-foot dodge button (Space is the handbrake
                                 // while driving, so the two never collide)

/* Slow heal: only after a quiet spell, and never while knocked down. */
const REGEN_DELAY = Number.isFinite(PLAYER.regenDelay) ? PLAYER.regenDelay : 12;
const REGEN_RATE = Number.isFinite(PLAYER.regenRate) ? PLAYER.regenRate : 2.5;
const HEALTH_MAX = Number.isFinite(PLAYER.maxHealth) ? PLAYER.maxHealth : 100;

/* ---- condition / animation tuning ----------------------------------- */

const RUN_BLEND_RATE = 7;    // how fast the gait eases between walk and run
const STRIDE_LENGTH = 30;    // world units of travel per footfall
const MOUNT_TIME = 0.22;     // door-swing beat when getting in or out
const BREATH_RATE = 3.4;     // pant cycles per second while exhausted
const LIMP_HEALTH = 0.35;    // health fraction under which the body limps
const HURT_STAGGER = COMBAT.hitStagger ?? 0.22;

/* ---- punch / hit tuning --------------------------------------------- */

const PUNCH_LIFE = 0.28;         // how long the arm stays extended
const HURT_FLASH_LIFE = COMBAT.hitFlashLife;

/* ------------------------------------------------------------------ */
/* construction                                                        */
/* ------------------------------------------------------------------ */

/*
 * A fresh body at the city spawn. Fields fall into six buckets: transform,
 * wallet & condition, gait bookkeeping, vehicle slot, combat, and the
 * derived animation block. Everything is a plain value so the save layer
 * can round-trip the object without special cases.
 */
export function createPlayer(city) {
  const spawn = city.spawn ?? { x: city.downtown.x, y: city.downtown.y, facing: Math.PI / 2 };
  const facing = Number.isFinite(spawn.facing) ? spawn.facing : Math.PI / 2;

  return {
    /* transform */
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing,
    radius: PLAYER.radius,

    /* wallet & condition */
    health: HEALTH_MAX,
    maxHealth: HEALTH_MAX,
    money: 0,
    cash: 0,
    hurtFlash: 0,
    down: false,
    regenT: 0,
    stagger: 0,

    /* gait bookkeeping (distance walked drives the leg swing) */
    walking: 0,
    steps: 0,
    stepAcc: 0,
    footfalls: 0,

    /* vehicle slot */
    car: null,
    seatT: 0,

    /* stamina: sprint fuel */
    stamina: STAMINA_MAX,
    staminaMax: STAMINA_MAX,
    exhausted: false,

    /* slide / dodge state */
    sliding: false,
    slideT: 0,
    slideCooldown: 0,
    slideDirX: 0,
    slideDirY: 0,
    slideIFrame: 0,
    slideTravel: 0,     // ground covered by the slide in progress
    slides: 0,          // lifetime count, for stats/HUD

    /* melee state */
    punching: false,
    punchT: 0,
    punchCooldown: 0,

    /* firearm state */
    weapon: 'fist',
    ammo: 0,

    /* derived animation state (recomputed every tick, safe to ignore) */
    anim: 'idle',
    animPhase: 0,
    gaitBlend: 0,
    breath: 0,
    limp: 0,
    speed: 0,
    moving: false,
    sprinting: false,
  };
}

/* ------------------------------------------------------------------ */
/* combat entry points                                                 */
/* ------------------------------------------------------------------ */

/*
 * Try to throw a punch. Returns true only when a swing actually starts;
 * combat uses that to decide whether to apply damage at the contact frame
 * (and whether to play a whiff sound). Staggered or seated bodies swing
 * at nothing.
 */
export function startPunch(p) {
  if (!p || p.down || p.car) return false;
  if ((p.stagger ?? 0) > 0) return false;

  const cooling = (p.punchCooldown ?? 0) > 0 || p.punching;
  if (cooling) return false;

  p.punching = true;
  p.punchT = PUNCH_LIFE;
  p.punchCooldown = COMBAT.punchCooldown;
  return true;
}

/*
 * Apply damage from any source. The return value is how much health was
 * actually removed, which callers use to decide on knockback, flashes and
 * "player is down" transitions. Non-positive or non-finite damage is a no-op.
 *
 * Damage also stalls natural healing (regenT back to zero wins over any
 * partial tick) and staggers the body out of a punch.
 */
export function hurtPlayer(p, dmg) {
  if (!p) return 0;

  const amount = Number(dmg);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (p.down) return 0;
  if ((p.slideIFrame ?? 0) > 0) return 0; // slide iframe: dodge the hit

  const before = Number.isFinite(p.health) ? p.health : 0;
  p.health = Math.max(0, before - amount);
  p.hurtFlash = HURT_FLASH_LIFE;
  p.regenT = 0;
  p.stagger = Math.max(p.stagger ?? 0, HURT_STAGGER);

  if (p.health <= 0) {
    p.down = true;
    p.punching = false;
    p.punchT = 0;
    p.vx = 0;
    p.vy = 0;
    p.walking = 0;
    p.stamina = 0;
    p.exhausted = true;
    p.sliding = false;
    p.slideT = 0;
    p.slideDirX = 0;
    p.slideDirY = 0;
    p.anim = 'down';
  } else {
    /* A live hit briefly interrupts the swing; the cooldown still runs. */
    p.punching = false;
    p.punchT = 0;
    p.sliding = false;
    p.slideT = 0;
    p.slideDirX = 0;
    p.slideDirY = 0;
  }

  return before - p.health;
}

/* ------------------------------------------------------------------ */
/* collision helpers                                                   */
/* ------------------------------------------------------------------ */

/* Is a circle of radius r at (x, y) clear of the world and its colliders? */
function canFit(city, x, y, r) {
  if (x < MARGIN || y < MARGIN) return false;
  if (x > city.water.x + city.water.w - MARGIN || y > city.height - MARGIN) return false;
  if (city.isWater(x, y)) return false;

  for (const c of city.collidersNear(x, y, r)) {
    if (c.kind === 'circle') {
      const dx = x - c.x;
      const dy = y - c.y;
      const reach = r + c.r;
      if (dx * dx + dy * dy <= reach * reach) return false;
    } else if (resolveCircleRect(x, y, r, c)) {
      return false;
    }
  }
  return true;
}

/* Circle-vs-circle push-out, or null when the two do not overlap. */
function pushCircle(px, py, pr, c) {
  const dx = px - c.x;
  const dy = py - c.y;
  const reach = pr + c.r;
  const d2 = dx * dx + dy * dy;
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

/*
 * Slide the body back out of anything it has sunk into, a couple of passes
 * so corners settle, then clamp to the playable rectangle. Velocity pointing
 * into a wall is cancelled so the body does not keep accumulating speed.
 */
function depenetrate(body, city) {
  const r = body.radius + SKIN;

  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    let touched = false;

    for (const c of city.collidersNear(body.x, body.y, r)) {
      const hit = c.kind === 'circle'
        ? pushCircle(body.x, body.y, r, c)
        : resolveCircleRect(body.x, body.y, r, c);
      if (!hit) continue;

      body.x = hit.x;
      body.y = hit.y;
      touched = true;

      const into = body.vx * hit.nx + body.vy * hit.ny;
      if (into < 0) {
        body.vx -= hit.nx * into;
        body.vy -= hit.ny * into;
      }
    }

    if (!touched) break;
  }

  body.x = clamp(body.x, MARGIN, city.water.x + city.water.w - MARGIN);
  body.y = clamp(body.y, MARGIN, city.height - MARGIN);
}

/* ------------------------------------------------------------------ */
/* timers                                                              */
/* ------------------------------------------------------------------ */

/* Advance the hurt flash, stagger, punch swing and cooldown by one frame. */
function tickTimers(p, dt) {
  if (p.hurtFlash > 0) p.hurtFlash = Math.max(0, p.hurtFlash - dt);
  if (p.stagger > 0) p.stagger = Math.max(0, p.stagger - dt);
  if (p.seatT > 0) p.seatT = Math.max(0, p.seatT - dt);

  if (p.punchCooldown > 0) p.punchCooldown = Math.max(0, p.punchCooldown - dt);

  if (p.punching) {
    p.punchT -= dt;
    if (p.punchT <= 0) {
      p.punchT = 0;
      p.punching = false;
    }
  }
}

/*
 * Sprint fuel. A sprint costs stamina every frame it is held; standing,
 * walking or riding pays it back. Hitting zero marks the body exhausted, and
 * it cannot sprint again until a bit of the bar has refilled — that
 * hysteresis stops the bar from rattling on and off at the empty mark.
 */
function tickStamina(p, sprinting, dt) {
  if (p.staminaMax == null) p.staminaMax = STAMINA_MAX;
  if (p.stamina == null) p.stamina = p.staminaMax;

  if (sprinting) {
    p.stamina -= STAMINA_DRAIN * dt;
    if (p.stamina <= 0) {
      p.stamina = 0;
      p.exhausted = true;
    }
    return;
  }

  /* Mid-roll the bar only burns: the dodge has its own drain downstream,
   * and letting regen tick here would silently cancel it out. */
  if (p.sliding) return;

  if (p.stamina < p.staminaMax) {
    p.stamina = Math.min(p.staminaMax, p.stamina + STAMINA_REGEN * dt);
  }
  if (p.exhausted && p.stamina >= STAMINA_RECOVER_GATE) p.exhausted = false;
}

/* May the body actually sprint this frame? */
function canSprint(p, wantsRun) {
  if (!wantsRun) return false;
  if (p.exhausted) return false;
  if (p.health <= 0) return false;
  return (p.stamina ?? 0) > STAMINA_MIN_SPRINT;
}

/* ---- slide / dodge -------------------------------------------------- */

/* Advance slide state: cooldown, active slide timer, iframe. */
function tickSlide(p, dt) {
  if (p.slideCooldown > 0) p.slideCooldown = Math.max(0, p.slideCooldown - dt);
  if (p.sliding) {
    p.slideT -= dt;
    if (p.slideT <= 0) {
      p.slideT = 0;
      p.sliding = false;
      p.slideDirX = 0;
      p.slideDirY = 0;
      p.slideTravel = 0;
    }
  }
  if (p.slideIFrame > 0) p.slideIFrame = Math.max(0, p.slideIFrame - dt);
}

/*
 * Read a dodge request out of the input bag. Newer inputs answer dodge()
 * directly; older ones only expose raw key state, and a standing body with
 * no held direction still gets a dodge (backwards roll) so the button is
 * never dead. Returns true on the frame the button went down.
 */
function wantsDodge(p, input) {
  if (!input) return false;
  if (typeof input.dodge === 'function') return !!input.dodge();
  if (typeof input.pressedDodge === 'function') return !!input.pressedDodge();
  if (typeof input.justPressed === 'function') {
    for (let i = 0; i < DODGE_KEYS.length; i++) {
      if (input.justPressed(DODGE_KEYS[i])) return true;
    }
  }
  return false;
}

/*
 * Try to start a slide in the current move direction. Returns true if the
 * slide began.
 *
 * The dodge rolls the way the body is already being pushed. With no stick
 * input it rolls backwards out of the facing instead of refusing, which is
 * what makes the button useful as a panic dodge; a body standing dead still
 * and facing nowhere still gets a clean roll rather than a no-op.
 */
export function startSlide(p, input) {
  if (!p || p.down || p.car || p.sliding) return false;
  if ((p.stagger ?? 0) > 0) return false;
  if ((p.slideCooldown ?? 0) > 0) return false;
  if (p.exhausted) return false;
  if ((p.stamina ?? 0) < SLIDE_MIN_STAMINA) return false;

  const mv = input && typeof input.move === 'function' ? input.move() : { x: 0, y: 0 };
  const mx = Number.isFinite(mv?.x) ? mv.x : 0;
  const my = Number.isFinite(mv?.y) ? mv.y : 0;
  const len = Math.hypot(mx, my);

  /* Held direction first, then momentum, then a backwards roll. */
  let ux = 0;
  let uy = 0;
  if (len >= 0.5) {
    ux = mx / len;
    uy = my / len;
  } else {
    const vx = Number.isFinite(p.vx) ? p.vx : 0;
    const vy = Number.isFinite(p.vy) ? p.vy : 0;
    const vlen = Math.hypot(vx, vy);
    if (vlen > 8) {
      ux = vx / vlen;
      uy = vy / vlen;
    } else {
      const facing = Number.isFinite(p.facing) ? p.facing : 0;
      ux = -Math.cos(facing);
      uy = -Math.sin(facing);
    }
  }

  /* The bill comes off stamina before anything else can fail. */
  const cost = Math.max(SLIDE_COST_MIN, Math.min(SLIDE_COST, p.stamina));
  p.stamina = Math.max(0, p.stamina - cost);
  if (p.stamina <= 0) p.exhausted = true;

  p.sliding = true;
  p.slideT = SLIDE_TIME;
  p.slideCooldown = SLIDE_COOLDOWN;
  p.slideDirX = ux;
  p.slideDirY = uy;
  p.slideIFrame = SLIDE_IFRAME;
  p.slideTravel = 0;
  p.slides = (p.slides ?? 0) + 1;
  p.facing = Math.atan2(uy, ux);
  p.punching = false;
  p.punchT = 0;
  return true;
}

/*
 * Slow heal. Health only creeps back once the body has gone REGEN_DELAY
 * seconds without taking a hit; any damage resets the clock (hurtPlayer
 * does that). Downed bodies never heal — being revived is somebody else's
 * job. Riding in a car heals exactly as much as standing still.
 */
function tickHealth(p, dt) {
  if (p.maxHealth == null) p.maxHealth = HEALTH_MAX;
  if (!Number.isFinite(p.health)) p.health = p.maxHealth;
  if (p.health < 0) p.health = 0;
  if (p.health > p.maxHealth) p.health = p.maxHealth;

  if (p.down) {
    p.regenT = 0;
    return;
  }

  if (p.health >= p.maxHealth) {
    p.regenT = 0;
    return;
  }

  p.regenT = (p.regenT ?? 0) + dt;
  if (p.regenT < REGEN_DELAY) return;

  p.health = Math.min(p.maxHealth, p.health + REGEN_RATE * dt);
}

/* ------------------------------------------------------------------ */
/* condition / animation                                               */
/* ------------------------------------------------------------------ */

/*
 * Advance stride bookkeeping: how much ground was covered since the last
 * footfall, how many footfalls that earned, and how far the leg swing has
 * travelled. Split out of tickCondition() so the gait blend above and the
 * cadence below each stay readable; it writes only derived fields.
 */
function advanceStride(p, speed, dt) {
  const stride = STRIDE_LENGTH * (1 + p.gaitBlend * 0.45);
  if (speed <= 4) {
    p.stepAcc = 0;
    return;
  }

  p.stepAcc = (p.stepAcc ?? 0) + speed * dt;
  let guard = 0;
  while (p.stepAcc >= stride && guard++ < 8) {
    p.stepAcc -= stride;
    p.footfalls = (p.footfalls ?? 0) + 1;
  }
  p.animPhase += (speed / stride) * Math.PI * dt;
}

/*
 * Everything the renderer needs to know about how the body is carrying
 * itself this frame, without the renderer having to know any of the rules.
 * Pure bookkeeping: writes only derived fields, never gameplay state.
 */
function tickCondition(p, speed, dt) {
  if (speed == null) speed = Math.hypot(p.vx ?? 0, p.vy ?? 0);

  if (p.animPhase == null || !Number.isFinite(p.animPhase)) p.animPhase = 0;
  if (p.gaitBlend == null || !Number.isFinite(p.gaitBlend)) p.gaitBlend = 0;
  if (p.breath == null || !Number.isFinite(p.breath)) p.breath = 0;
  if (p.limp == null || !Number.isFinite(p.limp)) p.limp = 0;

  p.speed = speed;
  p.moving = speed > MOVE_EPSILON;

  /* Gait blend: 0 = walk cadence, 1 = full run cadence. */
  const runTarget = speed > PLAYER.walkSpeed * 1.1 ? 1 : 0;
  const blend = 1 - Math.exp(-RUN_BLEND_RATE * dt);
  p.gaitBlend += (runTarget - p.gaitBlend) * blend;

  /* Footfall cadence follows ground covered, not wall-clock time. */
  advanceStride(p, speed, dt);

  /* Panting fades in while exhausted and fades out on recovery. */
  const breathTarget = p.exhausted ? 1 : 0;
  p.breath += (breathTarget - p.breath) * (1 - Math.exp(-2.2 * dt));

  /* Limping tracks health fraction, hardest just above zero. */
  const frac = p.maxHealth > 0 ? clamp(p.health / p.maxHealth, 0, 1) : 0;
  const limpTarget = frac < LIMP_HEALTH ? 1 - frac / LIMP_HEALTH : 0;
  p.limp += (limpTarget - p.limp) * (1 - Math.exp(-5 * dt));

  /* Coarse state tag for render/HUD switches. */
  if (p.down) p.anim = 'down';
  else if (p.car) p.anim = 'drive';
  else if (p.sliding) p.anim = 'slide';
  else if (p.punching) p.anim = 'punch';
  else if ((p.hurtFlash ?? 0) > 0 || (p.stagger ?? 0) > 0) p.anim = 'hurt';
  else if (speed > PLAYER.walkSpeed * 1.1) p.anim = 'run';
  else if (speed > MOVE_EPSILON) p.anim = 'walk';
  else p.anim = 'idle';
}

/* ------------------------------------------------------------------ */
/* per-frame update                                                    */
/* ------------------------------------------------------------------ */

/*
 * One frame while seated: the car is the authority, so the body simply
 * tracks its transform, spends no stamina and still heals. Split out of
 * updatePlayer() so the on-foot integration below reads as one path.
 */
function tickSeated(p, step) {
  p.x = p.car.x;
  p.y = p.car.y;
  p.facing = p.car.angle;
  p.vx = 0;
  p.vy = 0;
  p.walking = 0;
  p.speed = 0;
  p.moving = false;
  p.sprinting = false;

  /* Riding is rest: fuel refills at the on-foot rate. */
  tickStamina(p, false, step);

  /* A knock-down does not survive a car ride; the body is out of reach. */
  p.stagger = 0;
  tickCondition(p, 0, step);
}

/*
 * One simulation step for the body. While seated the avatar simply tracks
 * the car's transform, spends no stamina and still heals; on foot we resolve
 * intent into a velocity, integrate axis by axis (water blocks each axis
 * separately so you slide along the shoreline instead of sticking), then
 * depenetrate.
 */
export function updatePlayer(p, city, input, dt) {
  if (!p || !city) return;

  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_STEP) : 0;
  if (step === 0) return;

  tickTimers(p, step);
  tickSlide(p, step);
  tickHealth(p, step);

  /* --- seated: the car is the authority --------------------------- */
  if (p.car) {
    tickSeated(p, step);
    return;
  }

  /* --- read intent ------------------------------------------------ */
  const mv = input && typeof input.move === 'function' ? input.move() : { x: 0, y: 0 };
  const wantsRun = input && typeof input.running === 'function' ? !!input.running() : false;

  let mx = Number.isFinite(mv?.x) ? mv.x : 0;
  let my = Number.isFinite(mv?.y) ? mv.y : 0;

  /* A downed or staggered body cannot steer itself; momentum carries it. */
  if (p.down || (p.stagger ?? 0) > 0) {
    mx = 0;
    my = 0;
  }

  const len = Math.hypot(mx, my);
  const ux = len > 0 ? mx / len : 0;
  const uy = len > 0 ? my / len : 0;

  const sprinting = len > 0 && canSprint(p, wantsRun);
  p.sprinting = sprinting;
  tickStamina(p, sprinting, step);

  /*
   * --- dodge button -------------------------------------------------
   * Checked before the ordinary motion path so a slide started on this
   * frame is the one integrated below. startSlide() is itself strict
   * about stamina, cooldown, stagger and seating, so this is just the
   * key edge plus the call.
   */
  if (!p.sliding && wantsDodge(p, input)) startSlide(p, input);

  if (len > 0) {
    p.facing = Math.atan2(uy, ux);
    p.walking += (sprinting ? 1.7 : 1) * step;
  }

  /* --- slide / dodge ------------------------------------------------ */
  if (p.sliding) {
    p.vx = p.slideDirX * SLIDE_SPEED;
    p.vy = p.slideDirY * SLIDE_SPEED;
    p.sprinting = false;
    /* The roll is a burst of speed, not free fuel: it burns while it
     * lasts so a slide can never be chained with a sprint on one bar. */
    if (p.slideT > 0) {
      p.stamina = Math.max(0, (p.stamina ?? 0) - SLIDE_DRAIN * step);
      if (p.stamina <= 0) p.exhausted = true;
    }
  } else {
    const topSpeed = sprinting ? PLAYER.runSpeed : PLAYER.walkSpeed;

    if (len > 0) {
      const grip = 1 - Math.exp(-PLAYER.accel * step);
      p.vx += (ux * topSpeed - p.vx) * grip;
      p.vy += (uy * topSpeed - p.vy) * grip;
    } else {
      const keep = Math.exp(-COAST_RATE * step);
      p.vx *= keep;
      p.vy *= keep;
      if (Math.abs(p.vx) < CREEP_THRESHOLD) p.vx = 0;
      if (Math.abs(p.vy) < CREEP_THRESHOLD) p.vy = 0;
    }
  }

  /* --- integrate, refusing water on each axis --------------------- */
  const oldX = p.x;
  const oldY = p.y;

  p.x += p.vx * step;
  if (city.isWater(p.x, p.y)) {
    p.x = oldX;
    p.vx = 0;
  }

  p.y += p.vy * step;
  if (city.isWater(p.x, p.y)) {
    p.y = oldY;
    p.vy = 0;
  }

  depenetrate(p, city);

  const travelled = Math.hypot(p.x - oldX, p.y - oldY);
  p.steps += travelled;

  /*
   * A slide that gets eaten by a wall stops dead instead of grinding
   * against it for the rest of its timer — that keeps the dodge honest
   * (you paid the stamina, you get to keep the iframe, but you do not get
   * a free push through a building).
   */
  if (p.sliding) {
    p.slideTravel = (p.slideTravel ?? 0) + travelled;
    const expected = SLIDE_SPEED * step;
    if (expected > 0 && travelled < expected * SLIDE_TRAVEL_FLOOR && step > 0.001) {
      p.sliding = false;
      p.slideT = 0;
      p.slideDirX = 0;
      p.slideDirY = 0;
      p.slideTravel = 0;
    }
  }

  tickCondition(p, Math.hypot(p.vx, p.vy), step);
}

/* ------------------------------------------------------------------ */
/* vehicle seating                                                     */
/* ------------------------------------------------------------------ */

/*
 * Take a free car. Fails silently (false) if one is already occupied or held,
 * or if the body is in no condition to climb in. Seating zeroes the car's
 * controls so a parked car never lurches the moment the door closes.
 */
export function enterCar(p, car) {
  if (!p || !car || p.car || car.occupied || p.down) return false;

  car.occupied = true;
  car.speed = 0;
  car.steer = 0;

  p.car = car;
  p.walking = 0;
  p.punching = false;
  p.punchT = 0;
  p.stagger = 0;
  p.seatT = MOUNT_TIME;
  p.x = car.x;
  p.y = car.y;
  p.facing = car.angle;
  p.vx = 0;
  p.vy = 0;
  p.speed = 0;
  p.moving = false;
  p.sprinting = false;
  tickCondition(p, 0, 0);
  return true;
}

/*
 * Pick a spot outside the car. Preference order: the door the car model
 * suggests, then a ring of offsets around the body, and as a last resort
 * a clamped fallback that always yields a position inside the world.
 */
function findExitSpot(p, city, car) {
  const comfy = exitPosition(car);
  if (canFit(city, comfy.x, comfy.y, p.radius)) return { x: comfy.x, y: comfy.y };

  const near = car.width * 0.5 + 16;
  const far = car.width * 0.5 + 34;
  const mid = (near + far) * 0.5;
  const headings = [
    car.angle + Math.PI / 2,
    car.angle - Math.PI / 2,
    car.angle + Math.PI,
    car.angle,
  ];

  for (const dist of [near, mid, far]) {
    for (const heading of headings) {
      const x = car.x + Math.cos(heading) * dist;
      const y = car.y + Math.sin(heading) * dist;
      if (canFit(city, x, y, p.radius)) return { x, y };
    }
  }

  return {
    x: clamp(comfy.x, MARGIN, city.water.x + city.water.w - MARGIN),
    y: clamp(comfy.y, MARGIN, city.height - MARGIN),
  };
}

/*
 * Step out. Hands the car back with its controls neutral, drops the body on
 * the safest free patch found by findExitSpot(), and faces it away from the
 * door. A knocked-down body still leaves the seat — it just leaves it down.
 */
export function leaveCar(p, city) {
  if (!p) return false;

  const car = p.car;
  if (!car || !city) return false;

  const spot = findExitSpot(p, city, car);

  car.occupied = false;
  car.speed = 0;
  car.steer = 0;

  p.car = null;
  p.x = clamp(spot.x, MARGIN, city.water.x + city.water.w - MARGIN);
  p.y = clamp(spot.y, MARGIN, city.height - MARGIN);
  p.vx = 0;
  p.vy = 0;
  p.walking = 0;
  p.seatT = MOUNT_TIME;
  p.facing = car.angle + Math.PI / 2;
  tickCondition(p, 0, 0);
  return true;
}

/* ------------------------------------------------------------------ */
/* dodge introspection (pure readers)                                  */
/* ------------------------------------------------------------------ */

/*
 * Read-only view of the dodge numbers, for a tuning screen or a HUD that
 * wants to draw the dodge cost on the stamina bar. Frozen: nothing here is
 * meant to be written back.
 */
export const SLIDE_TUNING = Object.freeze({
  cost: SLIDE_COST,
  costMin: SLIDE_COST_MIN,
  drain: SLIDE_DRAIN,
  speed: SLIDE_SPEED,
  time: SLIDE_TIME,
  cooldown: SLIDE_COOLDOWN,
  iframe: SLIDE_IFRAME,
  minStamina: SLIDE_MIN_STAMINA,
});

/**
 * canSlide(p) -> { ok, reason }
 *
 * Why the dodge button would or would not work this frame. Mirrors the
 * guards in startSlide() exactly, so a HUD prompt can say "SPENT" or
 * "COOLDOWN" instead of just swallowing the press. Pure.
 */
export function canSlide(p) {
  if (!p) return { ok: false, reason: 'missing' };
  if (p.down) return { ok: false, reason: 'down' };
  if (p.car) return { ok: false, reason: 'seated' };
  if (p.sliding) return { ok: false, reason: 'sliding' };
  if ((p.stagger ?? 0) > 0) return { ok: false, reason: 'staggered' };
  if ((p.slideCooldown ?? 0) > 0) return { ok: false, reason: 'cooldown' };
  if (p.exhausted) return { ok: false, reason: 'exhausted' };
  if ((p.stamina ?? 0) < SLIDE_MIN_STAMINA) return { ok: false, reason: 'spent' };
  return { ok: true, reason: null };
}

/**
 * dodgeState(p) -> { active, progress, cost, iframe, cooldown, ready }
 *
 * Everything a renderer needs to draw the roll and a HUD needs to draw the
 * cooldown: 0..1 progress through the slide, the stamina bill, whether the
 * hurt immunity window is still open, and 0..1 cooldown remaining. Pure.
 */
export function dodgeState(p) {
  if (!p) {
    return { active: false, progress: 0, cost: SLIDE_COST, iframe: 0, cooldown: 0, ready: false };
  }
  const life = Number.isFinite(p.slideT) ? p.slideT : 0;
  const progress = p.sliding && SLIDE_TIME > 0 ? clamp(1 - life / SLIDE_TIME, 0, 1) : 0;
  const cool = Number.isFinite(p.slideCooldown) ? p.slideCooldown : 0;
  return {
    active: p.sliding === true,
    progress,
    cost: SLIDE_COST,
    iframe: clamp(p.slideIFrame ?? 0, 0, SLIDE_IFRAME),
    cooldown: SLIDE_COOLDOWN > 0 ? clamp(cool / SLIDE_COOLDOWN, 0, 1) : 0,
    ready: canSlide(p).ok,
  };
}

/* ------------------------------------------------------------------ */
/* gait introspection (pure readers)                                   */
/* ------------------------------------------------------------------ */

/*
 * Current ground speed without trusting a stale `p.speed`: the tick writes
 * it every frame, but a caller can ask before the first update has run.
 */
function readSpeed(p) {
  if (!p) return 0;
  if (Number.isFinite(p.speed)) return p.speed;
  const vx = Number.isFinite(p.vx) ? p.vx : 0;
  const vy = Number.isFinite(p.vy) ? p.vy : 0;
  return Math.hypot(vx, vy);
}

/**
 * getSpeedState(p) -> 'idle' | 'walk' | 'run' | 'drive'
 *
 * Coarse movement class for HUD/audio, derived from the body's current
 * state and using the same thresholds as the animation tag. Pure: it never
 * writes to `p`, so it is safe to call at any point in the frame.
 */
export function getSpeedState(p) {
  if (!p) return 'idle';
  if (p.car) return 'drive';

  const speed = readSpeed(p);
  if (speed > PLAYER.walkSpeed * 1.1) return 'run';
  if (speed > MOVE_EPSILON) return 'walk';
  return 'idle';
}

/**
 * isMoving(p) -> boolean
 *
 * True while the body is actually travelling, on foot or by car. Uses the
 * car's own speed while seated, because a seated body's transform velocity
 * is deliberately zeroed by the tick.
 */
export function isMoving(p) {
  if (!p) return false;
  if (p.car) {
    const carSpeed = Number.isFinite(p.car.speed) ? Math.abs(p.car.speed) : 0;
    return carSpeed > MOVE_EPSILON;
  }
  return readSpeed(p) > MOVE_EPSILON;
}

/**
 * facingAngle(p) -> number
 *
 * Heading in radians, wrapped into [0, TAU). Non-finite or missing facings
 * read as 0 so callers never have to guard. Pure.
 */
export function facingAngle(p) {
  const facing = Number.isFinite(p?.facing) ? p.facing : 0;
  return normalizeAngle(facing);
}

/* ------------------------------------------------------------------ */
/* save bridge                                                         */
/* ------------------------------------------------------------------ */

/* Numeric coercion shared by restorePlayer(): keeps the old save layer's
 * "strings that hold a number are fine" tolerance without ever yielding NaN. */
function savedNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * serializePlayer(p) -> object
 *
 * The player block exactly as the save layer already stores it (see
 * snapshot() in main.js): transform, condition, wallet, weapon and stamina.
 * No new fields are introduced and nothing derived is written, so an
 * existing save round-trips unchanged. Safe on null.
 */
export function serializePlayer(p) {
  if (!p) return {};
  return {
    x: savedNumber(p.x, 0),
    y: savedNumber(p.y, 0),
    facing: savedNumber(p.facing, 0),
    health: savedNumber(p.health, p.maxHealth ?? HEALTH_MAX),
    maxHealth: savedNumber(p.maxHealth, HEALTH_MAX),
    money: savedNumber(p.money, 0),
    weapon: p.weapon === 'pistol' ? 'pistol' : 'fist',
    ammo: savedNumber(p.ammo, 0),
    ammoReserve: savedNumber(p.ammoReserve, 0),
    stamina: savedNumber(p.stamina, p.staminaMax ?? STAMINA_MAX),
  };
}

/**
 * restorePlayer(p, state) -> p
 *
 * Inverse of serializePlayer(): applies a saved player block to an existing
 * body with the same clamps applySave() uses in main.js, so loading through
 * here and loading through the shell agree. Fields absent from `state` keep
 * their current value.
 *
 * The vehicle slot and the derived animation block are deliberately left
 * alone — the tick recomputes the latter, and seating is the shell's call.
 * Never throws; a null body or a non-object state is a silent no-op.
 */
export function restorePlayer(p, state) {
  if (!p) return null;
  if (!state || typeof state !== 'object') return p;

  if (state.maxHealth !== undefined) {
    p.maxHealth = Math.max(1, savedNumber(state.maxHealth, p.maxHealth ?? HEALTH_MAX));
  }
  if (state.health !== undefined) {
    const maxHealth = p.maxHealth ?? HEALTH_MAX;
    p.health = clamp(savedNumber(state.health, maxHealth), 1, maxHealth);
    p.down = false;
  }

  p.x = savedNumber(state.x, p.x ?? 0);
  p.y = savedNumber(state.y, p.y ?? 0);
  p.facing = savedNumber(state.facing, p.facing ?? 0);

  if (state.money !== undefined) p.money = Math.max(0, savedNumber(state.money, 0));
  if (state.weapon !== undefined) p.weapon = state.weapon === 'pistol' ? 'pistol' : 'fist';
  if (state.ammo !== undefined) p.ammo = Math.max(0, savedNumber(state.ammo, 0));
  if (state.ammoReserve !== undefined) {
    p.ammoReserve = Math.max(0, savedNumber(state.ammoReserve, 0));
  }
  if (state.stamina !== undefined) {
    const staminaMax = Number.isFinite(p.staminaMax) ? p.staminaMax : STAMINA_MAX;
    p.stamina = clamp(savedNumber(state.stamina, staminaMax), 0, staminaMax);
  }

  /* Loaded bodies start at rest, like a fresh spawn. */
  p.vx = 0;
  p.vy = 0;
  p.walking = 0;
  p.stagger = 0;
  p.hurtFlash = 0;
  p.punching = false;
  p.punchT = 0;
  p.punchCooldown = 0;
  p.sliding = false;
  p.slideT = 0;
  p.slideCooldown = 0;
  p.slideDirX = 0;
  p.slideDirY = 0;
  p.slideIFrame = 0;
  p.slideTravel = 0;
  tickCondition(p, 0, 0);
  return p;
}
