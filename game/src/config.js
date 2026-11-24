/*
 * Solmar — tunable constants for the coastal town game.
 *
 * Layout of this file:
 *   1. simulation loop & typography
 *   2. difficulty presets (DIFFICULTIES, DEFAULT_DIFFICULTY, resolveDifficulty)
 *   3. world generation (CITY) and population (TRAFFIC, PEDS)
 *   4. actors: PLAYER, VEHICLE
 *   5. systems: POLICE, COMBAT, MISSIONS, AUDIO
 *   6. presentation: CAMERA, COLORS and palettes, BUILDING_STYLES
 *   7. persistence: SAVE
 *   8. derived constants: WORLD, WANTED, RADII, SPEEDS, TIMING_MS
 *   9. render quality presets (QUALITY_PRESETS, resolveQuality)
 *
 * The town itself is a 7 x 5 grid of blocks (35 blocks, ~101 buildings),
 * generated deterministically from CITY.seed.
 *
 * Everything below is plain data. The difficulty presets do not mutate the
 * base constants: resolveDifficulty() returns a derived view that the systems
 * can consume, so switching presets at runtime never leaks into the defaults.
 *
 * Sections 8 and 9 are additive only: they read the tuning above and expose
 * convenience views (map extents, heat thresholds, ms timings, quality
 * presets). Nothing in the game imports them yet, so importing this file
 * behaves exactly as before.
 */

/* ------------------------------------------------------------------ */
/* 1. simulation loop & typography                                     */
/* ------------------------------------------------------------------ */
/* Fixed-step sim timing, frame catch-up limits, the canvas coordinate
 * space, and the UI typeface. Nothing here knows about game content. */

// Fixed timestep for the physics/update step (seconds).
export const STEP = 1 / 60;

// Longest frame we integrate at once; caps catch-up after tab stalls.
export const MAX_FRAME = 0.25;

// Hard ceiling for the accumulator; beyond this we drop the backlog.
export const MAX_CATCHUP_STEPS = 8;

export const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", sans-serif';

// Canvas coordinate space the renderer lays out against.
export const VIEW = {
  width: 1280,
  height: 720,
  dprCap: 2,          // never render above 2x device pixel ratio
};

/* ------------------------------------------------------------------ */
/* 2. difficulty presets                                               */
/* ------------------------------------------------------------------ */

/*
 * DIFFICULTIES — multipliers applied on top of the base tuning.
 *
 *   playerHealth     multiplier on PLAYER.maxHealth
 *   damageTaken      multiplier on incoming damage (higher = harsher)
 *   policeResponse   multiplier on cruiser speed / accel / spawn rate
 *   policeHeatGain   multiplier on heat added per crime
 *   policeHeatDecay  multiplier on POLICE.heatDecay
 *   missionPay       multiplier on MISSIONS payouts
 *   ammoReserve      multiplier on starting reserve ammo
 *   trafficDensity   multiplier on TRAFFIC.count
 *   timeScale        multiplier on mission par times
 *   noFailGrace      extra seconds granted before a "wasted" state at 0 hp
 */
export const DIFFICULTIES = {
  santai: {
    label: 'Santai',
    blurb: 'Untuk santai menyusuri pesisir. Polisi lambat, dompet tebal.',
    playerHealth: 1.5,
    damageTaken: 0.6,
    policeResponse: 0.75,
    policeHeatGain: 0.7,
    policeHeatDecay: 1.6,
    missionPay: 0.9,
    ammoReserve: 2,
    trafficDensity: 0.8,
    timeScale: 1.35,
    noFailGrace: 6,
  },
  normal: {
    label: 'Normal',
    blurb: 'Nada dasar permainan. Semua pengali netral.',
    playerHealth: 1,
    damageTaken: 1,
    policeResponse: 1,
    policeHeatGain: 1,
    policeHeatDecay: 1,
    missionPay: 1,
    ammoReserve: 1,
    trafficDensity: 1,
    timeScale: 1,
    noFailGrace: 0,
  },
  keras: {
    label: 'Keras',
    blurb: 'Polisi agresif, bala bantuan cepat, bayaran lebih besar.',
    playerHealth: 0.75,
    damageTaken: 1.45,
    policeResponse: 1.3,
    policeHeatGain: 1.35,
    policeHeatDecay: 0.65,
    missionPay: 1.4,
    ammoReserve: 0.6,
    trafficDensity: 1.25,
    timeScale: 0.8,
    noFailGrace: 0,
  },
  insane: {
    label: 'Insane',
    blurb: 'Satu kesalahan = wasted. Polisi tak kenal lelah, amunisi minim, bayaran setengah.',
    playerHealth: 0.5,
    damageTaken: 2.0,
    policeResponse: 1.7,
    policeHeatGain: 1.7,
    policeHeatDecay: 0.4,
    missionPay: 0.5,
    ammoReserve: 0.4,
    trafficDensity: 1.5,
    timeScale: 0.6,
    noFailGrace: 0,
  },
};

