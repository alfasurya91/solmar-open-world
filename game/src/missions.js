// Solmar job queue. Five story jobs play in order, then one repeatable free-roam run takes over for
// as long as the player keeps driving. Nothing here draws: the module is pure bookkeeping and only
// talks to the game through the two hooks it was handed at construction.
//
// Public surface (main.js imports exactly these):
//   createMissions(city, rng, { onMissionComplete, onObjective }) -> state
//   startNextMission(state, world)    arm the next job; returns the mission or null
//   updateMissions(state, world, dt)  advance one fixed step, fire the hooks
//   getObjective(state, world)        -> objective card | null
//   getCurrentMission(state)          -> armed job, else the next one due
//   resetMissions(state)              back to story job 1
//
// Money is main.js's business. A finished job reports itself once through onMissionComplete; the
// `paid` map is the gate that keeps a replayed or duplicated completion from paying twice.
//
// Job kinds and how they finish:
//   reach    inside `radius` of the target point
//   deliver  inside `radius` of the drop point, and on foot
//   chase    get within `catchRadius` of the fleeing car before it covers `chaseDistance`

import { clamp, distance, distance2 } from './utils.js';

/** Fallback arrival radius, in world pixels, for jobs that do not set their own. */
const DEFAULT_RADIUS = 52;

/** How far ahead of the player, in pixels, the fleeing car starts a pursuit. */
const CHASE_LEAD = 230;

/** Midpoint of a { x, y, w, h } rect, or `fallback` when the rect is missing or unusable. */
function centreOf(rect, fallback) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.w)) {
    return { x: fallback.x, y: fallback.y };
  }
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * Fresh run state. The third argument carries main.js's hooks and is validated here, so every later
 * call reports through exactly one callback. `paid` and `attempts` are prototype-less maps keyed by
 * mission id (free-roam runs additionally carry a run number).
 */
export function createMissions(city, rng, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  return {
    city,
    rng,
    story: buildStoryMissions(city),
    freeRoam: buildFreeRoamMissions(city),
    storyIndex: 0,
    freeRoamIndex: 0,
    freeRoamDone: 0,
    active: null,               // { mission, phase, target, chaseCar, timer, tries, runId, data }
    completed: [],              // ids of finished story jobs, in order
    paid: Object.create(null),  // id or id#run -> true once reported to main.js
    attempts: Object.create(null),
    onMissionComplete: typeof opts.onMissionComplete === 'function' ? opts.onMissionComplete : null,
    onObjective: typeof opts.onObjective === 'function' ? opts.onObjective : null,
  };
}

