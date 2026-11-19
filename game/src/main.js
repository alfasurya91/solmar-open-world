// Boot and the single loop. Solmar is generated from a seed, input is polled each frame, the world
// advances in fixed 1/60 s steps and the renderer paints the result. Four screens live here:
// title, play, paused and over. The save slot is reachable from the menu and from play.
//
// Query hooks kept exactly as the screenshot runner expects them:
//   ?autostart=1          skip the title card and drop straight into free roam
//   ?shot=start|play|end  stage one frame, paint it twice, set window.__shotReady
//   ?seed=N               rebuild the city from another seed
//
// This is the only module that knows the whole cast at once: it builds it, turns raw input into
// intent, owns money, clock and screen state, and hands each callback a single job. No pixel is
// drawn here; hud.js and render.js do that.

import { CITY, MAX_FRAME, PLAYER, SAVE, STEP } from './config.js';
import { clamp, createRandom, damp, distance } from './utils.js';
import { createCity } from './city.js';
import { createPlayer, enterCar, leaveCar, updatePlayer } from './player.js';
import { createCar, driveCar, moveCar, nearestCar } from './vehicles.js';
import { createTraffic } from './traffic.js';
import { createPedestrians } from './pedestrians.js';
import { createPolice, addWanted, getWanted, updatePolice } from './police.js';
import { createCombat, punch, shoot, placePistol, resetCombat, canAttack, updateCombat } from './combat.js';
import { createMissions, updateMissions, getObjective, resetMissions, startNextMission } from './missions.js';
import { createAudio, playSfx, updateAudio, startMusic, setEnabled } from './audio.js';
import { createHud } from './hud.js';
import { createRenderer } from './render.js';
import { ACT_CONFIRM, ACT_INTERACT, ACT_LOAD, ACT_PAUSE, ACT_SAVE, createInput } from './input.js';
import { hasSave, readSave, writeSave } from './save.js';

const SCREEN_TITLE = 'title';
const SCREEN_PLAY = 'play';
const SCREEN_PAUSED = 'paused';
const SCREEN_OVER = 'over';

/** Top of the wanted scale, mirrored from police.js: the HUD paints one star per level. */
const MAX_STARS = 5;

/** How close a dropped pistol must be for E to step onto it. */
const PISTOL_REACH = 40;

/** How close the player must be to a car to get in. */
const CAR_REACH = 62;

/** Clock the run opens on, and the length of a day in minutes. */
const OPENING_CLOCK = 9 * 60 + 30;
const DAY_MINUTES = 1440;

/**
 * The input handed to updatePlayer while nobody is behind the wheel on a menu screen: nothing held,
 * no run, no handbrake. The body still coasts to a halt, which is why the player module is stepped
 * on every screen rather than only in play.
 */
const IDLE_INPUT = {
  move: () => ({ x: 0, y: 0 }),
  down: () => false,
  running: () => false,
  take: () => 0,
  clear: () => {},
};

// --- The cast ----------------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const canvas = document.getElementById('game');
const statusLine = document.getElementById('status');

const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : CITY.seed;

const city = createCity(seed);
const rng = createRandom(seed ^ 0x5eed);

const player = createPlayer(city);
const traffic = createTraffic(city, rng);
const pedestrians = createPedestrians(city, rng);

const audio = createAudio();
const hud = createHud();
const renderer = createRenderer(canvas, city);
const input = createInput(canvas);

/** Every car the player can climb into: the ones parked at the kerbs. */
const parkedCars = city.parked.map(
  (spot) => createCar(spot.x, spot.y, spot.angle, spot.color, 'parked'),
);

const police = createPolice(city, rng, {
  onWanted: handleWanted,
  onArrest: handleArrest,
  onToast: handleToast,
  onRam: handleRam,
});

const combat = createCombat(city, rng, {
  onAttack: handleAttack,
  onHit: handleHit,
  playerHurt: handlePlayerHurt,
});

const missions = createMissions(city, rng, {
  onMissionComplete: handleMissionComplete,
  onObjective: handleObjective,
});

/**
 * The world every other module reads. `parked` and `vehicles` are the same list on purpose:
 * combat and the renderer ask for `parked`, the rest of the game talks about vehicles.
 */
const world = {
  city,
  player,
  vehicles: parkedCars,
  parked: parkedCars,
  traffic,
  pedestrians,
  police,
  combat,
  missions,
  audio,
  hud,
  renderer,
  clock: OPENING_CLOCK,
  day: 1,
  wanted: 0,
  objective: null,
  view: renderer.view,
  saveStatus: 'none',
  jobsDone: 0,
  time: 0,
};

