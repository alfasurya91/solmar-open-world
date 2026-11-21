// Solmar missions. Five story missions in order, then one repeatable free-roam mission.
// Pure bookkeeping — no rendering. Talks to the game only through hooks passed at construction.

import { clamp, distance, distance2 } from './utils.js';

const DEFAULT_RADIUS = 52;
const CHASE_LEAD = 230;

function centreOf(rect, fallback) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.w)) {
    return { x: fallback.x, y: fallback.y };
  }
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

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
    active: null,
    completed: [],
    paid: Object.create(null),
    attempts: Object.create(null),
    onMissionComplete: typeof opts.onMissionComplete === 'function' ? opts.onMissionComplete : null,
    onObjective: typeof opts.onObjective === 'function' ? opts.onObjective : null,
  };
}

function buildStoryMissions(city) {
  const { pier, promenade, downtown, beach, parks, lots, height } = city;

  const pierEntry = () => ({ x: pier.x + 40, y: pier.y + pier.h / 2 });
  const parkCentre = () => centreOf(parks && parks[0], downtown);
  const lotCentre = () => centreOf(lots && lots[0], downtown);
  const promenadeSouth = () => ({ x: promenade.x + 22, y: height - 118 });
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

export function getCurrentMission(missions) {
  if (!missions || !missions.story) return null;
  if (missions.active) return missions.active.mission;
  if (missions.storyIndex < missions.story.length) return missions.story[missions.storyIndex];
  if (missions.freeRoam.length > 0) {
    return missions.freeRoam[missions.freeRoamIndex % missions.freeRoam.length];
  }
  return null;
}

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
    phase: 'active',
    target,
    chaseCar: null,
    timer: 0,
    tries,
    runId: missions.freeRoamIndex,
    data: {},
  };

  if (mission.type === 'chase') {
    active.chaseCar = spawnChaseCar(mission, target, missions.city, world && world.player);
    active.target = { x: active.chaseCar.x, y: active.chaseCar.y };
  }

  missions.active = active;
  missions.onObjective?.(getObjective(missions, world));
  return mission;
}

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

function spawnChaseCar(mission, target, city, player) {
  const beach = city.beach;
  const minX = beach.x + 60;
  const maxX = beach.x + beach.w - 90;
  const baseX = player && Number.isFinite(player.x) ? player.x : target.x;
  const baseY = player && Number.isFinite(player.y) ? player.y : target.y;

  return {
    x: clamp(baseX + 70, minX, maxX),
    y: clamp(baseY - CHASE_LEAD, 110, city.height - 420),
    angle: Math.PI / 2,
    speed: mission.chaseSpeed ?? 230,
    travelled: 0,
    maxDistance: mission.chaseDistance ?? 1200,
    catchRadius: mission.chaseCatch ?? 44,
    phase: 0,
    caught: false,
  };
}

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

  missions.onObjective?.(getObjective(missions, world));
}

function updateChase(missions, active, player, dt) {
  const car = active.chaseCar;
  const city = missions.city;
  const beach = city.beach;

  car.phase += dt * 1.35;
  const laneX = beach.x + beach.w * 0.45 + Math.sin(car.phase) * 55;
  const aheadY = car.y + 190;
  const desired = Math.atan2(aheadY - car.y, laneX - car.x);

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

function checkArrival(active, mission, player) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return;
  const target = active.target;
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return;

  const reach = mission.radius ?? DEFAULT_RADIUS;
  const arrived = distance(player.x, player.y, target.x, target.y) < reach;
  const onFootOk = !mission.requireOnFoot || !player.car;

  if (arrived && onFootOk) active.phase = 'completed';
}

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

function failMission(missions, world) {
  const mission = missions.active ? missions.active.mission : null;
  missions.active = null;
  missions.onObjective?.(null);
  if (!mission) return;
  startNextMission(missions, world);
}

function shortestTurn(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

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