/** The five story jobs in order, each anchored to a landmark of the generated city. */
function buildStoryMissions(city) {
  const { pier, promenade, downtown, beach, parks, lots, height } = city;

  // Where the beach road meets the west end of the pier deck.
  const pierEntry = () => ({ x: pier.x + 40, y: pier.y + pier.h / 2 });

  // The generator lays the first park and the first lot down early, so both are stable for a seed
  // and both are a short drive out of downtown.
  const parkCentre = () => centreOf(parks && parks[0], downtown);
  const lotCentre = () => centreOf(lots && lots[0], downtown);

  // South tip of the promenade, a stride in from the railing.
  const promenadeSouth = () => ({ x: promenade.x + 22, y: height - 118 });

  // North end of the beach road, out in the sand: the pursuit starts here.
  const beachRoadNorth = () => ({ x: beach.x + 130, y: downtown.y - 380 });

  return [
    {
      id: 'm1_pier',
      story: true,
      title: 'Drive to the pier',
      pay: 120,
      description: 'Take the beach road east and pull onto the pier. Vinnie left a crate at the entrance.',
      dialog: [
        'Vinnie: "The crate is at the pier. Beach road, all the way east. Don\'t scratch the paint."',
        'You: "Since when do you care about paint?"',
      ],
      type: 'reach',
      target: pierEntry,
      radius: 56,
    },
    {
      id: 'm2_park',
      story: true,
      title: 'Green Exchange',
      pay: 180,
      description: 'Meet Rosa in the city park at the centre of the grid. She has the next lead.',
      dialog: [
        'Rosa: "The park. Noon. Come alone — well, you\'re always alone."',
        'You: "Charming. What\'s the job?"',
      ],
      type: 'reach',
      target: parkCentre,
      radius: 52,
    },
    {
      id: 'm3_lot',
      story: true,
      title: 'Lot Transaction',
      pay: 220,
      description: 'Park up and walk into the north lot. Hand the package to the man by the lamp post.',
      dialog: [
        'Contact: "Leave the car. Drop it by the lamp post. No questions, no names."',
        'You: "Just the package?"',
        'Contact: "Just the package."',
      ],
      type: 'deliver',
      target: lotCentre,
      radius: 44,
      requireOnFoot: true,
    },
    {
      id: 'm4_chase',
      story: true,
      title: 'Beach Road Pursuit',
      pay: 300,
      description: 'A rival courier is running south down the beach road. Ram them before they reach the promenade.',
      dialog: [
        'Dispatch: "Black sedan, south on the beach road. Don\'t let it reach the promenade."',
        'You: "On it."',
      ],
      type: 'chase',
      target: beachRoadNorth,
      radius: 60,
      chaseSpeed: 235,
      chaseDistance: 2600,
      chaseCatch: 50,
    },
    {
      id: 'm5_promenade',
      story: true,
      title: 'End of the Line',
      pay: 400,
      description: 'Final meet at the south end of the promenade. Vinnie\'s buyer wears a white shirt.',
      dialog: [
        'Vinnie: "South promenade. The buyer wears a white shirt. Don\'t be late."',
        'You: "This better be worth it."',
        'Vinnie: "It always is."',
      ],
      type: 'reach',
      target: promenadeSouth,
      radius: 52,
    },
  ];
}

/**
 * The repeatable job that follows the story. It reuses the opener's pier drop so the loop is always
 * solvable, and lives in its own list because it is armed over and over rather than exhausted.
 */
function buildFreeRoamMissions(city) {
  const { pier } = city;
  return [
    {
      id: 'fr_pier_run',
      story: false,
      repeatable: true,
      title: 'Pier Run',
      pay: 90,
      description: 'Repeatable job. Run the beach road east to the pier and collect the drop.',
      dialog: [
        'Vinnie: "Another crate showed up. Same pier, same deal."',
        'You: "You ever run out of crates?"',
      ],
      type: 'reach',
      target: () => ({ x: pier.x + 40, y: pier.y + pier.h / 2 }),
      radius: 56,
    },
  ];
}

/** The armed job, or — with nothing armed — the job that would start next. */
export function getCurrentMission(missions) {
  if (!missions || !missions.story) return null;
  if (missions.active) return missions.active.mission;
  if (missions.storyIndex < missions.story.length) return missions.story[missions.storyIndex];
  if (missions.freeRoam.length > 0) {
    return missions.freeRoam[missions.freeRoamIndex % missions.freeRoam.length];
  }
  return null;
}

/**
 * The objective card:
 *   { id, title, pay, detail, distance, x, y, radius, kind, onFoot, dialog }
 * `x`/`y` go straight to the renderer's marker, so every card carries them — the chase card's point
 * rides the fleeing car. Null means "no job armed", which is how main.js clears world.objective.
 */
export function getObjective(missions, world) {
  const active = missions ? missions.active : null;
  if (!active) return null;

  const { mission, target } = active;
  const player = world && world.player ? world.player : null;
  const hasTarget = !!target && Number.isFinite(target.x) && Number.isFinite(target.y);

  let dist = null;
  if (hasTarget && player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
    dist = Math.round(distance(player.x, player.y, target.x, target.y));
  }

  return {
    id: mission.id,
    title: mission.title,
    pay: mission.pay,
    detail: mission.description,
    distance: dist,
    x: hasTarget ? target.x : undefined,
    y: hasTarget ? target.y : undefined,
    radius: mission.radius ?? DEFAULT_RADIUS,
    kind: mission.type,
    onFoot: !!mission.requireOnFoot,
    dialog: mission.dialog ? mission.dialog.slice() : [],
  };
}

