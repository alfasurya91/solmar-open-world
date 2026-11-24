/* City factory — builds the Solmar coast town from a seed.
 *
 * Layout: a 7 x 5 grid of blocks (35 blocks) on the mainland, a sand beach
 * and promenade along the east edge, and the ocean beyond. The grid is split
 * into three districts:
 *
 *   oldtown   (western columns) — low rise, warm plaster, awnings, tight
 *                                 parcels, narrow service alleys, market
 *                                 squares.
 *   downtown  (middle column)   — mid rise infill, mixed styles, a small
 *                                 civic core.
 *   modern    (eastern columns) — glass towers with setbacks, plazas and
 *                                 fountains facing the water.
 *
 * The town is deterministic: every placement is drawn from CITY.seed.
 * Everything is axis aligned and measured in world units, Y grows southwards.
 *
 * Exports: createCity(seed) -> city description consumed by the renderer and
 * the simulation code. Collision data lives in `colliders` (rectangles for
 * buildings and props, circles for posts/trees/fountains) plus the
 * convenience index `buildingColliders`.
 */

import { BUILDING_STYLES, CAR_COLORS, CITY, COLORS, PORT_DISTRICT } from './config.js';
import { createRandom } from './utils.js';

const AWNING_COLORS = ['#d9605c', '#3f8a7c', '#dfae56', '#7a89b5'];
const UMBRELLA_COLORS = ['#e2604f', '#f2c75c', '#3f8a9c', '#f1eee4'];
const TOWEL_COLORS = ['#e8887d', '#4f8fa0', '#e9c877', '#f3efe4', '#8fae86'];
const BOAT_COLORS = ['#f1eee4', '#2f7f8f', '#d9604c', '#d8d2c0', '#3d6f9e'];
const ALLEY = 12;
const BAY_W = 30;
const BAY_H = 54;

/* Warehouse style for Pelabuhan Tua — corrugated metal, large doors, rooftop
 * vents. Appended to BUILDING_STYLES so indices stay stable for existing code. */
const WAREHOUSE_STYLE = { wall: '#5a5248', roof: '#3d3630' };
const PORT_STYLES = [...BUILDING_STYLES, WAREHOUSE_STYLE];
const WAREHOUSE_STYLE_IDX = BUILDING_STYLES.length; // last index

/* Column ranges per district. c === 0 is Pelabuhan Tua (Old Port),
 * c < 3 is the old town, c === 3 downtown, c >= 4 the modern waterfront. */
const PORT_COL = 0;
const OLD_COLS = 3;
const MODERN_FROM = 4;

/* Style indices (into PORT_STYLES) that suit each district. */
const DISTRICT_STYLES = {
  port: [WAREHOUSE_STYLE_IDX, 0, 3, 5],
  oldtown: [0, 3, 6, 5, 1],
  downtown: [0, 1, 2, 3, 4, 5, 6, 7],
  modern: [4, 7, 2, 1],
};

const ROOF_KINDS = {
  port: ['crane', 'vent', 'tank', 'antenna'],
  oldtown: ['tank', 'unit', 'tank', 'garden'],
  downtown: ['unit', 'tank', 'antenna'],
  modern: ['unit', 'antenna', 'garden'],
};

