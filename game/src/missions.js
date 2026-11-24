/* missions.js — the Solmar story arc plus repeatable free-roam work.
 *
 * Story order (seven jobs, then endless free-roam): dock-run delivery,
 * tail-lights chase, hot-wire heist, heat escape, last-light finale, then the
 * two post-arc jobs — Salt Ledger (chase, stakeout, run) and Breakwater
 * (manifest run under an alarm).
 *
 * Named exports: createMissions, startNextMission, updateMissions,
 * getCurrentMission, getObjective, resetMissions, marker, MISSION_ARC.
 *
 * `world` is the live world object: player (x, y, car, health, money, down),
 * optionally wanted / busted from the police, plus objective and jobsDone for
 * the HUD. updateMissions rewrites those two fields in the shape hud.js reads
 * (title, pay, detail, x, y, progress) and returns the tick's events. Each
 * mission carries its objective text, target point and payout, a completion
 * rule (clear every step) and failure rules (wasted, busted, timeout, target
 * escaped).
 *
 * Dialogue rides alongside the steps: every story job and every side gig has
 * a `brief`, per-step `lines` and a `sign-off`, emitted as 'say' events. The
 * shell's event switch ignores unknown types, so a HUD that has not learned
 * about 'say' simply keeps showing the objective, and one that has can print
 * the line with its speaker.
 */

import { MISSIONS, resolveDifficulty } from './config.js';
import { clamp } from './utils.js';

const REACH_RADIUS = 46;
const COOLDOWN = 6;      // seconds of quiet between jobs
const HISTORY_MAX = 16;
const LINE_MAX = 24;     // dialogue lines kept for a HUD to scroll back over
const MAP_W = 2438;      // fallback world size before the city is known
const MAP_H = 1766;

/* Story order — also the number of dots the HUD tracker draws. */
export const MISSION_ARC = [
  'dock-run', 'tail-lights', 'hot-wire', 'heat', 'last-light',
  'salt-ledger', 'breakwater',
];

/* --- points of interest ------------------------------------------- */

/* One road crossing, clamped into the grid. Every POI that is not a dock or a
 * lot sits on one of these, so it stays out of the building colliders even
 * after the city is re-seeded. */
function crossOf(city, c, r, width, height) {
  const vx = Array.isArray(city?.vx) && city.vx.length ? city.vx : null;
  const hy = Array.isArray(city?.hy) && city.hy.length ? city.hy : null;
  const x = vx
    ? vx[clamp(Math.round(c), 0, vx.length - 1)]
    : width * ((clamp(Math.round(c), 0, 7) + 0.5) / 8);
  const y = hy
    ? hy[clamp(Math.round(r), 0, hy.length - 1)]
    : height * ((clamp(Math.round(r), 0, 5) + 0.5) / 6);
  return { x, y };
}

/* Centre of a real dock; falls back to the pier deck, then to the sea-front
 * crossing, so a city without docks still yields a reachable target. */
function dockCentre(city, index) {
  const docks = Array.isArray(city?.docks) && city.docks.length ? city.docks : null;
  if (docks) {
    const d = docks[clamp(index, 0, docks.length - 1)];
    if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) {
      return { x: d.x + d.w * 0.5, y: d.y + d.h * 0.5 };
    }
  }
  const pier = city?.pier;
  if (pier && Number.isFinite(pier.x) && Number.isFinite(pier.y)) {
    return { x: pier.x + pier.w * 0.5, y: pier.y + pier.h * 0.5 };
  }
  return null;
}

