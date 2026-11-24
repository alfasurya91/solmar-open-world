/*
 * Solmar — entry point.
 *
 * This module builds the world object, constructs every system in game/src
 * and owns the frame loop. Nothing else in the project reads the DOM or
 * schedules frames: render.js and hud.js are handed the same `world` every
 * frame and only read it.
 *
 * The world contract (every field below is read by at least one module):
 *
 *   world = {
 *     city, view, player, parked, traffic, pedestrians, police, combat,
 *     time, clock, day, wanted, wantedLevel, heat, busted, wasted, over,
 *     objective, sideJob, jobsDone, saveStatus, mute, carsNear(), hurtPlayer()
 *   }
 *
 *   - police.js owns wanted / wantedLevel / heat / busted / wasted / over.
 *     Its internal sync() mirrors them onto the world every tick, so the
 *     shell only seeds them at build time and resets them between runs.
 *     There is no updatePolice export: the pursuit is advanced through
 *     `world.police.update(dt, world)`.
 *   - missions.js writes objective / jobsDone on every tick (syncWorld).
 *     The shell mirrors a free-roam objective onto world.sideJob so hud.js
 *     can paint its side-mission card (Rush Parcel included).
 *   - pedestrians.js calls world.carsNear(x, y, r) to look for threats.
 *   - police.js damages the player through world.hurtPlayer(player, amount).
 *     It never calls COMBAT.hitStagger, so leave that slot on player.js's
 *     hurtPlayer: createCombat() only installs its own when the slot is not
 *     already a function.
 *
 * Frame pipeline (see "frame loop" below):
 *
 *   1. clampedFrameDelta() turns the wall-clock gap between two animation
 *      frames into a bounded delta. A backgrounded tab or a stalled machine
 *      can produce gaps of seconds; the clamp caps that at MAX_FRAME, and
 *      MAX_CATCHUP_STEPS caps how many fixed steps one frame may run, so a
 *      stall can never queue an unbounded backlog of work (the "spiral of
 *      death").
 *   2. advanceSimulation() feeds that delta to a fixed STEP (1/60 s) loop.
 *      Each step runs, in this order:
 *        input -> player -> vehicles -> traffic -> pedestrians -> police
 *        -> combat -> missions -> audio
 *      police runs *before* combat on purpose: combat.js reads world.heat
 *      (officer aggression, voileys) and world.heat is only fresh once
 *      police.update() has cooled or raised it for this step.
 *   3. The loop then runs the frame-rate presentation work once: HUD timers,
 *      fade, throttled DOM writes, idle audio, and finally render() — one
 *      canvas draw per rendered frame, never per simulation step.
 *
 * The loop is suspended while the tab is hidden and restarted when it comes
 * back, with the hidden gap discarded instead of simulated.
 *
 * URL hooks:
 *   ?seed=N               generate the city from another seed
 *   ?autostart=1          skip the menu and start driving
 *   ?difficulty=NAME      santai | normal | keras (see config.DIFFICULTIES)
 *   ?shot=start|play|end  deterministic frame for screenshots
 *
 * Controls added by this shell (input.js already raises the bits):
 *   Q  ACT_KICK   push kick, fists only
 *   F  ACT_BLUNT  swing the pipe/bat in hand (falls back to a punch)
 *   R  ACT_RELOAD magazine swap
 *   G             take the next job when nothing is active
 *   4 / 5 / 6     pick save slot 1 / 2 / 3
 */

import {
  STEP, MAX_FRAME, MAX_CATCHUP_STEPS, FONT, CITY, SAVE, PLAYER, VEHICLE, COLORS,
  DEFAULT_DIFFICULTY, resolveDifficulty,
} from './config.js';
import { clamp, formatMoney, formatClock, roundRect, createRandom } from './utils.js';
import {
  createInput, ACT_CONFIRM, ACT_PAUSE, ACT_INTERACT, ACT_SAVE, ACT_LOAD,
  ACT_ATTACK, ACT_WEAPON, ACT_CANCEL, ACT_RELOAD, ACT_MAP, ACT_HORN,
  ACT_KICK, ACT_BLUNT,
} from './input.js';
import {
  hasSave, readSaveFrom, writeSaveTo, inspectSaveFrom, listSlots,
  saveSlotIds, getActiveSlot, setActiveSlot,
} from './save.js';
import { createPlayer, updatePlayer, enterCar, leaveCar, hurtPlayer } from './player.js';
import {
  createCar, carProfile, driveCar, moveCar, isHardImpact, damageCar,
  nearestCar, canStealCar, stealCar, tickHotwire,
} from './vehicles.js';
import { createTraffic } from './traffic.js';
import { createPedestrians } from './pedestrians.js';
import { createCity } from './city.js';
import { createRenderer } from './render.js';
import { createHud } from './hud.js';
import { createPolice, OUTCOME_BUSTED, OUTCOME_WASTED, OUTCOME_CLEAR } from './police.js';
import { createCombat, updateCombat } from './combat.js';
import { createMissions, updateMissions, startNextMission, marker } from './missions.js';
import {
  createAudio, updateAudio, playShot, playPunch, playPickup,
  playMissionComplete, playSiren, playClick, setMuted, setMusicTrackById,
} from './audio.js';

/* ------------------------------------------------------------------ */
/* constants that belong to the shell, not to a system                */
/* ------------------------------------------------------------------ */

const CLOCK_START = 16 * 60 + 20;   // 16:20 — the afternoon the game opens on
const MINUTES_PER_SECOND = 1.5;     // 1440 in-game minutes ≈ 16 real minutes
const SPEED_SCALE = 2.4;            // world units/s -> km/h (hud.js uses the same)
const FADE_IN = 0.55;               // seconds of black on a fresh start
const DOM_SYNC_EVERY = 0.1;         // seconds between DOM HUD writes
const HUD_RECHECK = 2.0;            // seconds between hasSave() probes on the title
const SPAWN_PISTOL_DX = 96;         // pistol pickup offset from the spawn point
const SPAWN_PISTOL_DY = 34;
const SPAWN_PIPE_DX = -74;          // a pipe on the other kerb, so F has a job
const SPAWN_PIPE_DY = 46;
const STORY_LENGTH = 5;             // missions.js ships a five-job story arc

/* A hotwire only counts while the player stands at the door. Walking further
 * than this abandons it after a short grace, so the lock cannot finish itself
 * from across the district and warp the player into the seat. */
const HOTWIRE_LEASH = 96;           // world units from the door
const HOTWIRE_LEASH_GRACE = 1.2;    // seconds of slack before it is dropped

/* The two themes audio.js ships; updateAudio() swaps them itself, the shell
 * names them so the wanted-driven swap above is explicit. */
const TRACK_CHASE = 'chase';
const TRACK_CRUISE = 'cruise';

/* Audio keeps ticking while the sim is frozen, so paused frames send this. */
const IDLE_AUDIO = { paused: true, speed: 0, wanted: 0, siren: false, chase: false };

const byId = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

/* Write text only when it changed: the loop touches these every 100 ms. */
function setText(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.__lastText !== next) {
    el.textContent = next;
    el.__lastText = next;
  }
}

/* Same idea as setText, for the one readout that carries markup (<small>). */
function setHtml(el, value) {
  if (!el) return;
  if (el.__lastHtml !== value) {
    el.innerHTML = value;
    el.__lastHtml = value;
  }
}