export function createCity(seed = CITY.seed) {
  const rng = createRandom(seed);
  const pitch = CITY.block + CITY.road;
  const mapW = CITY.cols * pitch + CITY.road;
  const mapH = CITY.rows * pitch + CITY.road;

  const vx = [];
  for (let c = 0; c <= CITY.cols; c++) vx.push(c * pitch + CITY.road / 2);
  const hy = [];
  for (let r = 0; r <= CITY.rows; r++) hy.push(r * pitch + CITY.road / 2);

  const blockX = (c) => CITY.road + c * pitch;
  const blockY = (r) => CITY.road + r * pitch;

  /* ---------------------------------------------------------------- */
  /* coastline                                                         */
  /* ---------------------------------------------------------------- */

  const beach = { x: mapW, y: 0, w: CITY.beachWidth, h: mapH };
  const shoreX = beach.x + beach.w;
  const water = { x: shoreX, y: 0, w: CITY.waterWidth, h: mapH };
  const promenade = { x: beach.x, y: 0, w: 30, h: mapH };
  const pier = { x: beach.x - 20, y: hy[2] - 38, w: 372, h: 76 };

  /* ---------------------------------------------------------------- */
  /* district metadata                                                 */
  /* ---------------------------------------------------------------- */

  const districts = {
    port: {
      name: PORT_DISTRICT.name,
      x: blockX(PORT_COL) - CITY.road / 2,
      y: 0,
      w: PORT_DISTRICT.cols * pitch,
      h: mapH,
    },
    oldtown: {
      name: 'Old Town',
      x: blockX(1) - CITY.road / 2,
      y: 0,
      w: (OLD_COLS - 1) * pitch,
      h: mapH,
    },
    downtown: {
      name: 'Downtown',
      x: blockX(OLD_COLS) - CITY.road / 2,
      y: 0,
      w: pitch,
      h: mapH,
    },
    modern: {
      name: 'Marina District',
      x: blockX(MODERN_FROM) - CITY.road / 2,
      y: 0,
      w: mapW - (blockX(MODERN_FROM) - CITY.road / 2),
      h: mapH,
    },
  };

  const districtForBlock = (c) =>
    c === PORT_COL ? 'port' : c < OLD_COLS ? 'oldtown' : c >= MODERN_FROM ? 'modern' : 'downtown';

  const districtOf = (x, y) => {
    if (y < 0 || y > mapH) return null;
    if (x < blockX(1) - CITY.road / 2) return 'port';
    if (x < blockX(OLD_COLS) - CITY.road / 2) return 'oldtown';
    if (x >= blockX(MODERN_FROM) - CITY.road / 2) return 'modern';
    if (x <= districts.modern.x) return 'downtown';
    return null;
  };

  /* ---------------------------------------------------------------- */
  /* generated collections                                             */
  /* ---------------------------------------------------------------- */

  const blocks = [];
  const buildings = [];
  const parks = [];
  const lots = [];
  const colliders = [];
  const buildingColliders = [];
  const lamps = [];
  const trees = [];
  const benches = [];
  const umbrellas = [];
  const towels = [];
  const walkways = [];
  const parked = [];
  const docks = [];
  const boats = [];
  const crates = [];
  const bollards = [];
  const stalls = [];
  const alleys = [];
  const courtyards = [];
  const plazas = [];
  const fountains = [];
  const signals = [];
  const gardenPaths = [];

  let buildingId = 0;

  const addRect = (x, y, w, h, tag = 'solid', extra = null) => {
    const col = { kind: 'rect', x, y, w, h, tag };
    if (extra) Object.assign(col, extra);
    colliders.push(col);
    return col;
  };

  const addCircle = (x, y, r, tag = 'solid', extra = null) => {
    const col = { kind: 'circle', x, y, r, tag };
    if (extra) Object.assign(col, extra);
    colliders.push(col);
    return col;
  };

  function addLoop(pts) {
    walkways.push({ closed: true, points: pts });
  }

  /* Nearest block edge for a building — becomes its frontage. */
  function frontageOf(bld, block) {
    const north = bld.y - block.y;
    const south = block.y + block.h - (bld.y + bld.h);
    const west = bld.x - block.x;
    const east = block.x + block.w - (bld.x + bld.w);
    const min = Math.min(north, south, west, east);
    if (min === south) return 's';
    if (min === north) return 'n';
    if (min === west) return 'w';
    return 'e';
  }

  /* ---------------------------------------------------------------- */
  /* block fillers                                                     */
  /* ---------------------------------------------------------------- */

  function fillBlock(block) {
    const district = block.district;
    const pad = CITY.sidewalk + 7;
    const inner = {
      x: block.x + pad,
      y: block.y + pad,
      w: block.w - pad * 2,
      h: block.h - pad * 2,
    };

    let cols;
    if (district === 'oldtown') cols = rng.chance(0.75) ? 3 : 2;
    else if (district === 'modern') cols = rng.chance(0.6) ? 2 : 1;
    else cols = rng.chance(0.5) ? 2 : 3;

    const sliceW = (inner.w - ALLEY * (cols - 1)) / cols;
    const styleSet = DISTRICT_STYLES[district] || DISTRICT_STYLES.downtown;
    const baseStyle = BUILDING_STYLES[rng.pick(styleSet) % BUILDING_STYLES.length];

    for (let i = 0; i < cols; i++) {
      const colX = inner.x + i * (sliceW + ALLEY);

      let rows;
      if (district === 'oldtown') rows = rng.chance(0.8) ? 2 : 1;
      else if (district === 'modern') rows = rng.chance(0.35) ? 2 : 1;
      else rows = rng.chance(0.55) ? 2 : 1;

      const sliceH = (inner.h - ALLEY * (rows - 1)) / rows;

      for (let j = 0; j < rows; j++) {
        const cell = {
          x: colX,
          y: inner.y + j * (sliceH + ALLEY),
          w: sliceW,
          h: sliceH,
        };

        /* A parcel may be left open: courtyard in the old town and downtown,
         * a plaza with a fountain in the modern district. */
        const gapChance = district === 'oldtown' ? 0.08 : district === 'modern' ? 0.18 : 0.1;
        if (rng.chance(gapChance)) {
          const open = { x: cell.x, y: cell.y, w: cell.w, h: cell.h, district };
          if (district === 'modern' && rng.chance(0.55)) {
            plazas.push(open);
            const r = Math.min(24, Math.min(open.w, open.h) * 0.2);
            const fx = open.x + open.w / 2;
            const fy = open.y + open.h / 2;
            fountains.push({ x: fx, y: fy, r, kind: 'plaza' });
            addCircle(fx, fy, r + 2, 'fountain');
            for (let k = 0; k < 3; k++) {
              const tx = open.x + rng.range(20, Math.max(21, open.w - 20));
              const ty = open.y + rng.range(20, Math.max(21, open.h - 20));
              trees.push({ x: tx, y: ty, r: rng.range(14, 20), kind: 'garden' });
              addCircle(tx, ty, 6, 'tree');
            }
            benches.push({ x: open.x + open.w * 0.3, y: open.y + open.h - 16, angle: 0 });
          } else {
            courtyards.push(open);
            if (rng.chance(0.6)) {
              const tx = open.x + open.w * rng.range(0.3, 0.7);
              const ty = open.y + open.h * rng.range(0.3, 0.7);
              trees.push({ x: tx, y: ty, r: rng.range(16, 24), kind: 'garden' });
              addCircle(tx, ty, 7, 'tree');
            }
          }
          continue;
        }

        /* Buildings do not exactly fill their parcel: the jitter and the
         * setback differ per district, which keeps the skyline uneven. */
        const insetX = district === 'modern' ? rng.range(2, 9) : rng.range(0, 4);
        const insetY = district === 'modern' ? rng.range(2, 9) : rng.range(0, 4);
        const w = Math.max(38, cell.w - insetX);
        const h = Math.max(38, cell.h - insetY);

        /* Floor counts stay inside the renderer's drawing range (it clamps
         * lift to 14 and windows to 6 bands) so a tower reads correctly. */
        let floors;
        if (district === 'modern') floors = rng.chance(0.18) ? rng.int(6, 7) : rng.int(4, 7);
        else if (district === 'oldtown') floors = rng.int(1, 3);
        else floors = rng.int(2, 6);

        const style = rng.chance(0.72)
          ? baseStyle
          : BUILDING_STYLES[rng.pick(styleSet) % BUILDING_STYLES.length];

        const bld = {
          id: buildingId++,
          x: cell.x + rng.range(0, 3),
          y: cell.y + rng.range(0, 3),
          w,
          h,
          style,
          floors,
          district,
          block: block.id,
          lot: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
          lift: 2 + floors * (district === 'oldtown' ? 1.9 : 1.6),
          roof: [],
          awning: null,
          entrance: null,
          setback: null,
        };

        const front = frontageOf(bld, block);
        bld.entrance = {
          side: front,
          x: front === 'w' ? bld.x : front === 'e' ? bld.x + bld.w : bld.x + bld.w / 2,
          y: front === 'n' ? bld.y : front === 's' ? bld.y + bld.h : bld.y + bld.h / 2,
        };

        const awningChance = district === 'oldtown' ? 0.72 : district === 'modern' ? 0.18 : 0.45;
        if (rng.chance(awningChance)) {
          const side = front === 'n' ? 's' : front;
          bld.awning = { side, color: rng.pick(AWNING_COLORS) };
        }

        /* Tall modern towers step back above the podium so the footprint
         * reads as a base plus a slimmer shaft. */
        if (district === 'modern' && bld.w > 62 && bld.h > 62 && rng.chance(0.45)) {
          const trim = rng.range(8, 16);
          bld.setback = {
            x: bld.x + trim,
            y: bld.y + trim,
            w: bld.w - trim * 2,
            h: bld.h - trim * 2,
            atFloor: Math.min(floors - 1, rng.int(1, 3)),
          };
        }

        const kinds = ROOF_KINDS[district] || ROOF_KINDS.downtown;
        const clutter = district === 'modern' ? rng.int(1, 3) : rng.int(1, 4);
        for (let k = 0; k < clutter; k++) {
          const sz = rng.range(10, 22);
          bld.roof.push({
            x: rng.range(8, Math.max(9, bld.w - sz - 8)),
            y: rng.range(8, Math.max(9, bld.h - sz - 8)),
            w: sz,
            h: sz * rng.range(0.6, 1.1),
            kind: rng.pick(kinds),
          });
        }

        buildings.push(bld);

        const col = addRect(bld.x, bld.y, bld.w, bld.h, 'building', {
          id: bld.id,
          district,
          floors,
        });
        buildingColliders.push(col);
      }

      /* Service alley between parcel columns. */
      if (i < cols - 1) {
        alleys.push({
          x: colX + sliceW,
          y: inner.y,
          w: ALLEY,
          h: inner.h,
          axis: 'v',
          district,
        });
      }
    }

  }

  function fillLot(lot) {
    for (let row = 0; row < 2; row++) {
      const by = lot.y + 22 + row * 92;
      for (let bx = lot.x + 18; bx + BAY_W < lot.x + lot.w - 14; bx += BAY_W + 5) {
        if (!rng.chance(0.55)) continue;
        parked.push({
          x: bx + BAY_W / 2,
          y: by + BAY_H / 2,
          angle: -Math.PI / 2,
          color: rng.pick(CAR_COLORS),
        });
      }
    }
    /* Bay markings are kept out of `walkways` on purpose: pedestrians.js
     * slices that array by block count and only the per-block loops plus the
     * two shore loops may live there. */
    gardenPaths.push({
      x: lot.x + 12,
      y: lot.y + 12,
      w: lot.w - 24,
      h: lot.h - 24,
    });
  }

  function fillPark(block, inner, district) {
    let fountain = null;
    const fountainChance = district === 'modern' ? 0.7 : district === 'oldtown' ? 0.5 : 0.4;
    if (rng.chance(fountainChance)) {
      const r = Math.min(28, Math.min(inner.w, inner.h) * 0.17);
      fountain = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2, r };
      fountains.push(fountain);
      addCircle(fountain.x, fountain.y, r + 2, 'fountain');
    }

    const d = 26;
    gardenPaths.push({
      x: inner.x + d,
      y: inner.y + d,
      w: inner.w - d * 2,
      h: inner.h - d * 2,
      kind: 'park',
      district,
    });

    const count = rng.int(4, 8);
    for (let i = 0; i < count; i++) {
      const tx = rng.range(inner.x + 24, Math.max(inner.x + 25, inner.x + inner.w - 24));
      const ty = rng.range(inner.y + 24, Math.max(inner.y + 25, inner.y + inner.h - 24));
      if (fountain) {
        const dx = tx - fountain.x;
        const dy = ty - fountain.y;
        if (dx * dx + dy * dy < (fountain.r + 28) * (fountain.r + 28)) continue;
      }
      trees.push({ x: tx, y: ty, r: rng.range(17, 27), kind: 'park' });
      addCircle(tx, ty, 7, 'tree');
    }

    benches.push({ x: inner.x + inner.w * 0.25, y: inner.y + inner.h - 20, angle: 0 });
    benches.push({ x: inner.x + inner.w * 0.72, y: inner.y + 20, angle: Math.PI });

    lamps.push({ x: inner.x + 10, y: inner.y + 10, kind: 'park' });
    lamps.push({ x: inner.x + inner.w - 10, y: inner.y + inner.h - 10, kind: 'park' });
    addCircle(inner.x + 10, inner.y + 10, 4, 'lamp');
    addCircle(inner.x + inner.w - 10, inner.y + inner.h - 10, 4, 'lamp');

    /* Old town parks double as market squares. */
    if (district === 'oldtown') {
      for (let k = 0; k < 3; k++) {
        stalls.push({
          x: inner.x + inner.w * (0.2 + k * 0.28),
          y: inner.y + inner.h * 0.18,
          w: 34,
          h: 22,
          color: rng.pick(AWNING_COLORS),
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* grid                                                              */
  /* ---------------------------------------------------------------- */

  for (let r = 0; r < CITY.rows; r++) {
    for (let c = 0; c < CITY.cols; c++) {
      const x = blockX(c);
      const y = blockY(r);
      const district = districtForBlock(c);
      const roll = rng();

      let type = 'city';
      if (roll < (district === 'oldtown' ? 0.12 : 0.08)) type = 'park';
      else if (roll < (district === 'oldtown' ? 0.2 : district === 'modern' ? 0.26 : 0.2)) type = 'lot';

      const block = {
        id: r * CITY.cols + c,
        c,
        r,
        x,
        y,
        w: CITY.block,
        h: CITY.block,
        type,
        district,
      };
      blocks.push(block);

      const inset = CITY.sidewalk * 0.55;
      addLoop([
        { x: x + inset, y: y + inset },
        { x: x + block.w - inset, y: y + inset },
        { x: x + block.w - inset, y: y + block.h - inset },
        { x: x + inset, y: y + block.h - inset },
      ]);

      const inner = {
        x: x + CITY.sidewalk,
        y: y + CITY.sidewalk,
        w: block.w - CITY.sidewalk * 2,
        h: block.h - CITY.sidewalk * 2,
      };

      if (type === 'park') {
        parks.push({ ...inner, district, id: block.id });
        fillPark(block, inner, district);
      } else if (type === 'lot') {
        lots.push({ ...inner, district, id: block.id });
        fillLot(inner);
        lamps.push({ x: inner.x + 8, y: inner.y + 8, kind: 'street' });
        lamps.push({ x: inner.x + inner.w - 8, y: inner.y + inner.h - 8, kind: 'street' });
        addCircle(inner.x + 8, inner.y + 8, 4, 'lamp');
        addCircle(inner.x + inner.w - 8, inner.y + inner.h - 8, 4, 'lamp');
      } else {
        fillBlock(block);
      }

      /* Corner lamps sit in the sidewalk band; one is always lit so every
       * block is readable at night. */
      const corners = [
        [x + 16, y + 16],
        [x + block.w - 16, y + 16],
        [x + block.w - 16, y + block.h - 16],
        [x + 16, y + block.h - 16],
      ];
      for (let i = 0; i < corners.length; i++) {
        if (i !== 0 && !rng.chance(0.6)) continue;
        const [lx, ly] = corners[i];
        lamps.push({ x: lx, y: ly, kind: 'street' });
        addCircle(lx, ly, 4, 'lamp');
      }

      /* Street trees: old town gets small broadleaf trees close to the kerb,
       * the marina gets fewer, taller ones so the towers stay visible. */
      for (let side = 0; side < 4; side++) {
        const cnt = district === 'modern' ? 1 : rng.int(1, 2);
        for (let k = 0; k < cnt; k++) {
          if (district === 'modern' && !rng.chance(0.7)) continue;
          const t = rng.range(0.25, 0.75);
          let tx, ty;
          if (side === 0) { tx = x + block.w * t; ty = y + 11; }
          else if (side === 1) { tx = x + block.w - 11; ty = y + block.h * t; }
          else if (side === 2) { tx = x + block.w * t; ty = y + block.h - 11; }
          else { tx = x + 11; ty = y + block.h * t; }
          const rad = district === 'oldtown' ? rng.range(11, 16) : rng.range(13, 20);
          trees.push({ x: tx, y: ty, r: rad, kind: 'street' });
          addCircle(tx, ty, 5, 'tree');
        }
      }

      if (rng.chance(0.4)) {
        const benchY = rng.chance(0.5) ? y + block.h - 14 : y + 14;
        benches.push({
          x: x + block.w * rng.range(0.3, 0.7),
          y: benchY,
          angle: 0,
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pelabuhan Tua — old port district (column 0)                       */
  /* ---------------------------------------------------------------- */

  const portX = blockX(PORT_COL);
  const portY = 0;
  const portW = CITY.block;
  const portH = mapH;

  /* Main pier extending west from the port district into the water. */
  const mainPier = {
    id: 'main',
    x: portX - PORT_DISTRICT.dockDepth,
    y: hy[2] - 60,
    w: PORT_DISTRICT.dockDepth + 40,
    h: 120,
    kind: 'pier',
  };
  docks.push(mainPier);

  /* Pier pilings. */
  for (let px = mainPier.x + 20; px < mainPier.x + mainPier.w - 10; px += 48) {
    addCircle(px, mainPier.y + 8, 5, 'piling');
    addCircle(px, mainPier.y + mainPier.h - 8, 5, 'piling');
  }

  /* Pier lamps. */
  for (let px = mainPier.x + 30; px < mainPier.x + mainPier.w - 20; px += 72) {
    lamps.push({ x: px, y: mainPier.y + 8, kind: 'pier' });
    lamps.push({ x: px, y: mainPier.y + mainPier.h - 8, kind: 'pier' });
  }

  /* Benches along the pier. */
  for (let px = mainPier.x + 50; px < mainPier.x + mainPier.w - 40; px += 140) {
    benches.push({ x: px, y: mainPier.y + mainPier.h - 16, angle: 0 });
    benches.push({ x: px, y: mainPier.y + 16, angle: Math.PI });
  }

  /* Lighthouse at the end of the pier. */
  const lighthouse = {
    x: mainPier.x + mainPier.w - 30,
    y: mainPier.y + mainPier.h / 2,
    r: 14,
    height: PORT_DISTRICT.lighthouseHeight,
    range: PORT_DISTRICT.lighthouseRange,
    color: '#e8e4dc',
    lanternColor: '#fff8d0',
  };
  addCircle(lighthouse.x, lighthouse.y, lighthouse.r + 4, 'lighthouse');

  /* Cranes along the port waterfront. */
  for (let i = 0; i < PORT_DISTRICT.craneCount; i++) {
    const cy = hy[1] + i * (hy[3] - hy[1]) / (PORT_DISTRICT.craneCount - 1 || 1);
    const crane = {
      x: portX - 24,
      y: cy,
      boomLength: rng.range(90, 130),
      boomAngle: rng.range(-0.35, 0.15),
      cabColor: rng.pick(['#d9604c', '#2f7f8f', '#e8c25a', '#f1eee4']),
      boomColor: '#4a443d',
    };
    crates.push({
      x: crane.x - 16,
      y: crane.y - 16,
      w: 32,
      h: 32,
      rot: 0,
      kind: 'craneBase',
    });
    addRect(crane.x - 16, crane.y - 16, 32, 32, 'crane');
  }

  /* Warehouse buildings filling the port district blocks. */
  for (let r = 0; r < CITY.rows; r++) {
    const bx = portX;
    const by = blockY(r);
    const pad = CITY.sidewalk + 7;
    const inner = {
      x: bx + pad,
      y: by + pad,
      w: portW - pad * 2,
      h: CITY.block - pad * 2,
    };

    /* Two large warehouse parcels per block. */
    for (let i = 0; i < 2; i++) {
      const cellX = inner.x + i * (inner.w / 2 + ALLEY / 2);
      const cellW = inner.w / 2 - ALLEY / 2;
      const cellH = inner.h;

      if (!rng.chance(0.85)) continue;

      const w = Math.max(60, cellW - rng.range(4, 12));
      const h = Math.max(80, cellH - rng.range(4, 12));

      const floors = rng.int(2, 4);
      const bld = {
        id: buildingId++,
        x: cellX + rng.range(0, 4),
        y: inner.y + rng.range(0, 4),
        w,
        h,
        style: PORT_STYLES[WAREHOUSE_STYLE_IDX],
        floors,
        district: 'port',
        block: r * CITY.cols + PORT_COL,
        lot: { x: cellX, y: inner.y, w: cellW, h: cellH },
        lift: 2 + floors * 2.2,
        roof: [],
        awning: null,
        entrance: {
          side: 'e',
          x: cellX + w,
          y: inner.y + cellH / 2,
        },
        setback: null,
      };

      /* Large loading door on the water side. */
      bld.loadingDoor = {
        side: 'w',
        x: bld.x,
        y: bld.y + bld.h * 0.3,
        w: 18,
        h: 28,
      };

      /* Roof clutter: vents, tanks, small crane. */
      const clutter = rng.int(2, 4);
      for (let k = 0; k < clutter; k++) {
        const sz = rng.range(12, 26);
        bld.roof.push({
          x: rng.range(10, Math.max(11, bld.w - sz - 10)),
          y: rng.range(10, Math.max(11, bld.h - sz - 10)),
          w: sz,
          h: sz * rng.range(0.5, 1.2),
          kind: rng.pick(ROOF_KINDS.port),
        });
      }

      buildings.push(bld);

      const col = addRect(bld.x, bld.y, bld.w, bld.h, 'building', {
        id: bld.id,
        district: 'port',
        floors,
      });
      buildingColliders.push(col);
    }

    /* Service alley between the two warehouse rows. */
    alleys.push({
      x: inner.x + inner.w / 2,
      y: inner.y,
      w: ALLEY,
      h: inner.h,
      axis: 'v',
      district: 'port',
    });

    /* Street lamps at block corners for the port district. */
    const corners = [
      [bx + 16, by + 16],
      [bx + portW - 16, by + 16],
      [bx + portW - 16, by + CITY.block - 16],
      [bx + 16, by + CITY.block - 16],
    ];
    for (let i = 0; i < corners.length; i++) {
      if (i !== 0 && !rng.chance(0.6)) continue;
      const [lx, ly] = corners[i];
      lamps.push({ x: lx, y: ly, kind: 'street' });
      addCircle(lx, ly, 4, 'lamp');
    }

    /* Fog particles for atmosphere (handled by renderer via PORT_DISTRICT.fogDensity). */
  }

  /* ---------------------------------------------------------------- */
  /* promenade, beach furniture                                        */
  /* ---------------------------------------------------------------- */

  addLoop([
    { x: promenade.x + 14, y: 40 },
    { x: promenade.x + 14, y: mapH - 40 },
    { x: promenade.x + 40, y: mapH - 40 },
    { x: promenade.x + 40, y: 40 },
  ]);

  for (let y = 60; y < mapH - 40; y += 96) lamps.push({ x: promenade.x + 12, y, kind: 'promenade' });
  for (let y = 96; y < mapH - 60; y += 148) {
    benches.push({ x: promenade.x + 20, y, angle: Math.PI / 2 });
  }
  for (let y = 40; y < mapH - 40; y += 58) {
    bollards.push({ x: promenade.x + 6, y, r: 3 });
  }

  for (let y = 90; y < mapH - 60; y += 74) {
    trees.push({ x: beach.x + rng.range(46, 74), y, r: rng.range(18, 25), kind: 'palm' });
  }

  for (let i = 0; i < 26; i++) {
    umbrellas.push({
      x: beach.x + rng.range(110, CITY.beachWidth - 40),
      y: rng.range(40, mapH - 40),
      color: rng.pick(UMBRELLA_COLORS),
    });
  }
  for (let i = 0; i < 34; i++) {
    towels.push({
      x: beach.x + rng.range(96, CITY.beachWidth - 24),
      y: rng.range(30, mapH - 30),
      w: rng.range(22, 34),
      h: rng.range(12, 18),
      angle: rng.range(-0.4, 0.4),
      color: rng.pick(TOWEL_COLORS),
    });
  }

  const speckles = [];
  for (let i = 0; i < 900; i++) {
    speckles.push({
      x: beach.x + rng.range(30, CITY.beachWidth),
      y: rng.range(0, mapH),
      r: rng.range(0.6, 1.8),
      a: rng.range(0.08, 0.22),
    });
  }
  const foam = [];
  for (let y = 0; y < mapH; y += 26) {
    foam.push({ y, depth: rng.range(6, 20), offset: rng.range(0, 12) });
  }

  /* ---------------------------------------------------------------- */
  /* docks                                                             */
  /* ---------------------------------------------------------------- */

  const dockBays = [hy[0] + 120, hy[2] + 210, hy[4] - 60];
  for (let i = 0; i < dockBays.length; i++) {
    const dockH = i === 1 ? 52 : 44;
    const dockW = i === 1 ? 268 : 224;
    const dock = {
      id: i,
      x: beach.x + 88,
      y: dockBays[i] - dockH / 2,
      w: dockW,
      h: dockH,
      kind: i === 1 ? 'cargo' : 'mooring',
    };
    docks.push(dock);

    for (let px = dock.x + 30; px < dock.x + dock.w - 10; px += 54) {
      addCircle(px, dock.y + 4, 4, 'piling');
      addCircle(px, dock.y + dock.h - 4, 4, 'piling');
    }

    for (let px = dock.x + 24; px < dock.x + dock.w - 24; px += 88) {
      lamps.push({ x: px, y: dock.y + 6, kind: 'dock' });
    }

    if (dock.kind === 'cargo') {
      for (let k = 0; k < 4; k++) {
        const cw = rng.range(14, 20);
        const ch = rng.range(14, 20);
        const cx = dock.x + 22 + k * 26;
        const cy = dock.y + dock.h / 2 - ch / 2 + rng.range(-4, 4);
        crates.push({ x: cx, y: cy, w: cw, h: ch, rot: rng.range(-0.2, 0.2) });
        addRect(cx, cy, cw, ch, 'crate');
      }
    }

    boats.push({
      x: dock.x + dock.w + rng.range(26, 60),
      y: dock.y + dock.h / 2 + rng.range(-10, 10),
      angle: rng.range(-0.15, 0.15),
      len: rng.range(46, 68),
      beam: rng.range(16, 22),
      color: rng.pick(BOAT_COLORS),
      moored: true,
    });

    benches.push({ x: dock.x + dock.w - 20, y: dock.y + dock.h - 12, angle: 0 });
  }

  /* A few anchored boats further out, beyond the docks. */
  for (let i = 0; i < 5; i++) {
    boats.push({
      x: shoreX + rng.range(120, CITY.waterWidth - 180),
      y: rng.range(120, mapH - 120),
      angle: rng.range(0, Math.PI * 2),
      len: rng.range(38, 58),
      beam: rng.range(13, 19),
      color: rng.pick(BOAT_COLORS),
      moored: false,
    });
  }

  /* ---------------------------------------------------------------- */
  /* the main pier                                                     */
  /* ---------------------------------------------------------------- */

  addLoop([
    { x: pier.x + 6, y: pier.y + 24 },
    { x: pier.x + pier.w - 16, y: pier.y + 24 },
    { x: pier.x + pier.w - 16, y: pier.y + pier.h - 24 },
    { x: pier.x + 6, y: pier.y + pier.h - 24 },
  ]);

  const pierProps = [];
  const pierLamps = [];
  for (let x = pier.x + 60; x < pier.x + pier.w - 40; x += 74) {
    pierProps.push({ x, y: pier.y + 14 });
    pierProps.push({ x, y: pier.y + pier.h - 14 });
  }
  for (let x = pier.x + 30; x < pier.x + pier.w - 10; x += 62) {
    pierLamps.push({ x, y: pier.y + 4, kind: 'pier' });
    addCircle(x, pier.y + pier.h - 4, 4, 'piling');
  }
  for (let x = pier.x + 90; x < pier.x + pier.w - 50; x += 120) {
    benches.push({ x, y: pier.y + pier.h - 18, angle: 0 });
  }
  stalls.push({ x: pier.x + pier.w - 72, y: pier.y + 10, w: 30, h: 20, color: rng.pick(AWNING_COLORS) });

  /* ---------------------------------------------------------------- */
  /* traffic furniture                                                 */
  /* ---------------------------------------------------------------- */

  for (let r = 0; r <= CITY.rows; r += 2) {
    for (let c = 0; c <= CITY.cols; c += 2) {
      signals.push({
        x: vx[c] + CITY.road / 2 - 10,
        y: hy[r] - CITY.road / 2 + 10,
        axis: c % 2 === 0 ? 'x' : 'y',
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* parked cars                                                       */
  /* ---------------------------------------------------------------- */

  for (let r = 0; r <= CITY.rows; r++) {
    const sy = hy[r];
    for (let c = 0; c < CITY.cols; c++) {
      const from = blockX(c) + 16;
      const to = blockX(c) + CITY.block - 16;
      for (let k = 0; k < 2; k++) {
        if (!rng.chance(0.45)) continue;
        parked.push({
          x: rng.range(from + 20, Math.max(from + 21, to - 20)),
          y: sy + CITY.road / 2 - 17,
          angle: 0,
          color: rng.pick(CAR_COLORS),
        });
      }
    }
    for (let c = 0; c <= CITY.cols; c++) {
      const sx = vx[c];
      for (let rr = 0; rr < CITY.rows; rr++) {
        if (!rng.chance(0.3)) continue;
        parked.push({
          x: sx - CITY.road / 2 + 17,
          y: rng.range(blockY(rr) + 30, blockY(rr) + CITY.block - 30),
          angle: Math.PI / 2,
          color: rng.pick(CAR_COLORS),
        });
      }
    }
  }

  /* Curbside parking down the promenade side of town. */
  for (let r = 0; r < CITY.rows; r++) {
    if (!rng.chance(0.7)) continue;
    parked.push({
      x: blockX(CITY.cols - 1) + CITY.block + CITY.road / 2 - 18,
      y: blockY(r) + rng.range(40, CITY.block - 40),
      angle: Math.PI / 2,
      color: rng.pick(CAR_COLORS),
    });
  }

  const start = { x: blockX(3) + CITY.block * 0.5, y: blockY(2) + 15, facing: Math.PI / 2 };
  parked.push({ x: start.x + 62, y: blockY(2) - 17, angle: 0, color: '#d9604c' });

  /* Keep the spawn point walkable: drop any prop collider that would trap the
   * player on the first frame, and any tree drawn over the same spot. */
  const clearR = 26;
  for (let i = colliders.length - 1; i >= 0; i--) {
    const c = colliders[i];
    if (c.tag === 'building') continue;
    const cx = c.kind === 'rect' ? c.x + c.w / 2 : c.x;
    const cy = c.kind === 'rect' ? c.y + c.h / 2 : c.y;
    const dx = cx - start.x;
    const dy = cy - start.y;
    const reach = clearR + (c.kind === 'circle' ? c.r : Math.max(c.w, c.h) / 2);
    if (dx * dx + dy * dy < reach * reach) {
      colliders.splice(i, 1);
      for (let t = trees.length - 1; t >= 0; t--) {
        const tr = trees[t];
        const tdx = tr.x - start.x;
        const tdy = tr.y - start.y;
        if (tdx * tdx + tdy * tdy < clearR * clearR) trees.splice(t, 1);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* queries                                                           */
  /* ---------------------------------------------------------------- */

  function isWater(x, y) {
    if (x < shoreX) return false;
    if (x <= pier.x + pier.w && y >= pier.y && y <= pier.y + pier.h) return false;
    for (let i = 0; i < docks.length; i++) {
      const d = docks[i];
      if (x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h) return false;
    }
    return true;
  }

  function insideWorld(x, y) {
    return x > 8 && y > 8 && x < water.x + water.w && y < mapH - 8;
  }

  function collidersNear(x, y, radius) {
    const out = [];
    const reach = radius + 4;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.kind === 'rect') {
        const nx = Math.max(c.x, Math.min(x, c.x + c.w));
        const ny = Math.max(c.y, Math.min(y, c.y + c.h));
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy <= reach * reach) out.push(c);
      } else {
        const lim = radius + c.r + 4;
        const dx = x - c.x;
        const dy = y - c.y;
        if (dx * dx + dy * dy <= lim * lim) out.push(c);
      }
    }
    return out;
  }

  /* Colliders overlapping an arbitrary rectangle (broad-phase helper used
   * by camera culling and by placement sanity checks). */
  function collidersIn(rect) {
    const out = [];
    const x2 = rect.x + rect.w;
    const y2 = rect.y + rect.h;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.kind === 'rect') {
        if (c.x < x2 && c.x + c.w > rect.x && c.y < y2 && c.y + c.h > rect.y) out.push(c);
      } else if (c.x + c.r > rect.x && c.x - c.r < x2 && c.y + c.r > rect.y && c.y - c.r < y2) {
        out.push(c);
      }
    }
    return out;
  }

  function buildingAt(x, y) {
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  function blocksNear(x, y, radius = CITY.block) {
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const nx = Math.max(b.x, Math.min(x, b.x + b.w));
      const ny = Math.max(b.y, Math.min(y, b.y + b.h));
      const dx = x - nx;
      const dy = y - ny;
      if (dx * dx + dy * dy <= radius * radius) out.push(b);
    }
    return out;
  }

  return {
    seed,
    width: mapW,
    height: mapH,
    vx,
    hy,
    pitch,
    rows: CITY.rows,
    cols: CITY.cols,
    roadWidth: CITY.road,
    sidewalk: CITY.sidewalk,
    blockSize: CITY.block,
    blocks,
    buildings,
    buildingColliders,
    parks,
    lots,
    colliders,
    lamps,
    trees,
    benches,
    umbrellas,
    towels,
    walkways,
    parked,
    beach,
    promenade,
    water,
    shoreline: shoreX,
    pier,
    pierProps,
    pierLamps,
    docks,
    boats,
    crates,
    bollards,
    stalls,
    alleys,
    courtyards,
    plazas,
    fountains,
    signals,
    gardenPaths,
    speckles,
    foam,
    districts,
    spawn: start,
    colors: COLORS,
    downtown: { x: blockX(3) + CITY.block / 2, y: blockY(2) + CITY.block / 2 },
    lighthouse,
    isWater,
    insideWorld,
    collidersNear,
    collidersIn,
    buildingAt,
    blocksNear,
    districtOf,
    blockX,
    blockY,
  };
}