function poisFor(city) {
  const width = Number.isFinite(city?.width) ? city.width : MAP_W;
  const height = Number.isFinite(city?.height) ? city.height : MAP_H;
  const pier = city?.pier;
  const pw = Number.isFinite(pier?.w) ? pier.w : 372;

  const cargo = dockCentre(city, 1);
  const docks = cargo ?? (Number.isFinite(pier?.x)
    ? { x: pier.x + pw * 0.5, y: pier.y + (pier.h ?? 76) * 0.5 }
    : { x: width - 40, y: height * 0.42 });

  /* The tip of the pier deck — always inside the walkable pier rectangle. */
  const pierEnd = Number.isFinite(pier?.x)
    ? { x: pier.x + pw - 40, y: pier.y + (pier.h ?? 76) * 0.5 }
    : { x: docks.x, y: docks.y };

  return {
    width, height,
    market: crossOf(city, 1, 1, width, height),
    docks,
    pierEnd,
    yard: crossOf(city, 1, 4, width, height),
    downtown: crossOf(city, 3, 2, width, height),
    marina: crossOf(city, 6, 4, width, height),
    safehouse: crossOf(city, 2, 0, width, height),
    airstrip: crossOf(city, 5, 4, width, height),
    promenade: crossOf(city, 7, 2, width, height),
    lockup: crossOf(city, 0, 3, width, height),
    /* Post-arc jobs work the north-east: a rooftop stakeout over the canal
     * and the breakwater gate where the boats tie off. */
    stakeout: crossOf(city, 4, 4, width, height),
    breakwater: crossOf(city, 6, 0, width, height),
    canal: crossOf(city, 5, 1, width, height),
    lot: (() => {
      const lots = Array.isArray(city?.lots) ? city.lots : [];
      const l = lots.find((q) => q && q.district === 'oldtown') ?? lots[0];
      return l && Number.isFinite(l.x) && Number.isFinite(l.y)
        ? { x: l.x + l.w * 0.5, y: l.y + l.h * 0.5 }
        : crossOf(city, 1, 2, width, height);
    })(),
  };
}

/* --- mission catalogue -------------------------------------------- */