/** The nearest moving car to a point within `radius`, or null: panics pedestrians, and hits you. */
world.carsNear = (x, y, radius) => {
  let best = null;
  let bestD = radius * radius;
  const all = traffic.list;

  for (let i = 0; i < all.length; i += 1) {
    const car = all[i];
    const d = (car.x - x) ** 2 + (car.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = car;
    }
  }

  const driven = player.car;
  if (driven) {
    const d = (driven.x - x) ** 2 + (driven.y - y) ** 2;
    if (d < bestD) best = driven;
  }
  return best;
};

/** Combat calls this when the player walks over something worth a line of text. */
world.onPickup = (kind) => {
  if (kind === 'pistol') {
    hud.say('Pistol acquired. C or right-click shoots.', 3);
    playSfx(audio, 'pickup');
  }
};

// --- Callbacks: the seams the modules report through --------------------------------------------

/** Heat moved: a toast for the reason, and the star count the HUD reads off `world`. */
function handleWanted(level, reason, delta) {
  world.wanted = clamp(Math.round(Number.isFinite(level) ? level : 0), 0, MAX_STARS);
  if (reason) hud.say(reason, 2.5);
  if (delta > 0) {
    playSfx(audio, 'siren');
    renderer.nudgeShake(0.18);
  }
}

/** Caught: the run is over, and the arrest sting plays under the WASTED card. */
function handleArrest(data) {
  const count = Number.isFinite(data?.level) ? data.level : 1;
  world.wanted = 0;
  playSfx(audio, 'arrest');
  hud.say(`Busted. That is arrest ${count}.`, 3);
  gameOver();
}

function handleToast(message) {
  hud.say(message, 2);
}

/** A patrol car shunted the player's ride: a shake scaled to the speed that was lost. */
function handleRam(speed) {
  renderer.nudgeShake(Math.min(0.6, (Number.isFinite(speed) ? speed : 0) * 0.002));
}

function handleAttack(kind) {
  playSfx(audio, kind === 'gun' ? 'shoot' : 'punch');
}

/**
 * A blow landed. The victim's own health is combat's bookkeeping; what belongs here is the heat a
 * punch or a bullet thrown in public earns, plus a word when somebody drops.
 */
function handleHit(target, amount, kind) {
  const gun = kind === 'gun';
  const heat = gun || amount >= 30 ? 0.5 : 0.35;
  addWanted(police, heat, gun ? 'Shots fired' : 'Assault');
  if (target && target.hp <= 0) hud.say('They are down.', 1.5);
}

/** Police return fire: the one place a bullet takes the player's health on their behalf. */
function handlePlayerHurt(amount) {
  damage(Number.isFinite(amount) ? amount : 8, 'Shot by the police');
}

/** A job paid out: main.js owns the wallet, so the mission only names itself and its fee. */
function handleMissionComplete(mission, w) {
  const pay = Number.isFinite(mission.pay) ? mission.pay : 0;
  w.player.money += pay;
  w.jobsDone += 1;
  hud.say(`Mission complete. +$${pay}`, 3);
  playSfx(audio, 'success');
  announce(`${mission.title} done. ${pay} dollars paid.`);
}

/** The objective card the HUD paints, taken straight off the mission module's own card data. */
function handleObjective(objective) {
  world.objective = objective ? { ...objective } : null;
}

/** Re-read the card from the mission state; used at boot, after a load and after a reset. */
function refreshObjective() {
  world.objective = getObjective(missions, world);
  return world.objective;
}

// --- Screen and run state ----------------------------------------------------------------------

let screen = SCREEN_TITLE;
let accumulator = 0;
let last = performance.now();
let elapsed = 0;
let fade = 1;
let autosaveTimer = 0;
let narrationTimer = 0;
let hurtCooldown = 0;
let careerEnded = false;
let ctx = null;

/** Mouse buttons for combat: left punches, right shoots. */
let mouseLeft = false;
let mouseRight = false;

/** F5 and F9 are not on input.js's watch list, so they are latched here. */
let saveQueued = false;
let loadQueued = false;

/** X is not on input.js's watch list either; the swing polls this set. */
const extraKeys = new Set();

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyX') {
    extraKeys.add('KeyX');
    event.preventDefault();
    return;
  }
  if (event.code === 'F5') {
    // Without this the browser reloads the page and the run is gone.
    event.preventDefault();
    saveQueued = true;
    return;
  }
  if (event.code === 'F9') {
    event.preventDefault();
    loadQueued = true;
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'KeyX') extraKeys.delete('KeyX');
});