export const DEFAULT_DIFFICULTY = 'normal';

export const DIFFICULTY_ORDER = ['santai', 'normal', 'keras', 'insane'];

/*
 * resolveDifficulty(name) -> { name, ...preset, police, player, missions }
 *
 * Returns a fresh object: base constants are read, never written. Unknown
 * names fall back to DEFAULT_DIFFICULTY so a corrupt save cannot crash boot.
 */
export function resolveDifficulty(name = DEFAULT_DIFFICULTY) {
  const key = Object.prototype.hasOwnProperty.call(DIFFICULTIES, name) ? name : DEFAULT_DIFFICULTY;
  const p = DIFFICULTIES[key];

  return {
    ...p,
    name: key,
    player: {
      ...PLAYER,
      maxHealth: Math.round(PLAYER.maxHealth * p.playerHealth),
    },
    police: {
      ...POLICE,
      chaseSpeedBase: POLICE.chaseSpeedBase * p.policeResponse,
      chaseAccel: POLICE.chaseAccel * p.policeResponse,
      heatDecay: POLICE.heatDecay * p.policeHeatDecay,
      unitSpawnDelay: POLICE.unitSpawnDelay / p.policeResponse,
      searchTime: POLICE.searchTime * (2 - p.policeResponse),
    },
    missions: {
      ...MISSIONS,
      deliveryPay: Math.round(MISSIONS.deliveryPay * p.missionPay),
      chasePay: Math.round(MISSIONS.chasePay * p.missionPay),
      escortPay: Math.round(MISSIONS.escortPay * p.missionPay),
      heistPay: Math.round(MISSIONS.heistPay * p.missionPay),
      bountyPay: Math.round(MISSIONS.bountyPay * p.missionPay),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. world generation & population                                    */
/* ------------------------------------------------------------------ */
/* CITY shapes the procedural map; TRAFFIC and PEDS size the ambient
 * life that fills it. All three are read-only inputs to the generators. */

export const CITY = {
  seed: 1979,        // everything procedural hangs off this
  cols: 7,
  rows: 5,
  block: 250,        // block edge length
  road: 86,          // road corridor width
  sidewalk: 20,      // sidewalk band on each side of a road
  beachWidth: 300,
  waterWidth: 1400,  // ocean strip beyond the sand
  // derived-ish helpers used by the generator
  lotInset: 18,      // gap kept between a lot edge and its building
  alleyChance: 0.18, // share of blocks that get a service alley
  parkChance: 0.14,  // share of blocks turned into a pocket park
  maxBuildingHeight: 96,
  minBuildingHeight: 34,
};

/* Pelabuhan Tua (Old Port) district constants — used by city.js for the
 * western coastal district with pier, lighthouse, and warehouse buildings. */
export const PORT_DISTRICT = {
  name: 'Pelabuhan Tua',
  cols: 1,           // occupies the leftmost column (c = 0)
  dockDepth: 300,    // how far the pier extends into water
  warehouseHeight: 72,
  craneCount: 3,
  lighthouseHeight: 120,
  lighthouseRange: 1800,
  fogDensity: 0.35,
};

export const TRAFFIC = {
  count: 26,         // ambient cars alive at once
  lane: 21,          // lane offset from road centre
  minSpeed: 128,
  maxSpeed: 188,
  turnRate: 4.2,     // radians per second at intersections
  // behaviour flavour
  reactionTime: 0.45,   // seconds of delay before braking for an obstacle
  followGap: 46,        // preferred bumper-to-bumper distance
  hornChance: 0.12,     // per encounter with a blocked lane
  despawnDistance: 1500,
  playerYieldBias: 0.7, // how eagerly ambient cars give way to the player
};

export const PEDS = {
  count: 54,
  walkSpeedMin: 52,
  walkSpeedMax: 96,
  panicSpeed: 210,
  panicRadius: 190,   // how close a scare has to be to trigger fleeing
  panicTime: 7,       // seconds of fleeing after a scare
  sidewalkBias: 0.82, // chance a ped keeps to the pavement
};

/* ------------------------------------------------------------------ */
/* 4. actors                                                           */
/* ------------------------------------------------------------------ */
/* PLAYER is the on-foot avatar; VEHICLE is the shared car profile used
 * by both ambient traffic and anything the player drives. */

export const PLAYER = {
  radius: 10,
  walkSpeed: 170,
  runSpeed: 272,
  accel: 14,
  turnRate: 18,
  maxHealth: 100,
  regenDelay: 12,     // seconds after damage before health ticks back
  regenRate: 2.5,     // health per second once regeneration starts
  staminaMax: 100,
  staminaDrain: 14,   // per second while sprinting
  staminaRegen: 9,    // per second while walking or idle
  interactRange: 44,
};

export const VEHICLE = {
  length: 56,
  width: 26,
  accel: 315,
  brake: 520,
  reverseAccel: 215,
  reverseMax: 135,
  maxSpeed: 325,
  turnRate: 2.05,
  handbrake: 760,
  drag: 0.95,
  // grip / feel
  gripRoad: 1,
  gripSand: 0.55,
  gripWet: 0.78,
  driftYawBoost: 1.35,   // extra yaw while the handbrake is held
  driftRecovery: 3.2,    // how fast lateral slip is bled off
  engineIdle: 0.12,      // normalised throttle floor for audio pitch
  crashSpeedLoss: 0.45,  // share of speed kept after a hard impact
  explodesAt: 0.08,      // hull fraction below which the car burns
};

/* ------------------------------------------------------------------ */
/* 5. systems                                                          */
/* ------------------------------------------------------------------ */
/* Long-lived gameplay systems. POLICE, COMBAT and MISSIONS each carry
 * their own tuning plus per-system sub-objects (heat gain, pay weights). */

/*
 * POLICE — wanted-level behaviour.
 * heat runs 0..100 and maps onto levels 1..5; a level is reached at
 * every 20 points of heat. Heat decays by heatDecay per second once the
 * player has been unseen for calmDelay seconds.
 *
 * Response tuning lives here; the difficulty presets scale the numbers
 * rather than replacing them.
 */
export const POLICE = {
  maxLevel: 5,
  minLevel: 1,
  heatPerLevel: 20,          // heat needed for each additional star
  heatMax: 100,
  heatDecay: 4.5,            // heat lost per second while cooling down
  calmDelay: 6,              // seconds out of sight before heat drops
  chaseSpeedBase: 240,       // cruiser speed at level 1
  chaseSpeedPerLevel: 26,    // added per extra wanted level
  chaseAccel: 340,
  radioRange: 620,           // how far a cruiser will radio for backup
  spawnDistanceMin: 520,     // cruisers appear no closer than this
  spawnDistanceMax: 900,
  maxUnits: 8,
  unitSpawnDelay: 1.4,       // seconds between backup arrivals
  ramDistance: 70,           // distance at which a cruiser tries to ram
  searchTime: 22,            // seconds spent searching after losing sight
  // --- response tuning ---
  aggression: 1,             // global multiplier on pursuit pressure
  sirenRange: 240,           // audible siren radius in world units
  sightRange: 460,           // cruiser vision radius while patrolling
  sightRangeChasing: 720,    // vision radius once a pursuit is live
  loseSightGrace: 5,         // seconds of broken LOS before falling back
  pitDistance: 46,           // lateral proximity that triggers a PIT attempt
  ramCooldown: 3.5,          // seconds between ram attempts per unit
  roadblockLevel: 3,         // wanted level at which roadblocks unlock
  spikeStripLevel: 4,        // wanted level at which spike strips unlock
  helicopterLevel: 5,        // wanted level at which air support appears
  helicopterDelay: 14,       // seconds from five stars to air support
  bribeAmount: 500,          // cost per star to clear via a fixer
  bribeCooldown: 45,         // seconds before the same fixer can be reused
  heatGain: {                // heat added per infraction
    bump: 6,
    hitPed: 22,
    gunshot: 14,
    stealCar: 18,
    propertyDamage: 8,
    missionAlarm: 12,
  },
};

/*
 * COMBAT — melee and sidearm.
 * All distances are world units, all timings are seconds.
 */
export const COMBAT = {
  punchDamage: 12,
  punchRange: 34,
  punchCooldown: 0.42,
  punchKnockback: 120,
  punchStamina: 6,
  pistolDamage: 34,
  pistolRange: 520,
  pistolFalloff: 0.55,       // damage multiplier at max range
  pistolCooldown: 0.55,
  pistolSpread: 0.035,       // radians of random deviation per shot
  pistolAmmo: 12,            // magazine size
  pistolReserve: 96,
  pistolReload: 1.6,
  meleeArmorPierce: 0.25,    // share of armour a punch ignores
  bulletPenetration: 1,      // bodies a shot can pass through
  muzzleFlashLife: 0.07,     // seconds the flash is drawn
  muzzleFlashLength: 18,     // pixels the flash extends past the barrel
  hitFlashLife: 0.12,
  hitStagger: 0.22,          // seconds an unarmoured target is stunned
  deathFade: 2.4,            // seconds a body lingers before cleanup
};

/*
 * MISSIONS — payouts and reward shaping.
 *
 * Pay values are the base figure; the difficulty preset scales them, and
 * each mission type carries its own multipliers for the shared bonuses
 * (no-damage, no-kill, streak) so a heist pays more for a clean run than a
 * delivery does.
 */
export const MISSIONS = {
  // base payout per mission, in dollars
  deliveryPay: 450,
  chasePay: 900,
  escortPay: 1200,
  heistPay: 2500,
  bountyPay: 750,
  timeBonus: 150,            // added when finished under par time

  // reward shaping
  cleanRunBonus: 200,        // no civilian casualties
  noDamageBonus: 300,        // finish at full-ish health
  noDamageThreshold: 0.9,    // share of max health that still counts clean
  streakBonusStep: 100,      // added per consecutive mission, capped below
  streakBonusCap: 600,
  firstTryBonus: 250,        // cleared a mission without a retry
  collectibleValue: 125,     // per pickup found mid-mission
  tipPercent: 0.08,          // share of payout the handler keeps... or gives

  // per-type multipliers on the shared bonuses
  payWeights: {
    delivery: 1,
    chase: 1.15,
    escort: 1.25,
    heist: 1.6,
    bounty: 1.1,
  },

  // cooldowns & availability
  cooldown: 25,              // seconds between mission offers
  maxActive: 3,              // concurrent accepted missions
  retryPenalty: 0.15,        // share of payout lost per failed attempt
  parTime: {                 // seconds; par time per mission type
    delivery: 120,
    chase: 150,
    escort: 180,
    heist: 300,
    bounty: 210,
  },
};

export const AUDIO = {
  masterVolume: 0.9,
  musicVolume: 0.45,
  sfxVolume: 0.7,
  uiVolume: 0.55,
  musicFade: 1.2,            // seconds to fade a track in or out
  enginePitchRange: 0.6,     // pitch span from idle to redline
  engineBasePitch: 0.85,     // pitch at idle
  tyreSquealPitch: 1.35,
  sirenPitch: 1.6,
  maxVoices: 24,             // concurrent one-shots before oldest is stolen
  doppler: 0.35,             // pitch shift strength for passing sources
  lowpassSpeed: 8,           // how fast the speed-based filter tracks
  distanceRolloff: 1.4,      // attenuation curve exponent
  // named buses so systems do not sprinkle magic strings
  buses: {
    master: 'master',
    music: 'music',
    sfx: 'sfx',
    ui: 'ui',
    ambience: 'ambience',
    voice: 'voice',
  },
  duckDepth: 0.4,            // music attenuation while dialogue plays
  duckFade: 0.25,
};

/* ------------------------------------------------------------------ */
/* 6. presentation                                                     */
/* ------------------------------------------------------------------ */
/* Camera feel, the flat colour palette, and the palettes handed to the
 * generators (cars, pedestrians, emergency liveries, buildings). */

export const CAMERA = {
  follow: 4.5,       // damping lambda for the chase position
  lookAhead: 26,     // lead distance in the travel direction
  zoomFoot: 1,
  zoomCar: 0.84,
  zoomRate: 2.6,
  shakeDecay: 5.5,
  // feel
  shakeImpact: 0.6,       // shake magnitude per unit of impact speed
  shakeMax: 22,           // clamp so a pile-up cannot blow out the frame
  boundsPadding: 120,     // how far past the map edge the camera may slide
  speedZoom: 0.08,        // extra zoom-out at top speed
  lookAheadSpeed: 0.35,   // look-ahead growth with speed
};

export const COLORS = {
  // sky & atmosphere
  sky: '#8ec9cf',
  skyLow: '#bcdedb',
  sun: '#fff4d6',
  // road surface
  asphalt: '#3d424b',
  asphaltDark: '#34383f',
  asphaltLight: '#474d57',
  line: '#e7e1cf',
  lineWarm: '#e3c367',
  // pedestrian surfaces
  sidewalk: '#c2bbac',
  sidewalkAlt: '#b7b0a1',
  sidewalkLine: '#a49d8e',
  curb: '#8d8678',
  courtyard: '#cbc4b3',
  // greenery & paths
  grass: '#79a663',
  grassDark: '#5f8d4e',
  grassLight: '#8db772',
  path: '#dbd1b7',
  // beach & ocean
  sand: '#e8d0a6',
  sandDark: '#d6bd90',
  sandLight: '#f2e0bd',
  wetSand: '#cbb287',
  waterDeep: '#145a75',
  waterMid: '#227f9b',
  waterShallow: '#54b7c2',
  foam: '#eff9f6',
  // ui
  shadow: 'rgba(24, 26, 33, 0.22)',
  panel: 'rgba(14, 22, 28, 0.72)',
  panelEdge: 'rgba(255, 248, 230, 0.16)',
  cream: '#f7f1e2',
  muted: '#a9b3b8',
  gold: '#f2c75c',
  green: '#7fd08a',
  red: '#e8665b',
  // state colours (wanted level, damage, objectives)
  blue: '#6fa8dc',
  purple: '#a98bd6',
  orange: '#e89a4a',
  ink: '#12181d',
};

export const CAR_COLORS = [
  '#d9604c', '#2f7f8f', '#e8c25a', '#f1eee4', '#7b8fb0', '#c96a9b',
  '#4e6b50', '#e8955a', '#5a6068', '#a9453c', '#3d6f9e', '#d8d2c0',
];

// Heavier, rarer palette used for police / emergency liveries.
export const EMERGENCY_COLORS = {
  cruiser: '#1d2a3a',
  cruiserAccent: '#f2f2f0',
  lightBarRed: '#e5423a',
  lightBarBlue: '#3f7fe0',
  ambulance: '#f3f1e8',
  fire: '#b8322a',
};

export const PED_SHIRTS = [
  '#e8604c', '#2f7f8f', '#e8c25a', '#f1eee4', '#7b8fb0', '#c96a9b',
  '#4e6b50', '#e8955a', '#8a5f3c', '#5a6068',
];

export const PED_SKINS = ['#e8bc93', '#d8a273', '#b97f52', '#8d5a37', '#f0cead', '#6f4529'];

export const BUILDING_STYLES = [
  { wall: '#c8785d', roof: '#a95f48' },
  { wall: '#e5dcc6', roof: '#c9bda3' },
  { wall: '#9fbcae', roof: '#82a294' },
  { wall: '#d9a851', roof: '#b98a3a' },
  { wall: '#8b9aad', roof: '#6e7d90' },
  { wall: '#d99a94', roof: '#b97b76' },
  { wall: '#d8c49b', roof: '#b8a276' },
  { wall: '#a9a2b8', roof: '#8c859e' },
];

/* ------------------------------------------------------------------ */
/* 7. persistence                                                      */
/* ------------------------------------------------------------------ */
/* Save slot identity and limits. The key is versioned: bump the suffix
 * when the payload shape changes and add the old key to migrateFrom. */

export const SAVE = {
  key: 'solmar.save.v1',
  autosave: 20,   // seconds between automatic saves
  version: 1,
  slots: 3,
  compress: true,        // gzip the payload before writing
  maxSizeKb: 512,        // refuse to write beyond this
  migrateFrom: ['solmar.save.v0'],
};

/* ------------------------------------------------------------------ */
/* 8. derived constants                                                */
/* ------------------------------------------------------------------ */
/*
 * Everything in this section is COMPUTED from the tuning above; none of it
 * is a second source of truth. Change CITY or POLICE and these follow.
 *
 * They exist so callers do not re-derive the same geometry by hand (city.js
 * computes the identical pitch / mapW / mapH locally, hud.js re-derives the
 * extents from the world object). Use these when a module only needs the
 * numbers, not the generated world.
 */

// One city block plus the road that separates it from the next.
export const BLOCK_PITCH = CITY.block + CITY.road;

/*
 * WORLD — the playable rectangle plus the coastline that borders it.
 *
 *   width/height   built-up map only (matches city.js width/height)
 *   shoreline      x where sand ends and the ocean begins
 *   totalWidth     map + beach + ocean, useful for clamp/extent math
 *   centre         middle of the built-up map
 *   blockCount     number of blocks the generator will produce
 */
export const WORLD = Object.freeze({
  width: CITY.cols * BLOCK_PITCH + CITY.road,
  height: CITY.rows * BLOCK_PITCH + CITY.road,
  shoreline: CITY.cols * BLOCK_PITCH + CITY.road + CITY.beachWidth,
  totalWidth: CITY.cols * BLOCK_PITCH + CITY.road + CITY.beachWidth + CITY.waterWidth,
  centre: Object.freeze({
    x: (CITY.cols * BLOCK_PITCH + CITY.road) / 2,
    y: (CITY.rows * BLOCK_PITCH + CITY.road) / 2,
  }),
  blockCount: CITY.cols * CITY.rows,
});

/*
 * WANTED — heat bookkeeping distilled from POLICE.
 *
 *   levels        how many wanted stars exist
 *   perLevel      heat needed to gain one star
 *   capacity      heat ceiling
 *   thresholds    heat at which each level caps out, index 0..levels-1 —
 *                 level n holds while heat <= thresholds[n - 1] (police.js
 *                 uses ceil(heat / heatPerLevel), so 20 is still level 1)
 *   heatForLevel(n) heat required to reach level n (clamped to range)
 */
export const WANTED = Object.freeze({
  levels: POLICE.maxLevel - POLICE.minLevel + 1,
  perLevel: POLICE.heatPerLevel,
  capacity: POLICE.heatMax,
  thresholds: Object.freeze(
    Array.from({ length: POLICE.maxLevel }, (_, i) => (i + 1) * POLICE.heatPerLevel),
  ),
  heatForLevel(level) {
    const clamped = Math.min(Math.max(level, POLICE.minLevel), POLICE.maxLevel);
    return clamped * POLICE.heatPerLevel;
  },
});

/*
 * RADII — common engagement distances, gathered so a system can answer
 * "is this thing close enough to matter?" without importing three modules.
 */
export const RADII = Object.freeze({
  interact: PLAYER.interactRange,          // press-to-use reach
  punch: COMBAT.punchRange,                // melee reach
  pistol: COMBAT.pistolRange,              // sidearm reach
  panic: PEDS.panicRadius,                 // pedestrians scatter inside this
  siren: POLICE.sirenRange,                // siren audible range
  sight: POLICE.sightRange,                // patrol vision
  sightChasing: POLICE.sightRangeChasing,  // pursuit vision
  ram: POLICE.ramDistance,                 // cruiser commits to a ram here
  radio: POLICE.radioRange,                // backup call range
  spawnMin: POLICE.spawnDistanceMin,       // backup cannot appear closer
  spawnMax: POLICE.spawnDistanceMax,
  despawn: TRAFFIC.despawnDistance,        // ambient car is recycled past this
});

/*
 * SPEEDS — world units per second, normalised into one place so UI can show
 * km/h without knowing which actor table the number came from.
 */
export const SPEEDS = Object.freeze({
  walk: PLAYER.walkSpeed,
  run: PLAYER.runSpeed,
  pedWalkMin: PEDS.walkSpeedMin,
  pedWalkMax: PEDS.walkSpeedMax,
  pedPanic: PEDS.panicSpeed,
  trafficMin: TRAFFIC.minSpeed,
  trafficMax: TRAFFIC.maxSpeed,
  vehicleMax: VEHICLE.maxSpeed,
  vehicleReverse: VEHICLE.reverseMax,
  // world units/second -> km/h, assuming one world unit is one metre
  toKmh(unitsPerSecond) {
    return unitsPerSecond * 3.6;
  },
});

/*
 * TIMING_MS — the handful of second-based timings that a DOM-side caller
 * needs in milliseconds (CSS transitions, setTimeout throttles). Values are
 * computed with Math.round so they stay idempotent under re-import.
 */
export const TIMING_MS = Object.freeze({
  step: Math.round(STEP * 1000),                  // 17
  autosave: Math.round(SAVE.autosave * 1000),
  hitStagger: Math.round(COMBAT.hitStagger * 1000),
  punchCooldown: Math.round(COMBAT.punchCooldown * 1000),
  pistolCooldown: Math.round(COMBAT.pistolCooldown * 1000),
  pistolReload: Math.round(COMBAT.pistolReload * 1000),
  deathFade: Math.round(COMBAT.deathFade * 1000),
  musicFade: Math.round(AUDIO.musicFade * 1000),
  missionCooldown: Math.round(MISSIONS.cooldown * 1000),
  unitSpawnDelay: Math.round(POLICE.unitSpawnDelay * 1000),
  bribeCooldown: Math.round(POLICE.bribeCooldown * 1000),
  regenDelay: Math.round(PLAYER.regenDelay * 1000),
});

/* ------------------------------------------------------------------ */
/* 9. render quality presets                                           */
/* ------------------------------------------------------------------ */
/*
 * QUALITY_PRESETS — additive render tiers, separate from DIFFICULTIES.
 *
 * Difficulty scales gameplay; quality scales what gets drawn. These are
 * presets only: nothing selects one at boot and no code reads DEFAULT_QUALITY
 * yet, so the renderer keeps its current behaviour exactly.
 *
 *   dprCap        hard cap on device pixel ratio (mirrors VIEW.dprCap)
 *   shadowBlur    multiplier on the soft-shadow radius
 *   particleScale share of ambient particles (foam, speckles) that spawn
 *   detailRadius  distance beyond which fine props are skipped
 *   targetFps     frame pacing hint for the presentation loop
 */
export const QUALITY_PRESETS = {
  low: {
    label: 'Low',
    blurb: 'Battery-friendly: fewer particles, flat shadows.',
    dprCap: 1,
    shadowBlur: 0,
    particleScale: 0.35,
    detailRadius: 700,
    targetFps: 30,
  },
  medium: {
    label: 'Medium',
    blurb: 'Default look on modest hardware.',
    dprCap: Math.min(1.5, VIEW.dprCap),
    shadowBlur: 0.6,
    particleScale: 0.7,
    detailRadius: 1100,
    targetFps: 60,
  },
  high: {
    label: 'High',
    blurb: 'Full detail, soft shadows, every particle.',
    dprCap: VIEW.dprCap,
    shadowBlur: 1,
    particleScale: 1,
    detailRadius: 1600,
    targetFps: 60,
  },
};

export const DEFAULT_QUALITY = 'high';

export const QUALITY_ORDER = ['low', 'medium', 'high'];

/*
 * resolveQuality(name) -> { name, ...preset, particleCount, shadowRadius }
 *
 * Same contract as resolveDifficulty: a fresh object derived from the preset
 * and the base constants, never a mutation. Unknown names fall back to
 * DEFAULT_QUALITY.
 */
export function resolveQuality(name = DEFAULT_QUALITY) {
  const key = Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, name) ? name : DEFAULT_QUALITY;
  const q = QUALITY_PRESETS[key];

  return {
    ...q,
    name: key,
    particleCount: Math.round(PEDS.count * q.particleScale),
    trafficCount: Math.round(TRAFFIC.count * q.particleScale),
    shadowRadius: Math.round(CAMERA.shakeMax * q.shadowBlur),
  };
}