const STORY = [
  {
    id: 'dock-run', type: 'delivery', name: 'Dock Run',
    payKey: 'deliveryPay', parKey: 'delivery', limitMul: 1.6,
    brief: { speaker: 'Marisol', text: 'Parcel is at the market stall. Boat leaves at the hour — do not make me explain a missed boat to Costa again.' },
    build: (p) => [
      { kind: 'reach', x: p.market.x, y: p.market.y, radius: 44, text:
        'Collect the parcel from the Old Town market stall', detail: 'Pick up the parcel',
        line: { speaker: 'Stallkeeper', text: 'You are the runner? Take it. It is heavier than it looks.' } },
      { kind: 'reach', x: p.docks.x, y: p.docks.y, radius: 58, text:
        'Run the parcel down to the pier before the boat leaves', detail: 'Deliver to the pier',
        line: { speaker: 'Marisol', text: 'Onto the boat, quick, before the tide turns.' } },
    ],
    signoff: { speaker: 'Marisol', text: 'Clean. Costa remembers clean.' },
  },
  {
    id: 'tail-lights', type: 'chase', name: 'Tail Lights',
    payKey: 'chasePay', parKey: 'chase', limitMul: 1.5,
    brief: { speaker: 'Costa', text: 'A courier is carrying our ledger. Do not kill him — we need what is in his head, not his blood.' },
    build: (p) => [
      { kind: 'tail', spawn: p.downtown, radius: 52, hold: 2.2, escape: 560, speed: 258, text:
        'Close the gap and put the courier into the kerb', detail: 'Chase and force him off',
        line: { speaker: 'Costa', text: 'Bumper to bumper. Make him choose the kerb.' } },
      { kind: 'reach', followActor: true, radius: 46, text:
        'Check the wreck for the ledger', detail: 'Search the courier car',
        line: { speaker: 'Costa', text: 'Glovebox. Ledger. Go.' } },
    ],
    signoff: { speaker: 'Costa', text: 'Good. Now we know who has been counting our money.' },
  },
  {
    id: 'hot-wire', type: 'heist', name: 'Hot Wire',
    payKey: 'heistPay', parKey: 'heist', limitMul: 0.9,
    brief: { speaker: 'Teo', text: 'Buyer wants a car, any car, still warm. Marina lot is full of them and the cameras are dead.' },
    build: (p) => [
      { kind: 'reach', x: p.lot.x, y: p.lot.y, radius: 52, text:
        'Reach the parking bay behind the marina towers', detail: 'Get to the parking bay',
        line: { speaker: 'Teo', text: 'Second row. The blue one has a lazy owner.' } },
      { kind: 'vehicle', x: p.lot.x, y: p.lot.y, radius: 96, text:
        'Take any car — the buyer does not care which one', detail: 'Boost a car',
        line: { speaker: 'Teo', text: 'Wires under the dash. Two seconds of nerve.' } },
      { kind: 'reach', x: p.lockup.x, y: p.lockup.y, radius: 54, needCar: true, text:
        'Drive the car to the boatyard chop shop', detail: 'Deliver the car, still running',
        line: { speaker: 'Teo', text: 'Roll it in, engine running, hands off the paint.' } },
    ],
    signoff: { speaker: 'Teo', text: 'Paid. The buyer never saw your face, which is the whole trick.' },
  },
  {
    id: 'heat', type: 'escape', name: 'Heat',
    payKey: 'escortPay', parKey: 'escort', limitMul: 1.4, alarm: true,
    brief: { speaker: 'Marisol', text: 'You tripped something. Cruisers are rolling. Get to the safehouse and stay off the main road.' },
    build: (p) => [
      { kind: 'evade', x: p.safehouse.x, y: p.safehouse.y, radius: 56, hold: 1.2, text:
        'Shake the cruisers, then get to the safehouse', detail: 'Lose the cops, reach the safehouse',
        line: { speaker: 'Marisol', text: 'Alleys. Not the promenade. Alleys.' } },
    ],
    signoff: { speaker: 'Marisol', text: 'Inside. Lights off. Breathe.' },
  },
  {
    id: 'last-light', type: 'delivery', name: 'Last Light',
    pay: (t) => t.bountyPay + t.deliveryPay, parKey: 'escort', limitMul: 1.8,
    brief: { speaker: 'Costa', text: 'One parcel left and then we are square. Safehouse to the pier, and the last stretch is on foot.' },
    build: (p) => [
      { kind: 'reach', x: p.safehouse.x, y: p.safehouse.y, radius: 46, text:
        'Collect the last parcel from the safehouse', detail: 'Grab the parcel',
        line: { speaker: 'Costa', text: 'On the table. Do not shake it.' } },
      { kind: 'reach', x: p.docks.x, y: p.docks.y, radius: 56, text:
        'Drive the parcel to the pier', detail: 'Take it to the pier',
        line: { speaker: 'Costa', text: 'Pier gate. Then you walk.' } },
      { kind: 'reach', x: p.pierEnd.x, y: p.pierEnd.y, radius: 40, onFoot: true, text:
        'Walk it out along the pier to the boat', detail: 'On foot: to the boat',
        line: { speaker: 'Costa', text: 'Out along the boards. The boat is the one with no lights.' } },
    ],
    signoff: { speaker: 'Costa', text: 'Square. Whatever happens next, we started it together.' },
  },
  {
    /* Mission 7 — the post-arc ledger job: a chase that turns into a stakeout. */
    id: 'salt-ledger', type: 'chase', name: 'Salt Ledger',
    pay: (t) => Math.round(t.chasePay * 1.15 + t.escortPay * 0.35),
    parKey: 'chase', limitMul: 1.7,
    brief: { speaker: 'Marisol', text: 'The ledger we took was a decoy. The real one is riding with an accountant who thinks a fast car makes him invisible.' },
    build: (p) => [
      { kind: 'tail', spawn: p.marina, radius: 56, hold: 2.6, escape: 600, speed: 276, text:
        'Run the accountant down before he reaches the canal', detail: 'Chase the accountant',
        line: { speaker: 'Marisol', text: 'Do not put him in the water. The ledger does not swim.' } },
      { kind: 'reach', followActor: true, radius: 48, text:
        'Search the car for the salted ledger', detail: 'Search the wreck',
        line: { speaker: 'Marisol', text: 'Under the seat. Of course it is under the seat.' } },
      { kind: 'reach', x: p.stakeout.x, y: p.stakeout.y, radius: 50, onFoot: true, hold: 1.6, text:
        'Stake out the rooftop meet on foot until the drop is confirmed', detail: 'On foot: watch the meet',
        line: { speaker: 'Marisol', text: 'Rooftop. Eyes on the meet. Do not be seen.' } },
    ],
    signoff: { speaker: 'Marisol', text: 'Names, dates, amounts. Costa will want to read this twice.' },
  },
  {
    /* Mission 8 — the closing run: a manifest under a live alarm. */
    id: 'breakwater', type: 'delivery', name: 'Breakwater',
    pay: (t) => Math.round(t.escortPay * 1.25 + t.heistPay * 0.25),
    parKey: 'escort', limitMul: 1.5, alarm: true,
    brief: { speaker: 'Costa', text: 'Last job. The manifest at the boatyard lockup is the only thing tying us to the pier. Take it out along the breakwater and hand it to the boat.' },
    build: (p) => [
      { kind: 'reach', x: p.lockup.x, y: p.lockup.y, radius: 54, text:
        'Pull the manifest from the boatyard lockup', detail: 'Grab the manifest',
        line: { speaker: 'Costa', text: 'Lockup is alarmed. You have minutes, not hours.' } },
      { kind: 'reach', x: p.breakwater.x, y: p.breakwater.y, radius: 58, needCar: true, text:
        'Drive the manifest round to the breakwater gate', detail: 'Drive to the breakwater',
        line: { speaker: 'Costa', text: 'Breakwater gate. Keep the car moving, they are watching the road.' } },
      { kind: 'reach', x: p.pierEnd.x, y: p.pierEnd.y, radius: 40, onFoot: true, text:
        'Walk the manifest out to the boat on the pier head', detail: 'On foot: to the boat',
        line: { speaker: 'Costa', text: 'On foot from here. No lights, no shouting.' } },
    ],
    signoff: { speaker: 'Costa', text: 'That is the end of it. Solmar is ours, or it is nobody\'s.' },
  },
];