/**
 * Arm the next job. Story jobs run in order, then the free-roam job comes round forever. Returns the
 * mission that was armed, or null when nothing is left. main.js calls this at boot and after a load,
 * so without it the run would have no first job.
 */
export function startNextMission(missions, world) {
  if (!missions || !missions.story) return null;
  if (missions.active) return missions.active.mission;

  const mission = pickNext(missions);
  if (!mission) {
    missions.active = null;
    missions.onObjective?.(null);
    return null;
  }

  const target = resolveTarget(mission, missions, world);
  const tries = (missions.attempts[mission.id] ?? 0) + 1;
  missions.attempts[mission.id] = tries;

  const active = {
    mission,
    phase: 'active', // 'active' | 'completed' | 'failed'
    target,
    chaseCar: null,
    timer: 0,
    tries,
    runId: missions.freeRoamIndex,
    data: {},
  };

  if (mission.type === 'chase') {
    active.chaseCar = spawnChaseCar(mission, target, missions.city, world && world.player);
    // The card follows the rival, so aim it at the car before the first frame is drawn.
    active.target = { x: active.chaseCar.x, y: active.chaseCar.y };
  }

  missions.active = active;
  missions.onObjective?.(getObjective(missions, world));
  return mission;
}

/** Choose the next job without arming it: next story job, else the free-roam loop. */
function pickNext(missions) {
  if (missions.storyIndex < missions.story.length) {
    return missions.story[missions.storyIndex];
  }
  if (missions.freeRoam.length > 0) {
    const mission = missions.freeRoam[missions.freeRoamIndex % missions.freeRoam.length];
    missions.freeRoamIndex += 1;
    return mission;
  }
  return null;
}

/** Evaluate a target (closure or point), falling back to downtown if the city data is incomplete. */
function resolveTarget(mission, missions, world) {
  const fallback = (world && world.city && world.city.downtown) || missions.city.downtown;
  let point = null;
  try {
    point = typeof mission.target === 'function' ? mission.target() : mission.target;
  } catch (err) {
    point = null;
  }
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { x: fallback.x, y: fallback.y };
  }
  return { x: point.x, y: point.y };
}

/**
 * Give the rival a head start relative to wherever the player is, kept inside the sand strip and
 * clear of the water. Spawning off the player is what keeps the chase winnable wherever they arrive;
 * a fixed city point could strand the rival far away with seconds left on the clock.
 */
function spawnChaseCar(mission, target, city, player) {
  const beach = city.beach;
  const minX = beach.x + 60;
  const maxX = beach.x + beach.w - 90;
  const baseX = player && Number.isFinite(player.x) ? player.x : target.x;
  const baseY = player && Number.isFinite(player.y) ? player.y : target.y;

  return {
    x: clamp(baseX + 70, minX, maxX),
    y: clamp(baseY - CHASE_LEAD, 110, city.height - 420),
    angle: Math.PI / 2, // south, down the beach road
    speed: mission.chaseSpeed ?? 230,
    travelled: 0,
    maxDistance: mission.chaseDistance ?? 1200,
    catchRadius: mission.chaseCatch ?? 44,
    phase: 0,
    caught: false,
  };
}

/** Advance the armed job by one fixed step, then settle the completed / failed phases. */
export function updateMissions(missions, world, dt) {
  if (!missions || !missions.story) return;
  if (!missions.active) {
    startNextMission(missions, world);
    return;
  }

  const active = missions.active;
  const mission = active.mission;
  const player = world && world.player ? world.player : null;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

  active.timer += step;

  if (active.chaseCar && !active.chaseCar.caught) {
    updateChase(missions, active, player, step);
  } else if (mission.type === 'reach' || mission.type === 'deliver') {
    checkArrival(active, mission, player);
  }

  if (active.phase === 'completed') {
    completeMission(missions, world);
    return;
  }
  if (active.phase === 'failed') {
    failMission(missions, world);
    return;
  }

  // Re-publish every step so the distance readout and the chase marker stay honest.
  missions.onObjective?.(getObjective(missions, world));
}

