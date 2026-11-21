// The city factory: hand it a seed and it hands back a finished Solmar. Nothing here is authored by
// hand — the two-way street grid, the rings people walk on, the blocks of lifted-roof buildings, the
// odd park or parking lot, and then the eastern promenade, beach, pier and open sea are all grown
// from the seed. Along with the map it returns the queries the rest of the game asks every frame
// (what blocks you, what counts as water, where the streets run), so the player, the traffic, the
// police and the crowd all inhabit one agreed layout.
//
// Order is load-bearing: the seeded stream below is consumed in a fixed sequence, and that alone is
// what lets one seed rebuild exactly the same streets, crowd positions and screenshots.

import { BUILDING_STYLES, CAR_COLORS, CITY, COLORS } from './config.js';
import { createRandom } from './utils.js';

/** Stripe colours for the shops that get an awning. */
const AWNING_COLORS = ['#d9605c', '#3f8a7c', '#dfae56', '#7a89b5'];

/** Beach parasols. */
const UMBRELLA_COLORS = ['#e2604f', '#f2c75c', '#3f8a9c', '#f1eee4'];

/** Width of the alley between two building slices inside one block. */
const ALLEY = 12;

/** Parking bay geometry, shared by the layout here and by the renderer's painted lines. */
const BAY_W = 30;
const BAY_H = 54;