const FREE_KINDS = ['courier', 'bounty', 'scrap', 'parcel'];

/* --- state --------------------------------------------------------- */

export function createMissions(city, options = {}) {
  const pois = poisFor(city);
  /* Difficulty comes from config.js so payouts and par times match the rest of
   * the game. Passing a preset name (or a resolved preset) is supported, and
   * anything unknown falls back to the default preset. */
  const preset = typeof options.difficulty === 'string'
    ? resolveDifficulty(options.difficulty)
    : (options.difficulty && typeof options.difficulty === 'object'
      ? options.difficulty
      : resolveDifficulty());

  return {
    pois, bounds: { width: pois.width, height: pois.height },
    pay: preset?.missions ?? MISSIONS,
    timeScale: Number.isFinite(preset?.timeScale) ? preset.timeScale : 1,
    difficulty: preset?.name ?? 'normal',
    storyIndex: 0, mode: 'story', current: null,
    jobsDone: 0, failures: 0, earned: 0, time: 0, cooldownT: 0,
    autoNext: options.autoNext !== false,
    cooldown: Number.isFinite(options.cooldown) ? options.cooldown : COOLDOWN,
    random: typeof options.random === 'function' ? options.random : Math.random,
    events: [], history: [], lastResult: null,
    /* Dialogue scroll-back: the last LINE_MAX 'say' lines, newest last. */
    lines: [],
  };
}

/* --- building a mission ------------------------------------------- */

/* Resolve a catalogue entry's payout and timer against the active difficulty.
 * `pay` may be a number or a function of the scaled MISSIONS table. */
function tune(def, state) {
  const table = state.pay;
  const payout = typeof def.pay === 'function' ? def.pay(table)
    : (Number.isFinite(def.pay) ? def.pay : table[def.payKey] ?? 0);
  const par = table.parTime?.[def.parKey] ?? 150;
  return {
    payout: Math.round(payout),
    limit: Math.round(par * (def.limitMul ?? 1) * state.timeScale),
  };
}

function makeMission(def, pois, index, state) {
  const steps = def.build(pois);
  const first = steps[0];
  const { payout, limit } = tune(def, state);
  const mission = {
    id: def.id, index, type: def.type, name: def.name,
    payout, steps, step: 0, t: 0,
    timeLimit: limit, progress: 0, hold: 0, actor: null,
    alarm: def.alarm === true, free: def.free === true,
    timed: def.timed === true,
    brief: def.brief ?? null, signoff: def.signoff ?? null,
  };
  if (first.kind === 'tail') {
    mission.actor = {
      x: first.spawn.x, y: first.spawn.y, dx: 0, dy: -1,
      speed: first.speed ?? 250, heading: -Math.PI / 2,
    };
  }
  return mission;
}