/* 0 = full day, 1 = deep night. Feeds the light pass and the headlights. */
function nightOf(minutes) {
  const h = ((((Number.isFinite(minutes) ? minutes : 0) / 60) % 24) + 24) % 24;
  if (h < 5) return 1;
  if (h < 7) return 1 - (h - 5) / 2;
  if (h < 18) return 0;
  if (h < 21) return (h - 18) / 3;
  return 1;
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

function boot() {
  const canvas = byId('game');
  if (!canvas) return;

  /* ---------------- DOM the shell owns ---------------- */

  const dom = {
    hud: byId('hud'),
    menu: byId('menu'),
    loading: byId('loading'),
    play: byId('play'),
    status: byId('status'),
    cash: byId('hud-cash-value'),
    clock: byId('hud-clock-value'),
    area: byId('hud-area-value'),
    objective: byId('hud-objective-value'),
    speed: byId('hud-speed-value'),
    note: byId('hud-note-value'),
    sideName: byId('hud-side-name'),
    sideProgress: byId('hud-side-progress'),
    sideReward: byId('hud-side-reward'),
    sideFill: byId('hud-side-fill'),
  };

  /* ---------------- query hooks ---------------- */

  const params = new URLSearchParams((typeof window !== 'undefined' && window.location.search) || '');
  const rawSeed = Number.parseInt(params.get('seed') ?? '', 10);
  const seed = Number.isFinite(rawSeed) ? rawSeed : CITY.seed;
  const autostart = params.get('autostart') === '1';
  const shotParam = params.get('shot');
  const shot = shotParam === 'start' || shotParam === 'play' || shotParam === 'end' ? shotParam : null;
  const diff = resolveDifficulty(params.get('difficulty') || DEFAULT_DIFFICULTY);

  /* ---------------- long-lived systems ---------------- */

  const city = createCity(seed);
  /*
   * city.parked is the generator's authored list of parking spots. Keep it
   * pristine and copy it once: world.parked is the live fleet that systems
   * push into and splice out of, so rebuilding a run must not consume the
   * spots it already turned into cars.
   */
  const parkedSpots = Array.isArray(city.parked) ? city.parked.slice() : [];
  const rng = createRandom(seed ^ 0x5f3759df);
  const renderer = createRenderer(canvas, city);
  const hud = createHud();
  const input = createInput(canvas, { gamepad: true, bufferWindow: 220 });
  const audio = createAudio({});
  const ctx = canvas.getContext('2d');

  /* Slot ids come from save.js so the shell never hard-codes "3". */
  const SLOTS = (() => {
    const ids = saveSlotIds();
    return Array.isArray(ids) && ids.length ? ids : [1, 2, 3];
  })();

  /* ---------------- the world ---------------- */

  const world = {
    city,
    view: renderer.view,
    player: null,
    parked: [],
    traffic: null,
    pedestrians: null,
    police: null,
    combat: null,

    time: 0,
    clock: CLOCK_START,
    day: 1,
    wanted: 0,
    wantedLevel: 0,
    heat: 0,
    busted: false,
    wasted: false,
    over: OUTCOME_CLEAR,

    objective: null,
    sideJob: null,
    jobsDone: 0,
    saveStatus: 'none',
    mute: false,
  };

  /*
   * world.hurtPlayer is the single damage path police.js uses. Install it
   * here, before any controller is constructed: combat.js deliberately
   * leaves a non-empty slot alone, so both systems end up routing through
   * player.hurtPlayer().
   */
  world.hurtPlayer = (target, amount) => hurtPlayer(target ?? world.player, amount);

  /*
   * Threat lookup for pedestrians.js. Returns every car within `r` of the
   * point: the parked fleet, ambient traffic, and the cruisers themselves
   * (police.cars holds { car, ... } wrappers, which are unwrapped here).
   */
  world.carsNear = (x, y, r) => {
    const nearby = [];
    const reach2 = (Number.isFinite(r) ? r : 120) ** 2;

    const consider = (car) => {
      if (!car || !Number.isFinite(car.x) || !Number.isFinite(car.y)) return;
      const dx = car.x - x;
      const dy = car.y - y;
      if (dx * dx + dy * dy <= reach2) nearby.push(car);
    };

    if (Array.isArray(world.parked)) for (const c of world.parked) consider(c);
    if (Array.isArray(world.traffic?.list)) for (const c of world.traffic.list) consider(c);
    if (Array.isArray(world.police?.cars)) {
      for (const unit of world.police.cars) consider(unit?.car ?? unit);
    }
    return nearby;
  };

  /* ---------------- shell state ---------------- */

  const game = {
    screen: 'title',   // title | play | paused | over
    outcome: null,     // 'wasted' | 'busted' once the run has ended
    acc: 0,            // unspent frame time handed to the fixed-step loop
    last: 0,           // timestamp of the previous frame
    frames: 0,
    fade: 1,
    mapOpen: false,
    hotwire: null,     // car whose lock is being worked
    hotwireLeft: 0,    // seconds left on that hotwire
    hotwireGrace: 0,   // seconds the player may drift away from that lock
    missions: null,
    slot: SLOTS[0],    // save slot the shell writes to and loads from
    sideKey: null,     // dedupe key for the side-job announcements
    sirenLevel: 0,     // last wanted level a siren was started for
    domT: 0,
    saveT: 0,
    hudCheckT: 0,
    hasSave: false,
    running: false,
    shotHeld: false,   // ?shot= frame staged: the loop renders it, never advances it
  };

  /*
   * Set from the moment a run starts until the shell hands the menu back.
   * index.html's loader reveals #menu on its own timer, so this flag is what
   * keeps that menu from popping up over a live game. See suppressMenu().
   */
  let menuSuppressed = false;

  /* ------------------------------------------------------------------ */
  /* actors                                                             */
  /* ------------------------------------------------------------------ */

  /*
   * Release the previous occupants before respawning them.
   *
   * createPolice() reuses a world.police object it finds and Object.assigns
   * onto it, but its api exposes heat / level / wanted as getter-only
   * accessors. Rebuilding a run with the old api still in the slot therefore
   * throws on the assign, so the slot is cleared to null first: createPolice
   * then builds a fresh wrapper object for itself.
   */
  function teardownActors() {
    game.hotwire = null;
    game.hotwireLeft = 0;
    game.hotwireGrace = 0;
    game.sideKey = null;
    game.sirenLevel = 0;
    world.police = null;
    world.combat = null;
    world.traffic = null;
    world.pedestrians = null;
    world.player = null;
    world.parked = [];
    world.objective = null;
    world.sideJob = null;
    world.jobsDone = 0;
    world.busted = false;
    world.wasted = false;
    world.over = OUTCOME_CLEAR;
    world.wanted = 0;
    world.wantedLevel = 0;
    world.heat = 0;
  }

  function buildActors() {
    teardownActors();

    const player = createPlayer(city);
    player.maxHealth = diff.player.maxHealth;
    player.health = player.maxHealth;
    world.player = player;

    world.parked = parkedSpots.map((spot) => createCar(
      spot.x, spot.y, spot.angle ?? 0, spot.color, 'parked',
    ));

    world.traffic = createTraffic(city, rng);
    world.pedestrians = createPedestrians(city, rng);
    world.police = createPolice(city, world, {
      police: diff.police,
      rng,
      heatGain: diff.policeHeatGain,
    });
    world.combat = createCombat(city, world, { rng });

    game.missions = createMissions(city, { difficulty: diff, random: rng });
    game.hotwire = null;
    game.hotwireLeft = 0;
    game.hotwireGrace = 0;

    world.jobsDone = 0;
    world.objective = null;
    world.sideJob = null;
    world.wanted = 0;
    world.wantedLevel = 0;
    world.heat = 0;
    world.busted = false;
    world.wasted = false;
    world.over = OUTCOME_CLEAR;
    world.clock = CLOCK_START;
    world.day = 1;
    world.time = 0;
    world.saveStatus = 'none';

    /* One pistol on the pavement beside the spawn, so the sidearm is reachable,
     * and a pipe across the road so the F swing has something to hold. */
    world.combat.spawnPickup(player.x + SPAWN_PISTOL_DX, player.y + SPAWN_PISTOL_DY);
    if (typeof world.combat.spawnWeapon === 'function') {
      world.combat.spawnWeapon(player.x + SPAWN_PIPE_DX, player.y + SPAWN_PIPE_DY, 'pipe');
    }
  }

  /* ------------------------------------------------------------------ */
  /* simulation — one phase per system, in the documented order         */
  /* ------------------------------------------------------------------ */

  function advanceClock(dt) {
    world.clock += dt * MINUTES_PER_SECOND;
    while (world.clock >= 1440) {
      world.clock -= 1440;
      world.day += 1;
    }
  }

  /*
   * 2. player. On foot the movement controller does all of it; seated, the
   * shell owns the car (throttle/steer/handbrake from the same move vector)
   * and updatePlayer only re-glues the body to the car and ticks timers.
   */
  function stepPlayer(dt) {
    const player = world.player;
    if (!player) return;

    const car = player.car;
    if (!car) {
      updatePlayer(player, city, input, dt);
      return;
    }

    const moveInput = input.move();
    const throttle = clamp(-(Number.isFinite(moveInput?.y) ? moveInput.y : 0), -1, 1);
    const steer = clamp(Number.isFinite(moveInput?.x) ? moveInput.x : 0, -1, 1);
    const handbrake = input.down('Space');

    /* Sand past the promenade is loose; the tyres lose their bite there. */
    const sandLine = city.shoreline - (city.beach?.w ?? CITY.beachWidth);
    car.gripMod = car.x > sandLine ? VEHICLE.gripSand : 1;

    driveCar(car, throttle, steer, handbrake, dt);
    const impact = moveCar(car, city, dt);
    const speed = Math.abs(car.speed ?? 0);

    if (isHardImpact(impact) && speed > 60) {
      damageCar(car, clamp(impact * 26 + speed * 0.06, 1, 34));
      renderer.nudgeShake(Math.min(2.2, impact * 2.4));
      playPunch(audio, { volume: 0.55 });
      if (speed > 110) world.police?.crime('propertyDamage');
    }

    updatePlayer(player, city, input, dt);
  }

  /*
   * 3. vehicles. Finishes a hotwire, charges pedestrians the player's bumper
   * hits, and reports a wreck once. Ambient traffic lives in traffic.js and
   * is stepped separately (phase 4).
   */
  function stepVehicles(dt) {
    const player = world.player;
    if (!player) return;

    if (game.hotwire) {
      const target = game.hotwire;
      const aside = player.car ? null : target;
      const gap = aside ? Math.hypot(aside.x - player.x, aside.y - player.y) : 0;

      /*
       * A hotwire is a standing job: it only advances while the player is on
       * foot, awake, and still at the door. Walking away (or being knocked
       * down) abandons it — without this the lock would finish itself from
       * across the district and teleport the player into the seat.
       */
      if (player.car || player.down || gap > HOTWIRE_LEASH) {
        game.hotwireGrace += dt;
        if (game.hotwireGrace >= HOTWIRE_LEASH_GRACE) {
          target.hotwiring = false;
          target.hotwireT = 0;
          game.hotwire = null;
          game.hotwireLeft = 0;
          game.hotwireGrace = 0;
          hud.say('You left the lock — hotwire abandoned.', 2.2, 'bad');
        }
      } else {
        game.hotwireGrace = 0;
        const secondsLeft = tickHotwire(target, player, dt);
        game.hotwireLeft = secondsLeft;

        if (secondsLeft <= 0) {
          game.hotwire = null;
          game.hotwireLeft = 0;
          game.hotwireGrace = 0;
          /*
           * tickHotwire()'s finishSteal() already flags the car occupied and
           * stolen, but it does not seat the actor. enterCar() refuses an
           * occupied body, so the flag is cleared first and the normal,
           * timer-safe path takes the seat.
           */
          target.occupied = false;
          if (enterCar(player, target)) {
            detachFromTraffic(target);
            playPickup(audio);
            hud.say(`Hotwired the ${target.label ?? 'car'}.`, 2.4, 'good');
            world.police?.crime('stealCar');
          } else {
            /* A wreck or a body that moved can refuse the seat; say so rather
             * than leaving the player believing they own the car. */
            target.occupied = false;
            hud.say('The lock opened but the seat would not take.', 2.4, 'bad');
          }
        }
      }
    }

    const car = player.car;
    if (!car) return;

    /* Bumper meets pedestrian: one knock per body, one crime per knock. */
    if (Math.abs(car.speed ?? 0) > 45 && typeof world.pedestrians?.knockAt === 'function') {
      const fx = Math.cos(car.angle ?? 0);
      const fy = Math.sin(car.angle ?? 0);
      const hit = world.pedestrians.knockAt(car.x + fx * 22, car.y + fy * 22, 30);
      if (hit) {
        world.police?.crime('hitPed');
        playPunch(audio, { volume: 0.8 });
        renderer.nudgeShake(0.9);
        hud.say('You just hit a civilian.', 2.6, 'bad');
        setStatus('Hit and run — the police are listening on the radio.');
      }
    }

    /* A burning wreck is not a vehicle any more; say so exactly once. */
    if (car.wrecked && !car.__wreckSeen) {
      car.__wreckSeen = true;
      hud.say('The car is done. Get out.', 3, 'bad');
    }
  }

  /* 4. ambient traffic. */
  function stepTraffic(dt) {
    world.traffic?.update(dt, world);
  }

  /* 5. the crowd. */
  function stepPedestrians(dt) {
    world.pedestrians?.update(dt, world);
  }

  /*
   * 6. police.
   *
   * There is no updatePolice() export: the pursuit advances through the api
   * object createPolice() returned, and that same call is what re-syncs
   * world.heat / world.wanted / world.wantedLevel / world.busted / world.wasted
   * — which is why this phase runs before combat (combat reads world.heat).
   *
   * police.js only rolls backup onto the street while one of its own units
   * has eyes on the player, which keeps patrols from teleporting in. That
   * also means the first crime could never summon anything: with no units out
   * there, nobody can see the player. So when a level is live, the street is
   * empty and the outcome is still clear, the shell asks for one unit.
   */
  function stepPolice(dt) {
    const police = world.police;
    if (!police) return;

    police.update(dt, world);

    const level = police.level ?? 0;
    if (level > 0 && (police.cars?.length ?? 0) === 0 && police.outcome === OUTCOME_CLEAR) {
      police.spawn();
    }
  }

  /* 7. combat: travelling punches, kicks, pipe swings, bullets, reloads. */
  function stepCombat(dt) {
    const combat = world.combat;
    if (!combat) return;

    /*
     * updateCombat() is what combat.update() calls internally; naming it here
     * keeps the phase list in this file explicit and importable. It reads
     * world.heat for officer aggression, so phase 6 must already have run.
     */
    updateCombat(combat, world, dt);
  }

  /*
   * 8. missions: job state, then the two fields hud.js reads off the world
   * (objective and the side-job card).
   */
  function stepMissions(dt) {
    const events = updateMissions(game.missions, world, dt);
    syncSideJob();
    if (!Array.isArray(events) || events.length === 0) return;

    for (const ev of events) {
      if (!ev) continue;
      switch (ev.type) {
        case 'start':
          hud.say(`JOB — ${ev.name} · ${formatMoney(ev.payout ?? 0)}`, 4.5, 'tip');
          setStatus(`${ev.name}: ${ev.text ?? 'head for the marker'}`);
          break;
        case 'say':
          /* Briefing lines: missions.js emits one per speaker. */
          if (ev.text) hud.say(`${ev.speaker ?? 'Solmar'}: ${ev.text}`, 4.2, 'info');
          break;
        case 'alarm':
          world.police?.crime('missionAlarm');
          hud.say('The job tripped an alarm.', 3, 'wanted');
          break;
        case 'step':
          if (ev.text) hud.say(ev.text, 4, 'info');
          break;
        case 'complete':
          playMissionComplete(audio);
          hud.say(`JOB DONE — ${formatMoney(ev.payout ?? 0)}`, 5, 'cash');
          setStatus(`Job complete. ${formatMoney(world.player?.money ?? 0)} in the wallet.`);
          break;
        case 'fail':
          hud.say(`JOB FAILED${ev.reason ? ` — ${ev.reason}` : ''}`, 4, 'bad');
          setStatus('Job failed. Another one will come around.');
          break;
        default:
          break;
      }
    }
  }

  /*
   * Mirror the free-roam objective onto world.sideJob, which is the field
   * hud.js's drawSideJob() card reads first. Story jobs leave it null so the
   * side card stays "None active" while the main tracker shows the arc.
   *
   * Rush Parcel gets its own announcement because it is the one free job on
   * a clock; the toast carries the limiter so the player knows instantly.
   */
  function syncSideJob() {
    const obj = world.objective;
    if (!obj || obj.free !== true) {
      if (world.sideJob) world.sideJob = null;
      game.sideKey = null;
      return;
    }

    const rush = /rush parcel/i.test(String(obj.title ?? ''));
    world.sideJob = {
      name: obj.title ?? 'Side job',
      detail: obj.detail ?? '',
      reward: Number.isFinite(obj.pay) ? obj.pay : null,
      progress: Number.isFinite(obj.progress) ? obj.progress : null,
      step: Number.isFinite(obj.step) ? obj.step : null,
      steps: Number.isFinite(obj.steps) ? obj.steps : null,
      x: Number.isFinite(obj.x) ? obj.x : null,
      y: Number.isFinite(obj.y) ? obj.y : null,
      timed: obj.timed === true || rush,
      timeLeft: Number.isFinite(obj.timeLeft) ? obj.timeLeft : null,
      rush,
    };

    const key = `${obj.title ?? 'side'}#${obj.step ?? 0}#${rush ? 'rush' : 'free'}`;
    if (key === game.sideKey) return;
    game.sideKey = key;

    if (rush) {
      hud.say('RUSH PARCEL — the clock is already running.', 4, 'wanted');
      setStatus('Rush Parcel: grab it, then beat the clock across town.');
    } else {
      hud.say(`Side job — ${obj.title ?? 'gig'} · ${formatMoney(obj.pay ?? 0)}`, 3.6, 'tip');
    }
  }

  /* The continuous audio voices read one snapshot per step. */
  function audioSnapshot() {
    const player = world.player;
    const car = player?.car ?? null;
    const speed = car ? Math.abs(car.speed ?? 0) : Math.hypot(player?.vx ?? 0, player?.vy ?? 0);
    const profile = car ? carProfile(car) : null;
    const moveInput = car ? input.move() : null;
    const level = world.police?.level ?? 0;

    return {
      speed,
      maxSpeed: profile?.maxSpeed ?? VEHICLE.maxSpeed,
      throttle: car ? clamp(-(moveInput?.y ?? 0), 0, 1) : 0,
      drifting: car?.drifting === true,
      slip: clamp(Math.abs(car?.slip ?? 0) / 120, 0, 1),
      wanted: world.wanted ?? 0,
      siren: level >= 2,
      chase: level >= 2 || (world.wanted ?? 0) >= 2,
      paused: false,
    };
  }

  /*
   * 9. audio.
   *
   * The one-shot voices are event driven, but a *rise* in the wanted level
   * has to be caught here: playSiren() blips the roof horn and the chase
   * theme swaps in, then updateAudio() keeps the continuous siren voice and
   * the music scheduler in step with the snapshot.
   */
  function stepAudio(dt) {
    const level = world.police?.level ?? 0;

    if (level > game.sirenLevel) {
      playSiren(audio, { volume: 0.55 });
      setMusicTrackById(audio, TRACK_CHASE);
      if (level > 0) hud.say(`Wanted ${level}/5 — units are answering.`, 3, 'wanted');
    } else if (level === 0 && game.sirenLevel > 0) {
      setMusicTrackById(audio, TRACK_CRUISE);
      hud.say('Heat is off. Back to the cruise.', 2.4, 'good');
    }
    game.sirenLevel = level;

    updateAudio(audio, audioSnapshot(), dt);
  }

  /*
   * One fixed step of simulation, always exactly STEP seconds, in the order
   * documented at the top of the file. Called from advanceSimulation() and
   * from the deterministic ?shot= builders.
   */
  function step(dt) {
    const stepDt = Number.isFinite(dt) && dt > 0 ? dt : STEP;

    world.time += stepDt;
    advanceClock(stepDt);

    stepInput();                    // 1. input — drain the action mask
    if (game.screen !== 'play') return;   // a step may pause or end the run

    stepPlayer(stepDt);             // 2. player (drives the player's car too)
    stepVehicles(stepDt);           // 3. vehicles — hotwire, impacts, wrecks
    stepTraffic(stepDt);            // 4. ambient traffic
    stepPedestrians(stepDt);        // 5. crowd
    stepPolice(stepDt);             // 6. pursuit first: it owns world.heat
    stepCombat(stepDt);             // 7. bullets, kicks, pipe swings, reloads
    stepMissions(stepDt);           // 8. jobs, objective + sideJob mirror
    stepAudio(stepDt);              // 9. engine, siren, chase theme

    checkOutcome();

    /*
     * Autosave on the config interval, but never after checkOutcome() just
     * ended the run: a save of a wasted body would be the next load's start.
     */
    if (SAVE.autosave > 0 && game.screen === 'play') {
      game.saveT += stepDt;
      if (game.saveT >= SAVE.autosave) {
        game.saveT = 0;
        autosave();
      }
    }
  }

  function checkOutcome() {
    if (game.screen !== 'play') return;
    if (world.busted === true) { enterOver('busted'); return; }
    if (world.wasted === true || world.player?.down === true) enterOver('wasted');
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                            */
  /* ------------------------------------------------------------------ */

  function nearestStealable() {
    const player = world.player;
    if (!player) return null;

    const candidates = [];
    if (Array.isArray(world.parked)) for (const c of world.parked) candidates.push(c);
    if (Array.isArray(world.traffic?.list)) for (const c of world.traffic.list) candidates.push(c);
    return nearestCar(candidates, player.x, player.y, PLAYER.interactRange + 34);
  }

  /* A car taken off the road becomes part of the parked fleet, so it stays
   * simulated and drawn where the player leaves it. */
  function detachFromTraffic(car) {
    const list = world.traffic?.list;
    if (Array.isArray(list)) {
      const i = list.indexOf(car);
      if (i >= 0) list.splice(i, 1);
    }
    if (!world.parked.includes(car)) world.parked.push(car);
  }

  function handleInteract() {
    const player = world.player;
    if (!player || player.down) return;

    if (player.car) {
      if (leaveCar(player, city)) {
        playClick(audio);
        hud.say('Out of the car.', 1.6, 'info');
      }
      return;
    }

    if (game.hotwire) {
      hud.say('Still working the lock…', 1.4, 'tip');
      return;
    }

    const car = nearestStealable();
    if (!car) {
      hud.say('No car within reach.', 1.6, 'info');
      return;
    }

    const check = canStealCar(car, player);
    if (check.ok) {
      if (enterCar(player, car)) {
        detachFromTraffic(car);
        playClick(audio);
        hud.say(`You are in the ${car.label ?? 'car'}.`, 2, 'info');
      }
      return;
    }

    switch (check.reason) {
      case 'locked': {
        const res = stealCar(car, player);
        if (res && res.ok === false && res.reason === 'hotwiring') {
          game.hotwire = car;
          game.hotwireLeft = res.hotwireTime ?? 0;
          game.hotwireGrace = 0;
          playClick(audio);
          hud.say('Locked — hotwiring. Stay put.', 2.6, 'tip');
          world.police?.crime('stealCar', res.heat ?? 6);
        }
        break;
      }
      case 'wrecked':
        hud.say('That one is a wreck.', 2, 'bad');
        break;
      case 'far':
        hud.say('Too far from the door.', 1.8, 'info');
        break;
      case 'hotwiring':
        hud.say('Someone is already at it.', 1.8, 'tip');
        break;
      case 'seated':
        hud.say('You are already driving.', 1.6, 'info');
        break;
      default:
        hud.say('You cannot take that car.', 1.8, 'bad');
        break;
    }
  }

  function doAttack() {
    const player = world.player;
    if (!player || player.car || player.down) return false;
    const combat = world.combat;
    if (!combat) return false;

    if (player.weapon === 'pistol') {
      const fired = combat.shoot(player);
      if (fired) playShot(audio);
      return fired;
    }
    const swung = combat.punch(player);
    if (swung) playPunch(audio);
    return swung;
  }

  /*
   * Q. input.js raises ACT_WEAPON *and* ACT_KICK for the same key, so the
   * shell has to decide which one the press meant. The rule: fists out and a
   * kick is actually possible -> kick. Fists out but winded / on cooldown ->
   * say why, still no weapon swap (the player asked to kick). Anything else
   * (pistol out, seated, down) -> fall through to the weapon cycle.
   *
   * Returns 'kicked' | 'blocked' | 'no', so stepInput() can gate cycleWeapon()
   * on the outcome instead of double-firing both actions.
   */
  function tryKick() {
    const player = world.player;
    if (!player || player.car || player.down) return 'no';
    const combat = world.combat;
    if (!combat || typeof combat.kick !== 'function') return 'no';
    if (player.weapon !== 'fist') return 'no';

    const cost = combat.tuning?.kickStamina ?? 13;
    if ((player.stamina ?? 0) < cost) {
      hud.say('Too winded to kick — let the stamina come back.', 2.2, 'bad');
      return 'blocked';
    }
    if ((combat.kickT ?? 0) > 0) return 'blocked';

    if (combat.kick(player)) {
      playPunch(audio, { volume: 0.7 });
      return 'kicked';
    }
    return 'blocked';
  }

  /* Public form for the debug surface / tests. */
  function doKick() {
    return tryKick() === 'kicked';
  }

  /* F. swingBlunt() falls through to a punch when the hands are empty, so the
   * prompt points at the pipe pickup instead of failing silently. */
  function doBlunt() {
    const player = world.player;
    if (!player || player.car || player.down) return false;
    const combat = world.combat;
    if (!combat || typeof combat.swingBlunt !== 'function') return false;

    if (player.weapon === 'pistol') {
      hud.say('Pistol out — holster it to swing a pipe.', 2.2, 'tip');
      return false;
    }

    const held = (player.meleeHits ?? 0) > 0;
    const swung = combat.swingBlunt(player);
    if (swung) playPunch(audio, { volume: held ? 0.85 : 0.5 });
    if (!held && swung) hud.say('Nothing in hand — a pipe is across the kerb.', 2.6, 'tip');
    return swung;
  }

  /* R. combat.reload() refuses quietly; the shell explains which rule bit. */
  function doReload() {
    const player = world.player;
    if (!player || player.car || player.down) return false;
    const combat = world.combat;
    if (!combat || typeof combat.reload !== 'function') return false;

    if (player.weapon !== 'pistol') {
      hud.say('Nothing to reload.', 1.6, 'info');
      return false;
    }
    const mag = combat.tuning?.pistolAmmo ?? 12;
    if ((player.ammo ?? 0) >= mag) {
      hud.say('Magazine is full.', 1.6, 'info');
      return false;
    }
    if ((player.ammoReserve ?? 0) <= 0) {
      hud.say('No spare rounds.', 1.8, 'bad');
      return false;
    }
    if (!combat.reload(player)) {
      hud.say('Already reloading.', 1.4, 'tip');
      return false;
    }
    hud.say('Reloading…', 1.2, 'info');
    playClick(audio, { low: true });
    return true;
  }

  function cycleWeapon() {
    const player = world.player;
    if (!player || player.car) return;

    if (player.weapon === 'pistol') {
      player.weapon = 'fist';
      hud.say('Fists up — Q kicks, F swings.', 2.2, 'info');
    } else if ((player.ammo ?? 0) > 0 || (player.ammoReserve ?? 0) > 0) {
      player.weapon = 'pistol';
      hud.say('Sidearm out — J to fire, R to reload.', 2.6, 'tip');
    } else {
      hud.say('No sidearm — there is a pistol near the spawn.', 2.8, 'tip');
    }
    playClick(audio);
  }

  function honk() {
    if (world.player?.car) playSiren(audio, { volume: 0.45 });
    else playClick(audio);
  }

  function toggleMute() {
    setMuted(audio, !audio.userMuted);
    world.mute = audio.userMuted === true;
    hud.say(world.mute ? 'Audio muted.' : 'Audio on.', 1.8, 'info');
    return world.mute;
  }

  /* G. take the next job on demand; updateMissions() also does this on its
   * own cooldown, but a fresh run opens on the title with no marker at all
   * and the player should not have to wait for the scheduler. */
  function nextJob() {
    if (!game.missions) return null;
    if (game.missions.current) {
      hud.say(`Already on ${game.missions.current.name}.`, 2, 'info');
      return game.missions.current;
    }
    const mission = startNextMission(game.missions, world);
    syncSideJob();
    if (!mission) hud.say('No job available yet — try again in a moment.', 2.2, 'info');
    return mission;
  }

  /* Called whenever a run is (re)staged, so play always opens on a marker. */
  function ensureMission() {
    if (!game.missions) return;
    if (game.missions.current) return;
    /* Drop events left over from the previous run before starting a new one. */
    if (Array.isArray(game.missions.events)) game.missions.events.length = 0;
    startNextMission(game.missions, world);
    syncSideJob();
  }

  const ACTIONS = [
    ACT_CONFIRM, ACT_PAUSE, ACT_INTERACT, ACT_SAVE, ACT_LOAD, ACT_ATTACK,
    ACT_WEAPON, ACT_CANCEL, ACT_RELOAD, ACT_MAP, ACT_HORN, ACT_KICK, ACT_BLUNT,
  ];

  /*
   * 1. input. Drains the action mask once per step and dispatches it. The
   * same entry point also runs from the frame loop while a menu screen is up,
   * because no step executes there.
   */
  function stepInput() {
    const mask = input.take();
    if (!mask) return;

    /* --- menus ---------------------------------------------------- */
    if (game.screen !== 'play') {
      if (mask & ACT_CONFIRM) {
        if (game.screen === 'paused') resumeGame();
        else if (game.screen === 'over') restartRun();
        else startRun();
      }
      if ((mask & ACT_PAUSE) && game.screen === 'paused') resumeGame();
      if ((mask & ACT_SAVE) && game.screen === 'paused') doSave(game.slot);
      if (mask & ACT_LOAD) doLoad(game.slot);
      return;
    }

    /* --- in play -------------------------------------------------- */
    if (mask & ACT_PAUSE) { pauseGame(); return; }

    /* Q raises both bits: a kick that lands (or is refused on purpose) uses
     * the press up, so the weapon does not cycle out from under the player. */
    const kick = (mask & ACT_KICK) ? tryKick() : 'no';
    const kickUsedPress = kick !== 'no';

    if (mask & ACT_INTERACT) handleInteract();
    if (mask & ACT_ATTACK) doAttack();
    if ((mask & ACT_WEAPON) && !kickUsedPress) cycleWeapon();
    if (mask & ACT_BLUNT) doBlunt();
    if (mask & ACT_RELOAD) doReload();
    if (mask & ACT_SAVE) doSave(game.slot);
    if (mask & ACT_LOAD) doLoad(game.slot);
    if ((mask & ACT_CANCEL) && !kickUsedPress) toggleMute();
    if (mask & ACT_MAP) {
      game.mapOpen = !game.mapOpen;
      setStatus(game.mapOpen ? 'City map — M to go back.' : 'Back to the street.');
    }
    if (mask & ACT_HORN) honk();
  }

  /* ------------------------------------------------------------------ */
  /* screens                                                            */
  /* ------------------------------------------------------------------ */

  /*
   * HUD ownership.
   *
   * index.html ships a DOM #hud (cash / clock / district / objective / speed /
   * note) and hud.js paints a complete canvas HUD in the same corners. Both
   * would stack the same numbers twice, so the DOM block is hidden and
   * hud.js owns the frame. It is only re-shown when hud.js is missing
   * drawGame, so the page still degrades to something readable.
   */
  function claimHud() {
    if (!dom.hud) return;
    const keepDom = !hud || typeof hud.drawGame !== 'function';
    dom.hud.hidden = !keepDom;
    dom.hud.setAttribute('aria-hidden', keepDom ? 'false' : 'true');
  }

  function hideOverlays() {
    suppressMenu();
    if (dom.loading) {
      dom.loading.hidden = true;
      dom.loading.classList.add('fading');
    }
    claimHud();
    if (typeof canvas.focus === 'function') canvas.focus();
  }

  /*
   * index.html's inline script runs the loading bar and then reveals #menu on
   * its own timer. When a run starts before that timer fires — autostart,
   * ?shot=, or a fast Enter — the menu would pop back up over a live game.
   * Staying hidden while menuSuppressed is set wins that race in both
   * directions; pausing clears the flag so the pause menu can show normally.
   */
  function suppressMenu() {
    menuSuppressed = true;
    applyMenuHidden();
  }

  function applyMenuHidden() {
    const menu = dom.menu;
    if (!menu || !menuSuppressed) return;
    menu.classList.add('fading');
    menu.hidden = true;
  }

  function showMenuDom() {
    menuSuppressed = false;
    if (!dom.menu) return;
    dom.menu.hidden = false;
    dom.menu.classList.remove('fading');
  }

  function setStatus(text) {
    if (dom.status) dom.status.textContent = String(text ?? '');
  }

  /*
   * #status is a fixed bar along the bottom edge and hud.js draws its own hint
   * strip and toasts there, so in play the two overlap and clip. The DOM bar
   * is kept in the accessibility tree but taken out of the layout; at the
   * title screen it is the only narration, so it goes back to normal.
   */
  function placeStatus(inPlay) {
    const el = dom.status;
    if (!el) return;

    if (inPlay) {
      el.style.position = 'absolute';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.overflow = 'hidden';
      el.style.clipPath = 'inset(50%)';
      el.style.whiteSpace = 'normal';
    } else {
      el.style.position = '';
      el.style.width = '';
      el.style.height = '';
      el.style.overflow = '';
      el.style.clipPath = '';
      el.style.whiteSpace = '';
    }
  }

  function startRun() {
    if (game.screen === 'play') return;
    if (game.screen === 'over') buildActors();

    game.screen = 'play';
    game.outcome = null;
    game.mapOpen = false;
    game.acc = 0;
    game.last = performance.now();
    game.fade = FADE_IN;

    hideOverlays();
    input.clear();
    hud.clearMessages();
    ensureMission();
    hud.say('Solmar. Find a car, keep the afternoon going.', 4, 'info');
    setStatus('WASD move · Shift run · Space handbrake · E car · J strike · Q kick · F pipe · R reload · G job · Esc pauses.');
  }

  function pauseGame() {
    if (game.screen !== 'play') return;

    game.screen = 'paused';
    game.acc = 0;
    input.clear();
    showMenuDom();
    setStatus(`Paused — Enter resumes, F5 saves slot ${game.slot}, F9 loads it, 4/5/6 pick a slot.`);
    autosave();
  }

  function resumeGame() {
    if (game.screen !== 'paused') return;

    game.screen = 'play';
    game.acc = 0;
    game.last = performance.now();
    input.clear();

    if (dom.menu) {
      const menu = dom.menu;
      menu.classList.add('fading');
      setTimeout(() => { menu.hidden = true; }, 260);
    }
    setStatus('Back on the street.');
  }

  function enterOver(kind) {
    if (game.screen === 'over') return;

    game.screen = 'over';
    game.outcome = kind === 'busted' ? 'busted' : 'wasted';
    game.acc = 0;
    game.fade = 0;
    input.clear();
    game.hotwire = null;
    game.hotwireLeft = 0;

    if (game.outcome === 'busted') {
      setStatus('Busted. Enter to start again.');
      hud.say('Busted — the city keeps your licence plate.', 5, 'bad');
      playClick(audio);
    } else {
      setStatus('Wasted. Enter to start again.');
      hud.say('Wasted — the afternoon is over.', 5, 'bad');
      playPunch(audio, { volume: 0.9 });
    }
  }

  function restartRun() {
    buildActors();

    game.screen = 'play';
    game.outcome = null;
    game.mapOpen = false;
    game.acc = 0;
    game.last = performance.now();
    game.fade = FADE_IN;

    input.clear();
    hud.clearMessages();
    hideOverlays();
    ensureMission();
    hud.say('A new afternoon. Same city.', 3, 'info');
    setStatus('Fresh start — WASD to move, E for a car.');
  }

  /* ------------------------------------------------------------------ */
  /* persistence — three slots, all through save.js                     */
  /* ------------------------------------------------------------------ */

  function clampSlot(id) {
    const n = Math.round(Number(id));
    return SLOTS.includes(n) ? n : SLOTS[0];
  }

  function slotLabel() {
    return `slot ${game.slot}/${SLOTS.length}`;
  }

  /* Pick which slot F5/F9 (and the paused menu) use. */
  function chooseSlot(id) {
    if (id === undefined || id === null) return game.slot;
    const slot = clampSlot(id);
    const marked = setActiveSlot(slot);
    game.slot = slot;

    const info = inspectSaveFrom(slot);
    const state = info?.state ?? 'missing';
    const stamp = state === 'ok' ? 'has a save' : state === 'missing' ? 'is empty' : state;
    const message = `${slotLabel()} — ${stamp}.`;
    hud.say(marked ? message : `${message} (the active marker did not stick)`, 2.6,
      state === 'ok' ? 'good' : 'info');
    setStatus(`Save ${slotLabel()} selected — F5 saves, F9 loads.`);
    return slot;
  }

  function slotSummary() {
    const rows = listSlots();
    if (!Array.isArray(rows) || rows.length === 0) return 'no slot data';
    return rows
      .map((row) => {
        const mark = row.id === game.slot ? '*' : '';
        if (!row.exists) return `${row.id}${mark} empty`;
        const money = Number.isFinite(row.player?.money) ? ` ${formatMoney(row.player.money)}` : '';
        const when = Number.isFinite(row.savedAt)
          ? new Date(row.savedAt).toISOString().slice(0, 16).replace('T', ' ')
          : 'undated';
        return `${row.id}${mark}${money} ${when}`.trim();
      })
      .join(' · ');
  }

  function snapshot() {
    const player = world.player ?? {};
    const missions = game.missions;
    return {
      player: {
        x: player.x ?? city.spawn.x,
        y: player.y ?? city.spawn.y,
        facing: player.facing ?? 0,
        health: player.health ?? player.maxHealth ?? 100,
        maxHealth: player.maxHealth ?? 100,
        money: player.money ?? 0,
        weapon: player.weapon ?? 'fist',
        ammo: player.ammo ?? 0,
        ammoReserve: player.ammoReserve ?? 0,
        stamina: player.stamina ?? 100,
      },
      clock: world.clock,
      day: world.day,
      heat: world.heat ?? 0,
      wanted: world.wanted ?? 0,
      jobsDone: missions?.jobsDone ?? 0,
      storyIndex: missions?.storyIndex ?? 0,
      mode: missions?.mode ?? 'story',
      difficulty: diff.name,
      seed: city.seed,
      earned: missions?.earned ?? 0,
      /* v3 metadata: the slot card in listSlots() reads both fields. */
      meta: {
        name: `${diff.label} · ${slotLabel()}`,
        playtime: Math.max(0, Math.round(world.time)),
      },
    };
  }

  function doSave(slotId = game.slot, quiet = false) {
    if (!world.player) return false;

    const slot = clampSlot(slotId);
    /* Keep the slot the player picked as the one autosave will use too. */
    setActiveSlot(slot);
    game.slot = slot;

    const ok = writeSaveTo(slot, snapshot());
    world.saveStatus = ok ? 'saved' : 'failed';
    game.saveT = 0;

    if (!quiet) {
      hud.say(ok ? `Game saved — ${slotLabel()}.` : 'Save failed — local storage is unavailable or full.',
        2.6, ok ? 'good' : 'bad');
      setStatus(ok ? `Saved to ${slotLabel()}.` : 'Could not save (storage blocked, full, or payload too big).');
      playClick(audio);
    }
    return ok;
  }

  function autosave() {
    if (!world.player) return;
    const ok = writeSaveTo(game.slot, snapshot());
    if (ok) world.saveStatus = 'auto';
    game.saveT = 0;
  }

  function applySave(data, slot = game.slot) {
    if (!data || !data.player) return false;

    buildActors();
    const player = world.player;
    const src = data.player;

    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

    player.x = num(src.x, player.x);
    player.y = num(src.y, player.y);
    player.facing = num(src.facing, player.facing);
    player.maxHealth = num(src.maxHealth, player.maxHealth);
    player.health = clamp(num(src.health, player.maxHealth), 1, player.maxHealth);
    player.money = Math.max(0, num(src.money, 0));
    player.weapon = src.weapon === 'pistol' ? 'pistol' : 'fist';
    player.ammo = Math.max(0, num(src.ammo, 0));
    player.ammoReserve = Math.max(0, num(src.ammoReserve, 0));
    player.stamina = clamp(num(src.stamina, player.stamina), 0, player.staminaMax);
    player.car = null;
    player.down = false;

    world.clock = num(data.clock, CLOCK_START);
    world.day = Math.max(1, Math.round(num(data.day, 1)));

    /* police.js owns heat; clear first so no stale unit survives the load. */
    world.police?.clear(world);
    world.police?.setHeat(clamp(num(data.heat, 0), 0, 100));

    if (game.missions) {
      game.missions.jobsDone = Math.max(0, Math.round(Number(data.jobsDone) || 0));
      game.missions.storyIndex = clamp(Math.round(Number(data.storyIndex) || 0), 0, STORY_LENGTH);
      game.missions.mode = data.mode === 'free' ? 'free' : 'story';
      game.missions.earned = Math.max(0, Number(data.earned) || 0);
      game.missions.current = null;
      game.missions.cooldownT = 0;
      ensureMission();
    }

    game.slot = clampSlot(slot);
    setActiveSlot(game.slot);
    game.sirenLevel = world.police?.level ?? 0;
    world.saveStatus = 'loaded';
    game.screen = 'play';
    game.outcome = null;
    game.mapOpen = false;
    game.acc = 0;
    game.last = performance.now();
    game.fade = FADE_IN;

    hideOverlays();
    input.clear();
    hud.clearMessages();
    hud.say(`Session restored — ${slotLabel()}.`, 3, 'good');
    setStatus(`Loaded ${slotLabel()} — day ${world.day}, ${formatMoney(player.money)}.`);
    return true;
  }

  function doLoad(slotId = game.slot) {
    const slot = clampSlot(slotId);
    const info = inspectSaveFrom(slot);

    if (!info) {
      hud.say('Local storage is unavailable — nothing to load.', 2.6, 'bad');
      setStatus('Load failed: storage unavailable.');
      return false;
    }
    if (info.state === 'missing') {
      hud.say(`${slotLabel()} is empty.`, 2.2, 'info');
      setStatus(`No save in ${slotLabel()}.`);
      return false;
    }
    if (info.state === 'future' || info.state === 'corrupt') {
      hud.say(`${slotLabel()} cannot be read (${info.state}).`, 2.8, 'bad');
      setStatus(`Load failed: ${info.reason ?? info.state}.`);
      return false;
    }

    const data = info.data ?? readSaveFrom(slot);
    if (!data) {
      hud.say(`That save could not be read.`, 2.4, 'bad');
      return false;
    }

    const ok = applySave(data, slot);
    if (!ok) hud.say('That save could not be read.', 2.4, 'bad');
    playClick(audio);
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* presentation                                                       */
  /* ------------------------------------------------------------------ */

  /* What hud.js prints in its E-key prompt, or null when there is nothing. */
  function interactPrompt() {
    const player = world.player;
    if (!player || game.screen !== 'play') return null;
    if (player.car) return { label: `Leave the ${player.car.label ?? 'car'}` };
    if (game.hotwire) return { label: `Hotwiring… ${Math.max(0, game.hotwireLeft).toFixed(1)}s` };

    const car = nearestStealable();
    if (!car) return null;
    const verb = car.locked ? 'Hotwire' : 'Get in';
    return { label: `${verb} the ${car.label ?? 'car'}` };
  }

  function missionMarker() {
    if (!game.missions) return null;
    try {
      return marker(game.missions, world);
    } catch {
      return null;
    }
  }

  /*
   * The DOM readouts are a fallback surface, written at most every
   * DOM_SYNC_EVERY seconds. claimHud() hides them in normal play, but they
   * are kept correct so the page still reads if hud.js cannot draw.
   */
  function syncDom() {
    const player = world.player;
    if (!player) return;

    setText(dom.cash, formatMoney(player.money ?? 0));
    setText(dom.clock, `DAY ${world.day} · ${formatClock(world.clock)}`);

    const key = typeof city.districtOf === 'function' ? city.districtOf(player.x, player.y) : null;
    const district = key ? city.districts?.[key]?.name : null;
    setText(dom.area, district ?? 'Solmar');

    const obj = world.objective;
    setText(dom.objective, obj
      ? `${obj.title} — ${obj.detail || 'head for the marker'}`
      : 'Free roam — follow the coast, take what you need.');

    const car = player.car;
    const kmh = Math.round((car ? Math.abs(car.speed ?? 0) : Math.hypot(player.vx ?? 0, player.vy ?? 0)) / SPEED_SCALE);
    setHtml(dom.speed, `${kmh} <small>km/h</small>`);

    let note = 'On foot';
    if (car) {
      const units = world.police?.cars?.length ?? 0;
      note = `${car.label ?? 'Car'}${units ? ` · police ${units}` : ''}`;
    } else if (game.hotwire) {
      note = 'Hotwiring';
    } else if ((world.wanted ?? 0) >= 1) {
      note = `Wanted ${Math.round(world.wanted)}/5`;
    } else {
      note = `Slot ${game.slot}`;
    }
    setText(dom.note, note);

    /* DOM side-job mirror (index.html's #hud-side), in case hud.js is absent. */
    const job = world.sideJob;
    if (dom.sideName) setText(dom.sideName, job ? job.name : 'None active');
    if (dom.sideProgress) {
      const pct = job && Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
      setText(dom.sideProgress, !job ? '—'
        : pct !== null ? `${pct}%` : (job.step && job.steps ? `step ${job.step}/${job.steps}` : 'in progress'));
    }
    if (dom.sideReward) {
      setText(dom.sideReward, job && Number.isFinite(job.reward) ? formatMoney(job.reward) : '—');
    }
    if (dom.sideFill) {
      const pct = job && Number.isFinite(job.progress) ? Math.round(job.progress * 100) : 0;
      dom.sideFill.style.width = `${pct}%`;
    }
  }

  /*
   * hud.js's drawOver() is the WASTED card; a busted run draws the same card
   * and gets this plate on top so the two endings stay distinguishable.
   */
  function drawBustedPlate() {
    const w = renderer.view.width;
    const h = renderer.view.height;
    const cx = w / 2;
    const cy = h / 2 - 42;
    const pw = Math.min(320, w * 0.62);

    ctx.save();
    roundRect(ctx, cx - pw / 2, cy - 46, pw, 72, 12);
    ctx.fillStyle = 'rgba(10, 14, 19, 0.94)';
    ctx.fill();
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    const size = Math.round(Math.min(42, Math.max(24, w * 0.04)));
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.red;
    ctx.fillText('BUSTED', cx, cy - 9);
    ctx.restore();
  }

  /*
   * Draw one rendered frame. Called once per animation frame, with the same
   * clamped delta the simulation consumed (0 for a staged ?shot= frame).
   * Nothing here advances the simulation; the renderer only moves its camera
   * and its effect clocks.
   */
  function render(frameDelta) {
    const view = renderer.view;
    const nightAmount = nightOf(world.clock);
    const simTime = world.time;

    if (game.screen === 'title') {
      renderer.drawOverview(world, simTime, nightAmount);
      hud.drawTitle(ctx, view, { time: simTime, hasSave: game.hasSave });
      return;
    }

    if (game.mapOpen && game.screen === 'play') {
      renderer.drawOverview(world, simTime, nightAmount);
      hud.drawGame(ctx, world, interactPrompt());
      return;
    }

    renderer.draw(world, {
      time: simTime,
      night: nightAmount,
      target: world.player,
      driving: !!world.player?.car,
      marker: missionMarker(),
      dt: frameDelta,
      /*
       * hud.js already paints a framed minimap bottom-right, so the renderer's
       * own overlay would be a second map in the same frame. It stays off for
       * the play view and is only reachable through the overview shots above.
       */
      minimap: false,
    });

    if (game.screen === 'play') {
      hud.drawGame(ctx, world, interactPrompt());
    } else if (game.screen === 'paused') {
      hud.drawPause(ctx, view, world);
    } else if (game.screen === 'over') {
      hud.drawOver(ctx, view, world);
      if (game.outcome === 'busted') drawBustedPlate();
    }

    if (game.fade > 0) hud.drawFade(ctx, view, game.fade);
  }

  /* ------------------------------------------------------------------ */
  /* frame loop                                                         */
  /* ------------------------------------------------------------------ */

  let rafId = 0;              // pending requestAnimationFrame handle, 0 = none
  let loopSuspended = false;  // true while the tab is hidden and rAF is parked

  /*
   * Screenshot mode races the page's own loader: index.html reveals #menu on
   * a timer, which would land in the middle of a ?shot= frame. Both overlays
   * are forced closed on every frame while a shot is being taken, whichever
   * shot it is, so the captured frame is the same regardless of loader timing.
   */
  function holdShotLayout() {
    if (!shot) return;
    if (dom.menu) {
      dom.menu.classList.add('fading');
      if (!dom.menu.hidden) dom.menu.hidden = true;
    }
    if (dom.loading && !dom.loading.hidden) dom.loading.hidden = true;
  }

  /*
   * Frame-delta clamp.
   *
   * requestAnimationFrame fires once per visible frame, but the gap between
   * two callbacks is not bounded: a backgrounded tab, a paused debugger or a
   * stalled main thread can stretch it to seconds. Feeding that gap straight
   * into the fixed-step accumulator would queue hundreds of catch-up steps,
   * each costing real milliseconds, so the loop falls further behind on every
   * frame — the classic "spiral of death".
   *
   * The delta is therefore clamped to [0, MAX_FRAME] (config.js, 0.25 s) and
   * the step loop below is capped at MAX_CATCHUP_STEPS iterations. A long
   * stall costs at most MAX_CATCHUP_STEPS * STEP of simulation and the excess
   * is dropped, never carried forward.
   */
  function clampedFrameDelta(nowMs) {
    const stamp = Number.isFinite(nowMs) ? nowMs : performance.now();
    const elapsedSeconds = game.last > 0 ? (stamp - game.last) / 1000 : 0;
    game.last = stamp;
    return clamp(elapsedSeconds, 0, MAX_FRAME);
  }

  /*
   * Hand the clamped delta to the fixed-step loop. At most MAX_CATCHUP_STEPS
   * steps run in one frame; if that budget is spent the frame was starved, so
   * the unspent remainder is discarded instead of being pushed into the next
   * frame, which would then start already over budget.
   */
  function advanceSimulation(frameDelta) {
    game.acc += frameDelta;

    let catchUpSteps = 0;
    while (game.acc >= STEP && catchUpSteps < MAX_CATCHUP_STEPS) {
      step(STEP);
      game.acc -= STEP;
      catchUpSteps += 1;
      if (game.screen !== 'play') break;   // a step paused or ended the run
    }

    if (catchUpSteps >= MAX_CATCHUP_STEPS) game.acc = 0;
  }

  /*
   * Frame-rate presentation work: HUD timers, the fade curtain, the throttled
   * DOM mirror, the title screen's save probe and the idle audio mix. It runs
   * on wall clock, so toasts keep expiring even while a pause freezes the sim.
   */
  function updatePresentation(frameDelta) {
    /* HUD timers run on wall clock so a frozen sim does not freeze toasts. */
    hud.update(frameDelta);
    if (game.fade > 0) game.fade = Math.max(0, game.fade - frameDelta / FADE_IN);

    game.domT += frameDelta;
    if (game.domT >= DOM_SYNC_EVERY) {
      game.domT = 0;
      syncDom();
      /* Re-hide the menu if the page's loader revealed it over a live run. */
      if (menuSuppressed) applyMenuHidden();
      placeStatus(game.screen === 'play');
    }

    if (game.screen === 'title') {
      game.hudCheckT += frameDelta;
      if (game.hudCheckT >= HUD_RECHECK) {
        game.hudCheckT = 0;
        game.hasSave = hasSave();
      }
    }

    if (game.screen !== 'play') updateAudio(audio, IDLE_AUDIO, frameDelta);
  }

  /* Queue the next animation frame, at most one at a time. */
  function scheduleFrame() {
    if (rafId !== 0 || !game.running || loopSuspended) return;
    rafId = window.requestAnimationFrame(frame);
  }

  /*
   * One animation frame: simulate, present, draw. The body keeps the two
   * cadences apart — advanceSimulation() runs fixed steps, then
   * updatePresentation() and render() run exactly once.
   */
  function frame(nowMs) {
    rafId = 0;                     // this callback consumed the pending id
    if (!game.running || loopSuspended) return;
    scheduleFrame();

    const frameDelta = clampedFrameDelta(nowMs);
    game.frames += 1;

    holdShotLayout();

    if (game.shotHeld) {
      /*
       * A staged ?shot= frame is a still: the sim and the HUD timers stay
       * frozen so the capture cannot drift, and the frame is simply redrawn.
       * Without this the loader's own timing decides how many steps ran
       * before the screenshot, and two reloads are never the same picture.
       */
      game.acc = 0;
      render(0);
      return;
    }

    if (game.screen === 'play') {
      advanceSimulation(frameDelta);
    } else {
      game.acc = 0;
      stepInput();                 // menus take input without stepping
    }

    updatePresentation(frameDelta);
    render(frameDelta);
  }

  /*
   * Park the rAF loop while the tab is hidden: cancelling the pending
   * callback beats letting it spin on a paused game in a background tab.
   */
  function suspendLoop() {
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    loopSuspended = true;
  }

  /*
   * Restart the loop when the tab comes back. Time spent hidden is discarded
   * rather than simulated: game.last is re-stamped and the accumulator is
   * emptied, so play resumes where it stopped instead of fast-forwarding
   * through the gap.
   */
  function resumeLoop() {
    if (!loopSuspended) return;
    loopSuspended = false;
    game.last = performance.now();
    game.acc = 0;
    scheduleFrame();
  }

  /* ------------------------------------------------------------------ */
  /* events                                                             */
  /* ------------------------------------------------------------------ */

  window.addEventListener('solmar:start', () => {
    if (game.screen === 'paused') resumeGame();
    else if (game.screen === 'title' || game.screen === 'over') startRun();
  });

  window.addEventListener('solmar:pause', () => {
    if (game.screen === 'play') pauseGame();
  });

  /* Resume and restart are ours: the page's Start button is one-shot. */
  dom.play?.addEventListener('click', () => {
    if (game.screen === 'over') restartRun();
    else if (game.screen === 'paused') resumeGame();
    else if (game.screen === 'title') startRun();
  });

  window.addEventListener('keydown', (event) => {
    const code = event.code;
    if (event.repeat) return;

    if (code === 'F5') {
      event.preventDefault();
      if (game.screen === 'play' || game.screen === 'paused') doSave(game.slot);
      return;
    }
    if (code === 'F9') {
      event.preventDefault();
      doLoad(game.slot);
      return;
    }
    if (code === 'Digit4' || code === 'Digit5' || code === 'Digit6') {
      /* 4/5/6 map onto SLOTS[0..2]; a config with fewer slots ignores the
       * extra keys instead of marking a slot that does not exist. */
      const index = Number(code.slice(-1)) - 4;
      if (index < SLOTS.length) chooseSlot(SLOTS[index]);
      return;
    }
    if (code === 'KeyG') {
      if (game.screen === 'play') nextJob();
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      if (game.screen === 'paused') { event.preventDefault(); resumeGame(); }
      else if (game.screen === 'over') { event.preventDefault(); restartRun(); }
    }
  });

  window.addEventListener('blur', () => {
    if (game.screen === 'play') pauseGame();
  });

  /*
   * Hidden tab: pause the run (as before) and park the frame loop. Visible
   * tab: restart the loop; the run itself stays paused and the player resumes
   * it, exactly like the blur handler above.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.screen === 'play') pauseGame();
      suspendLoop();
      return;
    }
    resumeLoop();
  });

  /* ------------------------------------------------------------------ */
  /* start                                                             */
  /* ------------------------------------------------------------------ */

  /*
   * ?shot= builds a deterministic frame: title, a couple of seconds of
   * driving, or the wasted card at dusk with a few jobs on the clock.
   */
  function enterShotMode() {
    hideOverlays();

    if (shot === 'start') {
      /* Title screen: the canvas title is the whole shot, so no HUD. */
      if (dom.hud) dom.hud.hidden = true;
      game.screen = 'title';
      game.fade = 0;
      setStatus('Solmar — press Enter to start.');
      renderer.snapOverview();
      game.shotHeld = true;
      return;
    }

    startRun();
    game.fade = 0;

    if (shot === 'play') {
      /* Two seconds of simulation so the shot is not frame one. */
      for (let i = 0; i < 120; i += 1) step(STEP);
      game.fade = 0;
      renderer.snapCamera(world.player, !!world.player?.car);
      game.shotHeld = true;
      return;
    }

    if (shot === 'end') {
      for (let i = 0; i < 180; i += 1) step(STEP);
      if (world.player) world.player.money = Math.max(world.player.money, 1450);
      if (game.missions) {
        game.missions.jobsDone = Math.max(game.missions.jobsDone, 3);
        game.missions.earned = Math.max(game.missions.earned, 1450);
      }
      world.clock = 19 * 60 + 40;
      world.police?.wasted();
      enterOver('wasted');
      renderer.snapCamera(world.player, false);
      game.shotHeld = true;
    }
  }

  buildActors();
  game.slot = clampSlot(getActiveSlot());
  game.hasSave = hasSave();
  game.last = performance.now();
  game.running = true;
  scheduleFrame();

  if (shot) {
    /* Defer one tick so the page's own loading screen has painted once. */
    setTimeout(() => {
      game.last = performance.now();
      enterShotMode();
    }, 60);
  } else if (autostart) {
    setTimeout(() => {
      game.last = performance.now();
      startRun();
    }, 60);
  } else {
    setStatus(`Solmar. Press Enter to start. Save ${slotLabel()}.`);
  }

  /*
   * Debug / screenshot surface. `.probe*.cjs` drives the game through this
   * object, and the test hooks move the actor between foot and car exactly
   * the way the E key does, without a keyboard round-trip.
   */
  window.Solmar = {
    world,
    game,
    city,
    renderer,
    hud,
    input,
    audio,
    save: (slot) => doSave(slot ?? game.slot),
    load: (slot) => doLoad(slot ?? game.slot),
    slots: () => listSlots(),
    slotIds: () => SLOTS.slice(),
    setSlot: (slot) => chooseSlot(slot),
    start: () => startRun(),
    pause: () => pauseGame(),
    restart: () => restartRun(),
    job: () => nextJob(),
    kick: () => doKick(),
    blunt: () => doBlunt(),
    reload: () => doReload(),
    actions: ACTIONS,
    debugEnterCar: (car) => enterCar(world.player, car),
    debugLeaveCar: () => leaveCar(world.player, city),
    debugSlots: () => slotSummary(),
  };
}

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
if (isBrowser) boot();
