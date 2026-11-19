// Solmar's tuning sheet. Every length, speed, hue and storage slot the game leans on lives in this
// one file, so the whole seaside can be rebalanced without opening a system module. Distances are
// world pixels rather than screen pixels, and every rate is per second unless a comment says
// otherwise.
//
// The numbers below describe a particular town: square blocks on a regular grid, each pair separated
// by a two-way street. Past the last column the grid gives way to a promenade, then sand, then a pier
// reaching out over the water. Because all of that is derived from this grid, no other module ever
// writes a street coordinate by hand.

/** The simulation advances in fixed slices of this length: sixty ticks to the second. */
export const STEP = 1 / 60;

/** The longest stretch of real time one frame may replay, so a backgrounded tab cannot spiral. */
export const MAX_FRAME = 0.25;

/** The single font stack used by the HUD, the menus and the title card. */
export const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", sans-serif';

/**
 * Map layout. `block` is one paved square, `road` the asphalt between two of them, so neighbouring
 * blocks sit block + road apart; `sidewalk` is the walking ring drawn inside a block. East of the
 * grid, `beachWidth` of sand is followed by `waterWidth` of open sea.
 */
export const CITY = {
  seed: 1979,
  cols: 7,
  rows: 5,
  block: 250,
  road: 86,
  sidewalk: 20,
  beachWidth: 300,
  waterWidth: 1400,
};

/**
 * On foot. `accel` is the easing rate that pulls the body towards its target velocity (a larger
 * number grabs it faster); `turnRate` is how quickly the body swings round to face where it moves.
 */
export const PLAYER = {
  radius: 10,
  walkSpeed: 170,
  runSpeed: 272,
  accel: 14,
  turnRate: 18,
  maxHealth: 100,
};

/**
 * Driving. A car is a long rectangle, hence both `length` and `width`. The brakes bite harder than
 * the engine pulls, reverse is the weaker of the two gears, and `drag` is the fraction of speed
 * still carried after a second with the throttle shut.
 */
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
};

/**
 * Computer-driven traffic. `lane` is the distance from a street's centre line to the middle of a
 * lane, which is what keeps opposing cars from meeting head-on; the two speeds bracket the cruise.
 */
export const TRAFFIC = {
  count: 26,
  lane: 21,
  minSpeed: 128,
  maxSpeed: 188,
  turnRate: 4.2,
};

/** Pedestrians: how many bodies share the block rings, the promenade and the pier. */
export const PEDS = { count: 54 };

/**
 * How the camera feels. `follow` eases the view towards its target, `lookAhead` leans it along the
 * player's heading, the two zoom levels blend at `zoomRate`, and `shakeDecay` bleeds off impacts.
 */
export const CAMERA = {
  follow: 4.5,
  lookAhead: 26,
  zoomFoot: 1,
  zoomCar: 0.84,
  zoomRate: 2.6,
  shakeDecay: 5.5,
};

/** The one localStorage slot, plus how many seconds on foot pass between autosaves. */
export const SAVE = { key: 'solmar.save.v1', autosave: 20 };

/**
 * The palette: ground and road markings first, then vegetation, sand and sea, then the HUD's chrome.
 * Flat and deliberately low on saturation, so the lifted building roofs still read from above.
 */
export const COLORS = {
  sky: '#8ec9cf',
  asphalt: '#3d424b',
  asphaltDark: '#34383f',
  asphaltLight: '#474d57',
  line: '#e7e1cf',
  lineWarm: '#e3c367',
  sidewalk: '#c2bbac',
  sidewalkAlt: '#b7b0a1',
  sidewalkLine: '#a49d8e',
  curb: '#8d8678',
  courtyard: '#cbc4b3',
  grass: '#79a663',
  grassDark: '#5f8d4e',
  grassLight: '#8db772',
  path: '#dbd1b7',
  sand: '#e8d0a6',
  sandDark: '#d6bd90',
  sandLight: '#f2e0bd',
  wetSand: '#cbb287',
  waterDeep: '#145a75',
  waterMid: '#227f9b',
  waterShallow: '#54b7c2',
  foam: '#eff9f6',
  shadow: 'rgba(24, 26, 33, 0.22)',
  panel: 'rgba(14, 22, 28, 0.72)',
  panelEdge: 'rgba(255, 248, 230, 0.16)',
  cream: '#f7f1e2',
  muted: '#a9b3b8',
  gold: '#f2c75c',
  green: '#7fd08a',
  red: '#e8665b',
};

/** Car paint, drawn from when traffic is built and again when the kerbs are filled. */
export const CAR_COLORS = [
  '#d9604c',
  '#2f7f8f',
  '#e8c25a',
  '#f1eee4',
  '#7b8fb0',
  '#c96a9b',
  '#4e6b50',
  '#e8955a',
  '#5a6068',
  '#a9453c',
  '#3d6f9e',
  '#d8d2c0',
];

/** Shirt colours for the crowd. Skin tones are a separate list, so the two can never collide. */
export const PED_SHIRTS = [
  '#e8604c',
  '#2f7f8f',
  '#e8c25a',
  '#f1eee4',
  '#7b8fb0',
  '#c96a9b',
  '#4e6b50',
  '#e8955a',
  '#8a5f3c',
  '#5a6068',
];

/** Skin tones, pale through deep. */
export const PED_SKINS = ['#e8bc93', '#d8a273', '#b97f52', '#8d5a37', '#f0cead', '#6f4529'];

/**
 * Wall and roof pairs. A block mostly builds in a single style so its street frontage reads as one
 * piece, with the odd mismatched plot thrown in for variety.
 */
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