/* The point the marker tracks this tick: the live actor during a tail
 * step, otherwise the step's own coordinates. */
function pointOf(mission) {
  const step = mission.steps[mission.step];
  if (!step) return null;
  if (step.kind === 'tail' && mission.actor) return mission.actor;
  return step;
}

/* Free-roam jobs reuse the story step machinery. Each entry builds its own
 * step list from the two chosen points of interest. */
const FREE_SPECS = {
  courier: {
    type: 'delivery', name: 'Courier Run', limitMul: 1.2,
    pay: (t) => t.deliveryPay * 0.8,
    steps: (from, to) => [
      { kind: 'reach', x: from.x, y: from.y, radius: 44,
        text: 'Pick up the package', detail: 'Collect the package' },
      { kind: 'reach', x: to.x, y: to.y, radius: 52,
        text: 'Drop the package with the client',
        detail: 'Deliver the package across town' },
    ],
  },
  bounty: {
    type: 'chase', name: 'Bounty: Runner', limitMul: 1.2,
    pay: (t) => t.bountyPay,
    steps: (from, to, rng) => [
      { kind: 'tail', spawn: from, radius: 54, hold: 2, escape: 620,
        speed: 244 + rng() * 30,
        text: 'Hunt the runner down and stop the car',
        detail: 'Bounty: chase the runner and pin the car' },
    ],
  },
  scrap: {
    type: 'heist', name: 'Scrap Pickup', limitMul: 0.8,
    pay: (t) => t.heistPay * 0.45,
    steps: (from, to) => [
      { kind: 'vehicle', x: from.x, y: from.y, radius: 90,
        text: 'Take a car for the scrapyard', detail: 'Boost a car for the yard' },
      { kind: 'reach', x: to.x, y: to.y, radius: 54, needCar: true,
        text: 'Drive it to the yard, engine still warm',
        detail: 'Deliver the car to the scrapyard' },
    ],
  },
  /*
   * The timed parcel: the one free-roam job that pays for speed. The limit is
   * tight (0.45 of the delivery par time) because the whole point is the
   * clock, and the payout leans on the bonus for beating it — a slow runner
   * still clears but for close to nothing.
   */
  parcel: {
    type: 'delivery', name: 'Rush Parcel', limitMul: 0.45, timed: true,
    pay: (t) => t.deliveryPay * 1.35,
    steps: (from, to) => [
      { kind: 'reach', x: from.x, y: from.y, radius: 46,
        text: 'Grab the rush parcel — the clock is already running',
        detail: 'Collect the rush parcel',
        line: { speaker: 'Dispatcher', text: 'Clock is on. Eight blocks, no excuses.' } },
      { kind: 'reach', x: to.x, y: to.y, radius: 54,
        text: 'Get the rush parcel across town before the clock runs out',
        detail: 'Deliver the rush parcel on time',
        line: { speaker: 'Dispatcher', text: 'You are burning time. Move.' } },
    ],
    signoff: { speaker: 'Dispatcher', text: 'On the bell. That is how a parcel job is done.' },
  },
};

function makeFreeMission(state) {
  const pois = state.pois;
  const rng = state.random;
  const keys = ['market', 'docks', 'yard', 'downtown', 'marina', 'safehouse', 'airstrip', 'promenade'];
  const pick = () => keys[clamp(Math.floor(rng() * keys.length), 0, keys.length - 1)];
  const fromKey = pick();
  let toKey = pick();
  if (toKey === fromKey) toKey = keys[(keys.indexOf(fromKey) + 3) % keys.length];

  const kind = FREE_KINDS[clamp(Math.floor(rng() * FREE_KINDS.length), 0, FREE_KINDS.length - 1)];
  const spec = FREE_SPECS[kind];
  const ease = 0.7 + rng() * 0.5;          // pay wobble so repeat jobs differ
  const from = pois[fromKey];
  const to = pois[toKey];

  return makeMission({
    id: `free-${kind}-${Math.round(state.time)}`,
    type: spec.type,
    name: spec.name,
    pay: () => Math.round(spec.pay(state.pay) * ease),
    parKey: spec.type,
    limitMul: spec.limitMul,
    timed: spec.timed === true,
    brief: spec.brief ?? null,
    signoff: spec.signoff ?? null,
    free: true,
    build: () => spec.steps(from, to, rng),
  }, pois, -1, state);
}