export function createCity(seed = CITY.seed) {
  const rng = createRandom(seed);

  // --- The grid ---------------------------------------------------------------------------------
  // One street centre line every `pitch` pixels, with the first and last streets set half a road in
  // from the map edge. Each block fills the gap left between the roads.
  const pitch = CITY.block + CITY.road;
  const width = CITY.cols * pitch + CITY.road;
  const height = CITY.rows * pitch + CITY.road;

  const vx = [];
  for (let c = 0; c <= CITY.cols; c += 1) vx.push(c * pitch + CITY.road / 2);
  const hy = [];
  for (let r = 0; r <= CITY.rows; r += 1) hy.push(r * pitch + CITY.road / 2);

  const blockX = (c) => CITY.road + c * pitch;
  const blockY = (r) => CITY.road + r * pitch;

  // --- The coast, east of the grid ---------------------------------------------------------------
  const beach = { x: width, y: 0, w: CITY.beachWidth, h: height };
  const shoreline = beach.x + beach.w;
  const water = { x: shoreline, y: 0, w: CITY.waterWidth, h: height };
  const promenade = { x: beach.x, y: 0, w: 30, h: height };
  const pier = { x: beach.x - 20, y: hy[2] - 38, w: 372, h: 76 };

  // --- Collections the rest of the game reads -----------------------------------------------------
  const blocks = [];
  const buildings = [];
  const parks = [];
  const lots = [];
  const colliders = [];
  const lamps = [];
  const trees = [];
  const benches = [];
  const umbrellas = [];
  const walkways = [];
  const parked = [];

  const solidRect = (x, y, w, h) => colliders.push({ kind: 'rect', x, y, w, h });
  const solidCircle = (x, y, r) => colliders.push({ kind: 'circle', x, y, r });

  /**
   * Register one closed route a walker can be dropped onto and then follow. The block rings must go
   * in first: pedestrians.js slices this list at blocks.length to tell pavement from shore.
   */
  function addLoop(points) {
    walkways.push({ closed: true, points });
  }

  /**
   * Fill an ordinary block with buildings: two or three columns of slices, each slice one or two
   * deep, roughly a tenth of the plots left bare (a demolition site, a delivery yard), and roofs
   * dotted with water tanks and air units. About seven in ten buildings wear the block's style.
   */
  function fillBlock(block) {
    const pad = CITY.sidewalk + 7;
    const inner = {
      x: block.x + pad,
      y: block.y + pad,
      w: block.w - pad * 2,
      h: block.h - pad * 2,
    };
    const columns = rng.chance(0.5) ? 2 : 3;
    const sliceW = (inner.w - ALLEY * (columns - 1)) / columns;
    const houseStyle = rng.pick(BUILDING_STYLES);

    for (let i = 0; i < columns; i += 1) {
      const columnX = inner.x + i * (sliceW + ALLEY);
      const rows = rng.chance(0.55) ? 2 : 1;
      const sliceH = (inner.h - ALLEY * (rows - 1)) / rows;

      for (let j = 0; j < rows; j += 1) {
        // An empty plot gets no building and no collider, just courtyard showing through.
        if (rng.chance(0.1)) continue;

        const w = Math.max(40, sliceW - rng.range(0, 4));
        const h = Math.max(40, sliceH - rng.range(0, 4));
        const style = rng.chance(0.7) ? houseStyle : rng.pick(BUILDING_STYLES);
        const floors = rng.int(1, 6);

        const building = {
          x: columnX + rng.range(0, 3),
          y: inner.y + j * (sliceH + ALLEY) + rng.range(0, 3),
          w,
          h,
          style,
          floors,
          // Roof lift: taller buildings show more wall, so it grows with the floor count.
          lift: 2 + floors * 1.6,
          roof: [],
          awning: null,
        };

        // The roll happens before the height test on purpose: tall and short plots then draw from
        // the same stream, so one building's height can never shift every building after it.
        const wantsAwning = rng.chance(0.45);
        if (wantsAwning && building.h > 70) {
          building.awning = { side: 's', color: rng.pick(AWNING_COLORS) };
        }

        const clutter = rng.int(1, 4);
        for (let k = 0; k < clutter; k += 1) {
          const size = rng.range(10, 22);
          building.roof.push({
            x: rng.range(8, Math.max(9, w - size - 8)),
            y: rng.range(8, Math.max(9, h - size - 8)),
            w: size,
            h: size * rng.range(0.6, 1.1),
            kind: rng.chance(0.35) ? 'tank' : 'unit',
          });
        }

        buildings.push(building);
        solidRect(building.x, building.y, building.w, building.h);
      }
    }
  }

  /** Paint two rows of nose-in bays and leave a car in a little over half of them. */
  function fillLot(lot) {
    for (let row = 0; row < 2; row += 1) {
      const bayY = lot.y + 22 + row * 92;
      for (let bx = lot.x + 18; bx + BAY_W < lot.x + lot.w - 14; bx += BAY_W + 5) {
        if (!rng.chance(0.55)) continue;
        parked.push({
          x: bx + BAY_W / 2,
          y: bayY + BAY_H / 2,
          angle: -Math.PI / 2,
          color: rng.pick(CAR_COLORS),
        });
      }
    }
  }

  // --- Blocks, sidewalks and street furniture ----------------------------------------------------
  for (let r = 0; r < CITY.rows; r += 1) {
    for (let c = 0; c < CITY.cols; c += 1) {
      const x = blockX(c);
      const y = blockY(r);
      const roll = rng();
      const type = roll < 0.1 ? 'park' : roll < 0.2 ? 'lot' : 'city';
      const block = { c, r, x, y, w: CITY.block, h: CITY.block, type };
      blocks.push(block);

      // The walking ring, set just inside the kerb so nobody strolls out into traffic.
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
        parks.push({ x: inner.x, y: inner.y, w: inner.w, h: inner.h });
      } else if (type === 'lot') {
        lots.push({ x: inner.x, y: inner.y, w: inner.w, h: inner.h });
        fillLot(inner);
        lamps.push({ x: inner.x + 8, y: inner.y + 8 });
        lamps.push({ x: inner.x + inner.w - 8, y: inner.y + inner.h - 8 });
      } else {
        fillBlock(block);
      }

      // Lamp standards on the corners: the first always, the other three most of the time.
      const corners = [
        [x + 16, y + 16],
        [x + block.w - 16, y + 16],
        [x + block.w - 16, y + block.h - 16],
        [x + 16, y + block.h - 16],
      ];
      for (let i = 0; i < corners.length; i += 1) {
        if (i !== 0 && !rng.chance(0.6)) continue;
        const [lx, ly] = corners[i];
        lamps.push({ x: lx, y: ly });
        solidCircle(lx, ly, 4);
      }

      // A tree or two along each side of the ring.
      for (let side = 0; side < 4; side += 1) {
        const count = rng.int(1, 2);
        for (let k = 0; k < count; k += 1) {
          const t = rng.range(0.25, 0.75);
          let tx;
          let ty;
          if (side === 0) {
            tx = x + block.w * t;
            ty = y + 11;
          } else if (side === 1) {
            tx = x + block.w - 11;
            ty = y + block.h * t;
          } else if (side === 2) {
            tx = x + block.w * t;
            ty = y + block.h - 11;
          } else {
            tx = x + 11;
            ty = y + block.h * t;
          }
          trees.push({ x: tx, y: ty, r: rng.range(13, 19), kind: 'street' });
          solidCircle(tx, ty, 5);
        }
      }

      if (rng.chance(0.4)) {
        benches.push({ x: x + block.w * rng.range(0.3, 0.7), y: y + block.h - 14, angle: 0 });
      }
    }
  }

  // --- Promenade, beach and pier -----------------------------------------------------------------
  addLoop([
    { x: promenade.x + 14, y: 40 },
    { x: promenade.x + 14, y: height - 40 },
    { x: promenade.x + 40, y: height - 40 },
    { x: promenade.x + 40, y: 40 },
  ]);
  for (let y = 60; y < height - 40; y += 96) lamps.push({ x: promenade.x + 12, y });
  for (let y = 90; y < height - 60; y += 74) {
    trees.push({ x: beach.x + rng.range(46, 74), y, r: rng.range(18, 25), kind: 'palm' });
  }
  for (let i = 0; i < 26; i += 1) {
    umbrellas.push({
      x: beach.x + rng.range(110, CITY.beachWidth - 40),
      y: rng.range(40, height - 40),
      color: rng.pick(UMBRELLA_COLORS),
    });
  }

  // Baked detail, stable for a given seed: grain scattered over the sand, scallops at the waterline.
  const speckles = [];
  for (let i = 0; i < 900; i += 1) {
    speckles.push({
      x: beach.x + rng.range(30, CITY.beachWidth),
      y: rng.range(0, height),
      r: rng.range(0.6, 1.8),
      a: rng.range(0.08, 0.22),
    });
  }
  const foam = [];
  for (let y = 0; y < height; y += 26) {
    foam.push({ y, depth: rng.range(6, 20), offset: rng.range(0, 12) });
  }

  // The deck loop and its fittings, both kept clear of the railings.
  addLoop([
    { x: pier.x + 6, y: pier.y + 24 },
    { x: pier.x + pier.w - 16, y: pier.y + 24 },
    { x: pier.x + pier.w - 16, y: pier.y + pier.h - 24 },
    { x: pier.x + 6, y: pier.y + pier.h - 24 },
  ]);
  const pierProps = [];
  for (let x = pier.x + 60; x < pier.x + pier.w - 40; x += 74) {
    pierProps.push({ x, y: pier.y + 14 });
    pierProps.push({ x, y: pier.y + pier.h - 14 });
  }

  // --- Parked cars along the kerbs ----------------------------------------------------------------
  for (let r = 0; r <= CITY.rows; r += 1) {
    const streetY = hy[r];

    // East-west streets: cars parallel to the kerb, nose east.
    for (let c = 0; c < CITY.cols; c += 1) {
      const from = blockX(c) + 16;
      const to = blockX(c) + CITY.block - 16;
      for (let k = 0; k < 2; k += 1) {
        if (!rng.chance(0.45)) continue;
        parked.push({
          x: rng.range(from + 20, Math.max(from + 21, to - 20)),
          y: streetY + CITY.road / 2 - 17,
          angle: 0,
          color: rng.pick(CAR_COLORS),
        });
      }
    }

    // North-south streets: cars parallel to the kerb, nose south.
    for (let c = 0; c <= CITY.cols; c += 1) {
      const streetX = vx[c];
      for (let rr = 0; rr < CITY.rows; rr += 1) {
        if (!rng.chance(0.3)) continue;
        parked.push({
          x: streetX - CITY.road / 2 + 17,
          y: rng.range(blockY(rr) + 30, blockY(rr) + CITY.block - 30),
          angle: Math.PI / 2,
          color: rng.pick(CAR_COLORS),
        });
      }
    }
  }

  // Spawn on the north kerb of the middle block, facing the road, with a red car waiting alongside.
  const startBlock = { x: blockX(3), y: blockY(2) };
  const spawn = {
    x: startBlock.x + CITY.block * 0.5,
    y: startBlock.y + 15,
    facing: Math.PI / 2,
  };
  parked.push({ x: spawn.x + 62, y: startBlock.y - 17, angle: 0, color: '#d9604c' });

  // --- Queries the simulation runs every frame -----------------------------------------------------
  /** Open sea, except where the pier deck carries you out over it. */
  function isWater(x, y) {
    if (x < shoreline) return false;
    const onPier = x <= pier.x + pier.w && y >= pier.y && y <= pier.y + pier.h;
    return !onPier;
  }

  function insideWorld(x, y) {
    return x > 8 && y > 8 && x < water.x + water.w && y < height - 8;
  }

  /** Every collider close enough to touch a circle of `radius` centred on (x, y). */
  function collidersNear(x, y, radius) {
    const out = [];
    const reach = radius + 4;
    for (let i = 0; i < colliders.length; i += 1) {
      const c = colliders[i];
      if (c.kind === 'rect') {
        const nx = Math.max(c.x, Math.min(x, c.x + c.w));
        const ny = Math.max(c.y, Math.min(y, c.y + c.h));
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy <= reach * reach) out.push(c);
      } else {
        const limit = radius + c.r + 4;
        const dx = x - c.x;
        const dy = y - c.y;
        if (dx * dx + dy * dy <= limit * limit) out.push(c);
      }
    }
    return out;
  }

  return {
    seed,
    width,
    height,
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
    parks,
    lots,
    colliders,
    lamps,
    trees,
    benches,
    umbrellas,
    walkways,
    parked,
    beach,
    promenade,
    water,
    shoreline,
    pier,
    pierProps,
    speckles,
    foam,
    spawn,
    colors: COLORS,
    // Downtown is the heart of the grid: the title camera and the minimap both aim there.
    downtown: { x: blockX(3) + CITY.block / 2, y: blockY(2) + CITY.block / 2 },
    isWater,
    insideWorld,
    collidersNear,
    blockX,
    blockY,
  };
}