/** Drive the rival south with a gentle weave, and test whether the player has caught it. */
function updateChase(missions, active, player, dt) {
  const car = active.chaseCar;
  const city = missions.city;
  const beach = city.beach;

  car.phase += dt * 1.35;
  const laneX = beach.x + beach.w * 0.45 + Math.sin(car.phase) * 55;
  const aheadY = car.y + 190;
  const desired = Math.atan2(aheadY - car.y, laneX - car.x);

  // Ease the heading toward the lane rather than snapping, so the rival reads as driven.
  const turn = 1 - Math.exp(-6 * dt);
  car.angle += shortestTurn(car.angle, desired) * turn;

  const step = car.speed * dt;
  car.x = clamp(car.x + Math.cos(car.angle) * step, beach.x + 46, beach.x + beach.w - 70);
  car.y = clamp(car.y + Math.sin(car.angle) * step, 90, city.height - 90);
  car.travelled += step;

  active.target.x = car.x;
  active.target.y = car.y;

  if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
    const near = distance(player.x, player.y, car.x, car.y) < car.catchRadius;
    const rammed = player.car
      ? distance2(player.car.x, player.car.y, car.x, car.y) < car.catchRadius * car.catchRadius
      : false;
    if (near || rammed) {
      car.caught = true;
      active.phase = 'completed';
      return;
    }
  }

  if (car.travelled >= car.maxDistance) active.phase = 'failed';
}

/** Reach / deliver test: inside the radius, and on foot when the job demands it. */
function checkArrival(active, mission, player) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return;
  const target = active.target;
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return;

  const reach = mission.radius ?? DEFAULT_RADIUS;
  const arrived = distance(player.x, player.y, target.x, target.y) < reach;
  const onFootOk = !mission.requireOnFoot || !player.car;

  if (arrived && onFootOk) active.phase = 'completed';
}

/**
 * Retire the job and report it exactly once. Wallet and job counter belong to main.js, so this only
 * moves the queue along; the next job arms on the following updateMissions call. `paid` is the gate:
 * story jobs key on their id, free-roam runs on id plus run number.
 */
function completeMission(missions, world) {
  const active = missions.active;
  if (!active) return;
  const { mission } = active;

  if (mission.story) {
    if (!missions.completed.includes(mission.id)) missions.completed.push(mission.id);
    if (missions.storyIndex < missions.story.length) missions.storyIndex += 1;
  } else {
    missions.freeRoamDone += 1;
  }

  const payKey = mission.story ? mission.id : `${mission.id}#${active.runId ?? missions.freeRoamDone}`;
  const alreadyPaid = !mission.story && missions.paid[payKey];
  missions.paid[payKey] = true;

  missions.active = null;
  missions.onObjective?.(null);
  if (!alreadyPaid) missions.onMissionComplete?.(mission, world);
}

/**
 * A failed chase is retried, not skipped: the queue does not advance, and the same job arms again on
 * this very step with a fresh rival car.
 */
function failMission(missions, world) {
  const mission = missions.active ? missions.active.mission : null;
  missions.active = null;
  missions.onObjective?.(null);
  if (!mission) return;
  // Re-arm immediately so the objective card never blinks out for a frame.
  startNextMission(missions, world);
}

/** Shortest signed turn from one heading to another, in (-PI, PI]. */
function shortestTurn(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Wipe all progress: story job 1, no completions, no payouts, no armed job. */
export function resetMissions(missions) {
  if (!missions || !missions.story) return;
  missions.storyIndex = 0;
  missions.freeRoamIndex = 0;
  missions.freeRoamDone = 0;
  missions.completed = [];
  missions.paid = Object.create(null);
  missions.attempts = Object.create(null);
  missions.active = null;
  missions.onObjective?.(null);
}