/* --- public flow --------------------------------------------------- */

export function getCurrentMission(state) {
  return state?.current ?? null;
}

/* Queue a spoken line. `line` is { speaker, text }; anything malformed is
 * dropped rather than printed as "undefined: undefined" in the HUD. */
function say(state, line) {
  if (!state || !line || typeof line.text !== 'string' || !line.text) return;
  const entry = {
    speaker: typeof line.speaker === 'string' && line.speaker ? line.speaker : 'Solmar',
    text: line.text,
  };
  state.lines.push(entry);
  if (state.lines.length > LINE_MAX) state.lines.splice(0, state.lines.length - LINE_MAX);
  pushEvent(state, { type: 'say', ...entry });
}

export function startNextMission(state, world) {
  if (!state) return null;
  /* Already on a job: hand it back instead of silently doing nothing, so a
   * HUD button pressed twice cannot drop or restart the active mission. */
  if (state.current) return state.current;

  let mission;
  if (state.mode === 'story' && state.storyIndex < STORY.length) {
    mission = makeMission(STORY[state.storyIndex], state.pois, state.storyIndex, state);
    state.storyIndex += 1;
    if (state.storyIndex >= STORY.length) state.mode = 'free';
    state.current = mission;
  } else {
    state.mode = 'free';
    mission = makeFreeMission(state);
    state.current = mission;
  }
  state.cooldownT = 0;
  const opener = mission.steps[0];
  pushEvent(state, {
    type: 'start', id: mission.id, name: mission.name,
    payout: mission.payout, text: opener.text, timed: mission.timed === true,
  });
  /* The briefing, then the first step's own line, so a job opens with two
   * voices rather than a silent objective change. */
  say(state, mission.brief);
  say(state, opener.line);
  if (mission.alarm) {
    pushEvent(state, {
      type: 'alarm', id: mission.id, name: mission.name,
      reason: 'mission', x: opener.x, y: opener.y,
    });
  }
  syncWorld(state, world);
  return mission;
}

export function updateMissions(state, world, dt) {
  if (!state) return [];
  const step = clamp(Number(dt) || 0, 0, 0.25);
  state.time += step;

  if (state.current) {
    updateActive(state, world ?? {}, step);
  } else if (state.autoNext && world?.player) {
    state.cooldownT = Math.max(0, state.cooldownT - step);
    if (state.cooldownT <= 0) startNextMission(state, world);
  }

  syncWorld(state, world);
  return state.events.splice(0, state.events.length);
}

/* --- per-tick mission work ---------------------------------------- */

function updateActive(state, world, dt) {
  const mission = state.current;
  const player = world.player;
  mission.t += dt;

  if (isWasted(player)) return failMission(state, world, 'wasted');
  if (world.busted === true) return failMission(state, world, 'busted');
  if (mission.timeLimit > 0 && mission.t >= mission.timeLimit) return failMission(state, world, 'timeout');

  const step = mission.steps[mission.step];
  if (!step) return completeMission(state, world);
  if (step.kind === 'tail') return updateTail(state, world, step, dt);

  // car-only and on-foot-only markers refuse to clear in the wrong state
  const wrongState = (step.needCar && !player?.car) || (step.onFoot && player?.car);
  if (wrongState) {
    mission.progress = (mission.step + (step.needCar ? 0.15 : 0.25)) / mission.steps.length;
    return;
  }

  const gap = distanceTo(step, player);
  const radius = step.radius ?? REACH_RADIUS;
  const near = Number.isFinite(gap) ? clamp(1 - gap / 900, 0, 1) : 0;

  if (step.kind === 'evade') {
    const clear = !Number.isFinite(world.wanted) || world.wanted < 0.15;
    mission.progress = (mission.step + (clear ? 0.6 : 0.25) + near * 0.4) / mission.steps.length;
    if (mission.t < 3) return;                       // let the alarm land first
    if (gap <= radius && clear) mission.hold += dt;
    else mission.hold = 0;
    if (mission.hold >= (step.hold ?? 1)) completeStep(state, world);
    return;
  }

  mission.progress = (mission.step + near) / mission.steps.length;
  if (step.kind === 'vehicle') {
    if (player?.car) completeStep(state, world);
    return;
  }
  if (gap <= radius) mission.hold += dt;
  else mission.hold = 0;
  if (gap <= radius && mission.hold >= (step.hold ?? 0)) completeStep(state, world);
}