window.addEventListener('blur', () => {
  extraKeys.clear();
  mouseLeft = false;
  mouseRight = false;
});

canvas.addEventListener('mousedown', (event) => {
  if (event.button === 0) mouseLeft = true;
  if (event.button === 2) mouseRight = true;
});

canvas.addEventListener('mouseup', (event) => {
  if (event.button === 0) mouseLeft = false;
  if (event.button === 2) mouseRight = false;
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

function context() {
  if (!ctx) ctx = canvas.getContext('2d');
  return ctx;
}

function announce(message) {
  if (statusLine) statusLine.textContent = message;
}

// --- Save and load -----------------------------------------------------------------------------

/** What the slot holds: where you stand, what you carry, and how far the story got. */
function snapshot() {
  return {
    player: {
      x: player.x,
      y: player.y,
      facing: player.facing,
      health: player.health,
      money: player.money,
    },
    clock: world.clock,
    day: world.day,
    jobsDone: world.jobsDone,
    wanted: world.wanted,
    objective: world.objective ? { ...world.objective } : null,
    mission: {
      storyIndex: missions.storyIndex,
      freeRoamIndex: missions.freeRoamIndex,
      freeRoamDone: missions.freeRoamDone,
      active: missions.active ? missions.active.mission.id : null,
      timer: missions.active?.timer ?? 0,
    },
  };
}

function saveGame(quiet) {
  const ok = writeSave(snapshot());
  world.saveStatus = ok ? 'just saved' : 'unavailable';
  if (!quiet) hud.say(ok ? 'Game saved.' : 'This browser refused the save.');
  return ok;
}

function loadGame(quiet) {
  const data = readSave();
  if (!data) {
    if (!quiet) hud.say('No saved game found.', 2);
    return false;
  }

  // Step out first: a loaded run always starts on foot, never mid-drive.
  if (player.car) {
    player.car.occupied = false;
    player.car.speed = 0;
    player.car = null;
  }

  player.x = clamp(data.player.x, 14, city.shoreline - 14);
  player.y = clamp(data.player.y, 14, city.height - 14);
  player.vx = 0;
  player.vy = 0;
  player.health = clamp(data.player.health ?? PLAYER.maxHealth, 1, PLAYER.maxHealth);
  player.money = Math.max(0, data.player.money ?? 0);
  if (Number.isFinite(data.player.facing)) player.facing = data.player.facing;

  if (Number.isFinite(data.clock)) world.clock = data.clock;
  if (Number.isFinite(data.day)) world.day = data.day;
  if (Number.isFinite(data.jobsDone)) world.jobsDone = Math.max(0, data.jobsDone);

  const stars = Number.isFinite(data.wanted) ? clamp(Math.round(data.wanted), 0, MAX_STARS) : 0;
  world.wanted = stars;
  police.level = stars;
  police.progress = 0;
  police.quiet = 5;

  // Mission progress comes back as a queue position; the job itself is re-armed from there, so a
  // half-finished delivery restarts at its own checkpoint instead of mid-street.
  const saved = data.mission;
  if (saved) {
    if (Number.isFinite(saved.storyIndex)) {
      missions.storyIndex = clamp(saved.storyIndex, 0, missions.story.length);
    }
    if (Number.isFinite(saved.freeRoamIndex)) missions.freeRoamIndex = Math.max(0, saved.freeRoamIndex);
    if (Number.isFinite(saved.freeRoamDone)) missions.freeRoamDone = Math.max(0, saved.freeRoamDone);
  }
  // Re-arm from the queue position so the card on the HUD and the job's own target agree; the
  // saved `objective` is a record of what was on screen, not a second source of truth.
  missions.active = null;
  startNextMission(missions, world);
  refreshObjective();

  hurtCooldown = 0;
  careerEnded = false;
  world.saveStatus = 'loaded';
  renderer.camera.x = player.x;
  renderer.camera.y = player.y;
  if (!quiet) hud.say('Game loaded.', 2);
  announce('Loaded saved game.');
  setEnabled(audio, true);
  startMusic(audio);
  return true;
}

// --- Getting in and out ------------------------------------------------------------------------

/** Take the wheel. An NPC car is a theft: the traffic forgets it and the heat goes up. */
function enterVehicle(car) {
  if (!enterCar(player, car)) return;

  if (car.kind === 'npc') {
    const index = traffic.list.indexOf(car);
    if (index !== -1) traffic.list.splice(index, 1);
    car.kind = 'stolen';
    addWanted(police, 1, 'Car stolen');
    hud.say('Car stolen. The police are watching.', 2.5);
  } else {
    hud.say('Engine running. W drives, S brakes, A/D steers, Space handbrake.', 2.5);
  }
}

/** The dropped pistol within `reach`, or null. Never hands out a second one. */
function pistolNearby(reach) {
  if (combat.hasGun) return null;

  let best = null;
  let bestD = reach;

  for (const item of combat.pickups) {
    if (item.taken) continue;
    const d = distance(item.x, item.y, player.x, player.y);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** The prompt the HUD shows above the controls: the one thing E would do right now. */
function interactionFor() {
  if (player.car) return { label: 'Leave the car' };
  if (pistolNearby(PISTOL_REACH)) return { label: 'Take the pistol' };

  const car = nearestCar(parkedCars.concat(traffic.list), player.x, player.y, CAR_REACH);
  if (!car) return null;
  return { label: car.kind === 'npc' ? 'Steal the car' : 'Get in the car' };
}

/** E: out of the car, onto the pistol, or into the nearest free car. */
function interact() {
  if (player.car) {
    player.car.speed = 0;
    leaveCar(player, city);
    hud.say('Out of the car.', 2);
    return;
  }

  const pistol = pistolNearby(PISTOL_REACH);
  if (pistol) {
    // A step onto the drop: combat's own walk-over check hands the pistol over on the next step.
    player.x = pistol.x;
    player.y = pistol.y;
    player.vx = 0;
    player.vy = 0;
    hud.say('You reach down for the pistol.', 2);
    return;
  }

  const near = nearestCar(parkedCars.concat(traffic.list), player.x, player.y, CAR_REACH);
  if (near) {
    enterVehicle(near);
    return;
  }

  hud.say('Nothing within reach.', 1.6);
}

// --- Run setup ---------------------------------------------------------------------------------

function resetRun() {
  if (player.car) {
    player.car.occupied = false;
    player.car.speed = 0;
  }
  player.car = null;
  player.x = city.spawn.x;
  player.y = city.spawn.y;
  player.vx = 0;
  player.vy = 0;
  player.facing = Number.isFinite(city.spawn.facing) ? city.spawn.facing : Math.PI / 2;
  player.health = PLAYER.maxHealth;
  player.money = 0;
  player.handbrake = false;
  player.walking = 0;
  player.steps = 0;

  world.wanted = 0;
  world.jobsDone = 0;
  world.clock = OPENING_CLOCK;
  world.day = 1;
  world.time = 0;
  hurtCooldown = 0;
  careerEnded = false;
  autosaveTimer = 0;

  police.level = 0;
  police.progress = 0;
  police.officers = [];
  police.cars = [];

  resetCombat(combat);
  placePistol(combat, city, rng);

  // Story job 1 (Drive to the pier, $120) is armed here, so its card is on the HUD from frame one.
  resetMissions(missions);
  startNextMission(missions, world);
  refreshObjective();

  renderer.camera.x = player.x;
  renderer.camera.y = player.y;
}

function startRun(fromSave) {
  screen = SCREEN_PLAY;
  accumulator = 0;
  fade = 1;
  autosaveTimer = 0;
  narrationTimer = 0;
  // A click that started the run must not also count as a punch on the first frame.
  mouseLeft = false;
  mouseRight = false;

  if (fromSave && !loadGame(true)) resetRun();

  announce('Free roam in Solmar. Escape pauses.');
  setEnabled(audio, true);
  startMusic(audio);
}

// --- Actions -----------------------------------------------------------------------------------

function handleActions() {
  const actions = input.take();
  const wantSave = saveQueued;
  const wantLoad = loadQueued;
  saveQueued = false;
  loadQueued = false;

  if (screen === SCREEN_TITLE) {
    if (actions & ACT_CONFIRM) startRun(false);
    else if ((actions & ACT_LOAD) && hasSave()) startRun(true);
    return;
  }

  if (screen === SCREEN_OVER) {
    if (actions & ACT_CONFIRM) {
      resetRun();
      startRun(false);
    }
    return;
  }

  if (actions & ACT_PAUSE) {
    screen = screen === SCREEN_PLAY ? SCREEN_PAUSED : SCREEN_PLAY;
    announce(screen === SCREEN_PAUSED ? 'Paused.' : 'Playing.');
    input.clear();
    mouseLeft = false;
    mouseRight = false;
    return;
  }

  if (screen !== SCREEN_PLAY) return;

  if (actions & ACT_INTERACT) interact();
  if ((actions & ACT_SAVE) || wantSave) saveGame(false);
  // ACT_LOAD is ignored while playing: input.js raises it for a fresh press of C, which is also
  // the shoot key. Loading from play is F9 (latched above), so the trigger stays a trigger.
  if (wantLoad) loadGame(false);
}

// --- Simulation --------------------------------------------------------------------------------

/** On foot the player module owns the body; in a car the car moves first and the body follows. */
function stepPlayer() {
  if (!player.car) {
    updatePlayer(player, city, input, STEP);
    return;
  }

  const move = input.move();
  const throttle = -move.y;
  const steer = move.x;
  const handbrake = input.down('Space');
  player.handbrake = handbrake;

  driveCar(player.car, throttle, steer, handbrake, STEP);
  const impact = moveCar(player.car, city, STEP);
  if (impact > 0.4) {
    renderer.nudgeShake(Math.min(0.5, impact * 0.1));
    if (impact > 1.4) damage(Math.min(18, impact * 2.4), 'Crashed the car!');
  }

  // The car is the authority on pose; the player module copies it and stops there.
  updatePlayer(player, city, input, STEP);
}

/** Being run over, and (while driving) ploughing through the crowd. */
function checkHazards() {
  if (hurtCooldown > 0) hurtCooldown = Math.max(0, hurtCooldown - STEP);

  const car = player.car;
  if (!car) {
    for (const npc of traffic.list) {
      if (Math.abs(npc.speed) < 55) continue;
      if (distance(npc.x, npc.y, player.x, player.y) > 26) continue;

      const nx = player.x - npc.x;
      const ny = player.y - npc.y;
      const d = Math.hypot(nx, ny) || 1;
      player.x += (nx / d) * 16;
      player.y += (ny / d) * 16;
      player.vx = (nx / d) * 190;
      player.vy = (ny / d) * 190;
      damage(14 + Math.abs(npc.speed) * 0.04, 'Hit by a car!');
      break;
    }
    return;
  }

  if (Math.abs(car.speed) < 70) return;

  for (const ped of pedestrians.list) {
    if (ped.down > 0) continue;
    if (distance(ped.x, ped.y, car.x, car.y) >= 34) continue;

    pedestrians.knockAt(ped.x, ped.y, 40);
    renderer.nudgeShake(0.3);
    addWanted(police, 1, 'Hit pedestrian');
    hud.say('You hit a pedestrian!', 2);
    break;
  }
}

/** X or left click punches; C or right click fires, once the pistol has been found. */
function handleCombatInput() {
  if (player.car) return;
  if (!canAttack(combat, world)) return;

  if (extraKeys.has('KeyX') || mouseLeft) punch(combat, world);
  if (input.down('KeyC') || mouseRight) shoot(combat, world);
}

function damage(amount, reason) {
  if (hurtCooldown > 0 || player.health <= 0) return;

  player.health = Math.max(0, player.health - amount);
  hurtCooldown = 0.7;
  player.hurtFlash = 0.4;
  renderer.nudgeShake(0.5);

  if (player.health <= 0) {
    gameOver();
    return;
  }

  hud.say(reason, 1.6);
  announce(`${reason} ${Math.round(player.health)} health.`);
}

function gameOver() {
  if (careerEnded) return;
  careerEnded = true;

  if (player.car) {
    player.car.occupied = false;
    player.car.speed = 0;
    player.car = null;
  }

  screen = SCREEN_OVER;
  mouseLeft = false;
  mouseRight = false;
  announce(`Wasted. ${Math.round(player.money)} dollars banked. Press Enter to try again.`);
}

function clockStep(dt) {
  world.clock += dt / 2;
  if (world.clock >= DAY_MINUTES) {
    world.clock -= DAY_MINUTES;
    world.day += 1;
  }
}

/** 0 in daylight, 1 deep at night: what the renderer paints its lamps and window glow by. */
function nightAmount() {
  const hour = world.clock / 60;
  if (hour >= 21 || hour < 5) return 1;
  if (hour >= 19) return (hour - 19) / 2;
  if (hour < 7) return 1 - (hour - 5) / 2;
  return 0;
}

/** One fixed step of the whole world. Every module is advanced exactly once, in this order. */
function step() {
  // The pause menu stops the world: no clock, no traffic, no police behind the overlay.
  if (screen === SCREEN_PAUSED) return;

  const playing = screen === SCREEN_PLAY;

  if (playing) {
    stepPlayer();
    checkHazards();
    handleCombatInput();

    autosaveTimer += STEP;
    if (autosaveTimer >= SAVE.autosave) {
      autosaveTimer = 0;
      if (!player.car) saveGame(true);
    }
  } else {
    // Behind the title card, the pause menu and the WASTED screen the body is still stepped, on
    // no input: momentum bleeds off and the collision solver settles it, but nothing is driven.
    updatePlayer(player, city, IDLE_INPUT, STEP);
  }

  clockStep(STEP);
  traffic.update(STEP, world);
  pedestrians.update(STEP, world);
  updatePolice(police, world, STEP);
  updateCombat(combat, world, STEP);
  updateMissions(missions, world, STEP);
  updateAudio(audio, world, STEP);

  world.wanted = getWanted(police);
}

// --- Painting ----------------------------------------------------------------------------------

function render() {
  const night = nightAmount();
  world.time = elapsed;

  if (screen === SCREEN_TITLE) {
    renderer.drawOverview(world, elapsed, Math.max(0.22, night));
    hud.drawTitle(context(), renderer.view, { time: elapsed, hasSave: hasSave() });
  } else {
    renderer.draw(world, {
      time: elapsed,
      night,
      driving: !!player.car,
      target: player.car ?? player,
      marker: world.objective,
      dt: STEP,
    });
    hud.drawGame(context(), world, screen === SCREEN_PLAY ? interactionFor() : null);
    if (screen === SCREEN_PAUSED) hud.drawPause(context(), renderer.view, world);
    else if (screen === SCREEN_OVER) hud.drawOver(context(), renderer.view, world);
  }

  hud.drawFade(context(), renderer.view, fade);
}

function frame(now) {
  requestAnimationFrame(frame);

  const dt = Math.min((now - last) / 1000, MAX_FRAME);
  last = now;
  elapsed += dt;

  handleActions();

  accumulator += dt;
  const limit = screen === SCREEN_PLAY ? 6 : 4;
  let ticks = 0;
  while (accumulator >= STEP && ticks < limit) {
    step();
    accumulator -= STEP;
    ticks += 1;
  }
  // A frame that ran out of catch-up budget drops the backlog instead of spiralling.
  if (ticks === limit) accumulator = 0;

  fade = damp(fade, 0, 3.2, dt);

  render();
  hud.update(dt);

  narrationTimer += dt;
  if (narrationTimer > 5) {
    narrationTimer = 0;
    if (screen === SCREEN_PLAY) {
      announce(`${player.car ? 'Driving' : 'On foot'}. ${Math.round(player.money)} dollars.`);
    }
  }
}

// --- Screenshot staging ------------------------------------------------------------------------

/** ?shot=start|play|end: stage a scene, paint it twice, then flag it ready for the runner. */
function runShot(name) {
  const drives = name === 'play' || name === 'end';

  if (drives) {
    screen = SCREEN_PLAY;
    const car = nearestCar(parkedCars, player.x, player.y, 200);
    if (car) enterCar(player, car);
    for (let i = 0; i < 240; i += 1) step();
  } else {
    for (let i = 0; i < 120; i += 1) step();
  }

  fade = 0;
  let painted = 0;

  function paint() {
    render();
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }

  requestAnimationFrame(paint);
}

// --- Debug hook --------------------------------------------------------------------------------

window.__solmar = {
  world,
  get screen() {
    return screen;
  },
  teleport(x, y) {
    if (player.car) {
      player.car.occupied = false;
      player.car = null;
    }
    player.x = x;
    player.y = y;
    renderer.camera.x = x;
    renderer.camera.y = y;
  },
  startNow() {
    startRun(false);
  },
};

// --- Boot --------------------------------------------------------------------------------------

// Build a fresh run up front: the world is armed (job 1 on the card, the pistol in the park)
// whether the first frame is the title card or free roam, so ?autostart=1 and Enter behave alike.
resetRun();

announce('Solmar. Press Enter to start, F9 loads a saved game.');
if (hasSave()) world.saveStatus = 'previous save found';

const shot = params.get('shot');
if (shot) {
  runShot(shot);
} else {
  if (params.get('autostart') === '1') startRun(false);
  requestAnimationFrame(frame);
}