function updateTail(state, world, step, dt) {
  const mission = state.current;
  const player = world.player;
  updateActor(mission, world, dt);

  const gap = distanceTo(mission.actor, player);
  const reach = step.radius ?? 52;
  const escape = step.escape ?? 560;
  if (gap > escape) return failMission(state, world, 'target-escaped');

  mission.progress = (mission.step + clamp(1 - gap / escape, 0, 1)) / mission.steps.length;
  if (gap <= reach) mission.hold += dt;
  else mission.hold = Math.max(0, mission.hold - dt * 1.5);
  if (gap <= reach && mission.hold >= (step.hold ?? 2)) completeStep(state, world);
}

/* Courier AI: run away from the player with a slow hydraulic swerve and
 * bounce off the map edges instead of leaving the world. */
function updateActor(mission, world, dt) {
  const actor = mission.actor;
  if (!actor) return;
  const player = world.player;

  let ax = actor.dx;
  let ay = actor.dy;
  if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
    ax = actor.x - player.x;
    ay = actor.y - player.y;
  }
  const len = Math.hypot(ax, ay) || 1;
  const sway = Math.sin(mission.t * 1.7) * 0.45;
  const cos = Math.cos(sway);
  const sin = Math.sin(sway);
  const sx = (ax / len) * cos - (ay / len) * sin;
  const sy = (ax / len) * sin + (ay / len) * cos;

  const turn = clamp(dt * 2.6, 0, 1);
  actor.dx += (sx - actor.dx) * turn;
  actor.dy += (sy - actor.dy) * turn;
  const norm = Math.hypot(actor.dx, actor.dy) || 1;
  actor.dx /= norm;
  actor.dy /= norm;
  actor.heading = Math.atan2(actor.dy, actor.dx);
  const speed = actor.speed * (player && distanceTo(actor, player) < 150 ? 1.08 : 1);
  actor.x += actor.dx * speed * dt;
  actor.y += actor.dy * speed * dt;

  const margin = 70;
  const w = Number.isFinite(world?.city?.width) ? world.city.width : MAP_W;
  const h = Number.isFinite(world?.city?.height) ? world.city.height : MAP_H;
  if (actor.x < margin) { actor.x = margin; actor.dx = Math.abs(actor.dx); }
  if (actor.x > w - margin) { actor.x = w - margin; actor.dx = -Math.abs(actor.dx); }
  if (actor.y < margin) { actor.y = margin; actor.dy = Math.abs(actor.dy); }
  if (actor.y > h - margin) { actor.y = h - margin; actor.dy = -Math.abs(actor.dy); }
}

/* --- step / mission resolution ------------------------------------ */

function completeStep(state, world) {
  const mission = state.current;
  mission.step += 1;
  mission.hold = 0;

  if (mission.step >= mission.steps.length) return completeMission(state, world);

  const next = mission.steps[mission.step];
  if (next.followActor && mission.actor) {
    next.x = mission.actor.x;
    next.y = mission.actor.y;
  }
  pushEvent(state, {
    type: 'step', id: mission.id, name: mission.name,
    step: mission.step + 1, steps: mission.steps.length, text: next.text,
  });
  say(state, next.line);
}

function completeMission(state, world) {
  const mission = state.current;
  if (!mission) return;

  const base = Number.isFinite(mission.payout) ? mission.payout : 0;

  /* A timed job pays a speed bonus on top: up to half the base again for
   * arriving with the whole clock to spare, nothing for scraping in. */
  let bonus = 0;
  if (mission.timed && mission.timeLimit > 0) {
    const spare = clamp(1 - mission.t / mission.timeLimit, 0, 1);
    bonus = Math.round(base * 0.5 * spare);
  }

  const payout = base + bonus;
  const player = world?.player;
  if (player) player.money = (Number.isFinite(player.money) ? player.money : 0) + payout;

  state.jobsDone += 1;
  state.earned += payout;
  say(state, mission.signoff);
  closeMission(state, { ok: true, payout, bonus, text: `${mission.name} cleared` });
}

function failMission(state, world, reason) {
  const mission = state.current;
  if (!mission) return;
  state.failures += 1;
  closeMission(state, { ok: false, reason, text: `${mission.name} failed: ${reason}` });
  void world;
}

/* Shared teardown: record the result, emit the event, clear the slot and
 * start the between-jobs cooldown. */
function closeMission(state, result) {
  const { id, name } = state.current;
  const entry = { id, name, ok: result.ok, t: Math.round(state.time) };
  if (result.ok) {
    entry.payout = result.payout;
    if (result.bonus) entry.bonus = result.bonus;
  } else entry.reason = result.reason;

  state.lastResult = entry;
  record(state, entry);
  pushEvent(state, { type: result.ok ? 'complete' : 'fail', ...entry, text: result.text });

  state.current = null;
  state.cooldownT = state.cooldown;
}

function record(state, entry) {
  state.history.unshift(entry);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
}

function isWasted(player) {
  if (!player) return false;
  if (player.down === true) return true;
  return Number.isFinite(player.health) && player.health <= 0;
}

/* --- HUD + renderer glue ------------------------------------------ */

function pushEvent(state, event) {
  state.events.push(event);
}

/* Mirror the two fields hud.js reads straight off the world. */
function syncWorld(state, world) {
  if (!world) return;
  world.jobsDone = state.jobsDone;
  world.objective = objectiveFor(state);
}

function objectiveFor(state) {
  const mission = state.current;
  if (!mission) return null;
  const step = mission.steps[mission.step];
  if (!step) return null;
  const point = pointOf(mission) ?? step;

  return {
    title: mission.name, pay: mission.payout,
    detail: step.detail ?? step.text ?? '',
    x: point.x, y: point.y,
    progress: clamp(mission.progress, 0, 1),
    step: mission.step + 1, steps: mission.steps.length,
    timeLeft: Math.max(0, mission.timeLimit - mission.t),
    timed: mission.timed === true,
    free: mission.free === true,
  };
}

/* The objective block for the HUD, or null between jobs. Thin wrapper so a
 * caller does not have to reach into state to read the same shape hud.js
 * gets mirrored onto the world. */
export function getObjective(state) {
  return objectiveFor(state);
}

/*
 * Put the job board back to the top of the story with no active job. The
 * counters reset too, because "reset" in a HUD means a new run, not a pause
 * — `earned` and `history` are the record of the run that just ended.
 */
export function resetMissions(state) {
  if (!state) return null;
  state.storyIndex = 0;
  state.mode = 'story';
  state.current = null;
  state.jobsDone = 0;
  state.failures = 0;
  state.earned = 0;
  state.time = 0;
  state.cooldownT = 0;
  state.lastResult = null;
  state.history.length = 0;
  state.lines.length = 0;
  state.events.length = 0;
  return state;
}

/* World-space marker for render.js: where to draw, how far the player is. */
export function marker(state, world) {
  const mission = state?.current;
  if (!mission) return null;
  const step = mission.steps[mission.step];
  const point = pointOf(mission);
  if (!step || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

  return {
    x: point.x, y: point.y,
    distance: distanceTo(point, world?.player),
    radius: step.radius ?? REACH_RADIUS,
    /* render.js drawMarker reads title ?? label plus pay; keep both so the
     * gold pin shows the job name and its payout. */
    title: mission.name, label: mission.name, pay: mission.payout,
    payout: mission.payout, kind: step.kind,
    step: mission.step + 1, steps: mission.steps.length,
  };
}

function distanceTo(point, player) {
  if (!point || !player) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) return Number.POSITIVE_INFINITY;
  return Math.hypot(point.x - player.x, point.y - player.y);
}
