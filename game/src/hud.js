// The whole drawn interface lives here: the status panel (health / wanted / save), the objective
// card, the cash and clock panel, the minimap, the interaction prompt, the bottom-left toast strip,
// and the four full-screen cards (title, pause, wasted, fade). main.js owns the simulation and hands
// over a plain world snapshot; this module formats those numbers and paints them, it never mutates
// the world.
//
// Layout rules — a panel that leaves the picture is a bug:
//   - Panels are placed from the canvas edge inward. The right-hand pair (cash, minimap) ends at
//     `w - RIGHT`, i.e. 34 px of clearance at 1280x720, so no figure ever touches the right edge.
//   - Every string is measured before it is painted and trimmed with `fitText` to the room its panel
//     really has, rather than spilling out or being clipped by the canvas border.
//   - The toast strip is pinned bottom-left at `MARGIN + 8` from the edge and width-capped so it can
//     never reach the centred prompt or the minimap.
//   - The drawing size is the canvas backing store divided by the live device scale, so one layout
//     works at 1280x720, at other box sizes, and on a HiDPI display.
//
// Interface used by main.js:
//   createHud() -> { say, update, drawTitle, drawGame, drawPause, drawOver, drawFade }

import { CITY, COLORS, FONT } from './config.js';
import { clamp, formatClock, formatMoney, roundRect } from './utils.js';

/** Screen-edge margins in CSS pixels. Right and bottom are wider, for the panels that hug them. */
const MARGIN = 26;
const RIGHT = 34;
const BOTTOM = 28;

/** Gap between two stacked panels. */
const GAP = 14;

/** Inner padding for text inside a panel. */
const PAD = 16;

/** Default toast lifetime in seconds; `say` may override it. */
const SAY_SECONDS = 2.6;

/** Wanted stars on the panel; the world keeps its own count in [0, 5]. */
const MAX_STARS = 5;

/** Minimap side length in CSS pixels. */
const MINIMAP = 150;

/** Preferred panel sizes; each is clamped to the room actually available. */
const HEALTH_W = 300;
const HEALTH_H = 118;
const OBJECTIVE_W = 400;
const OBJECTIVE_H = 104;
const CASH_W = 268;
const CASH_H = 104;

/** Fraction of the minimap width the camera's visible span covers. */
const MINIMAP_VIEW = 0.62;

/** Star tints, quiet amber on the first, hot red on the fifth. */
const STAR_TINTS = ['#f2c75c', '#f0b559', '#eea154', '#eca04f', '#e8665b'];

// --- drawing helpers ---------------------------------------------------------------------------

/** Set the shared font stack at `size` px and `weight`. */
function setFont(ctx, size, weight = '600') {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

/**
 * Paint `text` on one line starting at x = 0 inside `maxWidth`: measured first, then shortened with
 * an ellipsis when it still does not fit. The caller translates to the baseline first.
 */
function fitText(ctx, text, maxWidth) {
  const value = String(text ?? '');
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return;

  if (ctx.measureText(value).width <= maxWidth) {
    ctx.fillText(value, 0, 0);
    return;
  }

  const ellipsis = '\u2026';
  const room = Math.max(0, maxWidth - ctx.measureText(ellipsis).width);
  let lo = 0;
  let hi = value.length;

  // Largest prefix that still fits inside `room`.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(value.slice(0, mid)).width <= room) lo = mid;
    else hi = mid - 1;
  }

  const cut = value.slice(0, lo).replace(/[\s,.;:-]+$/, '');
  ctx.fillText(`${cut}${ellipsis}`, 0, 0);
}

/** Translucent panel with a hairline edge. */
function panel(ctx, x, y, w, h, radius = 10) {
  roundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.strokeStyle = COLORS.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Small uppercase label used inside panels. */
function caption(ctx, text, x, y, color = COLORS.muted) {
  setFont(ctx, 11, '700');
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
}

/**
 * Right-aligned value that shrinks to fit instead of leaving its panel: measure, scale the font down
 * when needed, then paint right-aligned at `x` with at most `maxW` of width.
 */
function value(ctx, text, x, y, size = 13, color = COLORS.cream, maxW = 0, weight = '700') {
  const label = String(text ?? '');
  setFont(ctx, size, weight);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;

  if (maxW > 0) {
    const natural = ctx.measureText(label).width;
    if (natural > maxW) {
      const scaled = Math.max(9, Math.floor((size * maxW) / natural));
      setFont(ctx, scaled, weight);
    }
  }

  ctx.fillText(label, x, y);
  setFont(ctx, size, weight);
}

/** Five-pointed star centred on (cx, cy). */
function star(ctx, cx, cy, outer, filled, tint) {
  const inner = outer * 0.46;
  ctx.beginPath();

  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.closePath();
  if (filled) {
    ctx.fillStyle = tint;
    ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(247, 241, 226, 0.30)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

/** Compass rose in a minimap corner; `bearing` is the player's heading in radians (0 = +x). */
function compass(ctx, cx, cy, radius, bearing) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 18, 24, 0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 248, 230, 0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const dx = Math.cos(bearing);
  const dy = Math.sin(bearing);
  ctx.beginPath();
  ctx.moveTo(cx + dx * (radius - 2), cy + dy * (radius - 2));
  ctx.lineTo(cx - dy * 3.4, cy + dx * 3.4);
  ctx.lineTo(cx + dy * 3.4, cy - dx * 3.4);
  ctx.closePath();
  ctx.fillStyle = COLORS.gold;
  ctx.fill();

  setFont(ctx, 8, '700');
  ctx.fillStyle = COLORS.cream;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - radius + 3.4);
}

/** Flat veil behind a card, so the world still reads underneath. */
function veil(ctx, w, h, alpha) {
  ctx.fillStyle = `rgba(6, 11, 15, ${alpha})`;
  ctx.fillRect(0, 0, w, h);
}

/** Centred heading with a thin gold rule under it. */
function banner(ctx, cx, y, text, size, color = COLORS.cream, rule = true) {
  setFont(ctx, size, '800');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(text, cx, y);
  if (!rule) return;

  const width = Math.min(ctx.measureText(text).width, cx * 2);
  ctx.strokeStyle = 'rgba(242, 199, 92, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - width / 2, y + size * 0.42);
  ctx.lineTo(cx + width / 2, y + size * 0.42);
  ctx.stroke();
}

/** Label on the left, value on the right inside a row of `width`; the label is the one that shrinks. */
function row(ctx, label, text, x, y, width) {
  setFont(ctx, 13, '700');
  const valueW = Math.min(width * 0.5, ctx.measureText(String(text ?? '')).width);
  const labelRoom = Math.max(0, width - valueW - 14);

  setFont(ctx, 12, '600');
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 14, labelRoom, 20);
  ctx.clip();
  ctx.translate(x, y);
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  fitText(ctx, label, labelRoom);
  ctx.restore();

  value(ctx, text, x + width, y, 13, COLORS.cream, Math.max(0, width - labelRoom - 8));
}

/**
 * A row of key caps with the action underneath; returns the x where the row ended. Rows are drawn no
 * wider than `maxWidth`, so they can never run off the safe area.
 */
function keyCaps(ctx, x, y, items, maxWidth = Infinity) {
  const gap = 10;
  let cursor = x;

  for (const item of items) {
    setFont(ctx, 12, '700');
    const keyWidth = Math.max(26, ctx.measureText(item.key).width + 16);
    if (cursor + keyWidth > x + maxWidth) break;

    roundRect(ctx, cursor, y, keyWidth, 24, 6);
    ctx.fillStyle = 'rgba(247, 241, 226, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(247, 241, 226, 0.26)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.cream;
    ctx.fillText(item.key, cursor + keyWidth / 2, y + 12.5);

    setFont(ctx, 11, '600');
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(item.action, cursor + keyWidth / 2, y + 42);

    cursor += keyWidth + gap;
  }

  return cursor - gap;
}

/** Total width of a set of key caps, so a row can be centred without drawing it twice. */
function keyCapsWidth(ctx, items) {
  let width = 0;

  for (const item of items) {
    setFont(ctx, 12, '700');
    width += Math.max(26, ctx.measureText(item.key).width + 16) + 10;
  }

  return Math.max(0, width - 10);
}

// --- the HUD -----------------------------------------------------------------------------------

/**
 * Build the HUD. The returned object is the entire interface main.js talks to: post a message,
 * advance the message timer, and one draw call per screen.
 */
export function createHud() {
  let message = '';
  let messageTimer = 0;
  let messageSeconds = SAY_SECONDS;

  /**
   * Run one HUD draw inside a known screen-space setup, handing it the drawing size in CSS pixels.
   * The backing store may be device-pixel scaled, so the size is the canvas pixel size divided by the
   * live scale — but only while that transform is a plain scale at the origin. A camera translate or
   * a rotation means the world renderer left its transform live, so the transform is reset to
   * identity and the raw canvas size is used: the HUD must never land in world space.
   */
  function frame(ctx, draw) {
    ctx.save();

    const m = typeof ctx.getTransform === 'function'
      ? ctx.getTransform()
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    let sx = Math.abs(m.a) > 0.01 ? Math.abs(m.a) : 1;
    let sy = Math.abs(m.d) > 0.01 ? Math.abs(m.d) : 1;
    const rotated = Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6;
    const moved = Math.abs(m.e) > 0.5 || Math.abs(m.f) > 0.5;

    if (rotated || moved) {
      sx = 1;
      sy = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    const canvas = ctx.canvas;
    const w = Math.max(320, Math.round((canvas?.width || 1280) / sx));
    const h = Math.max(240, Math.round((canvas?.height || 720) / sy));
    draw(w, h);
    ctx.restore();
  }

  /** Post a message in the bottom-left toast strip. `seconds` may be omitted. */
  function say(text, seconds = SAY_SECONDS) {
    message = String(text ?? '');
    messageSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : SAY_SECONDS;
    messageTimer = messageSeconds;
  }

  /** Advance the toast timer once per real frame (seconds, not simulation steps). */
  function update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (messageTimer > 0) messageTimer = Math.max(0, messageTimer - dt);
  }

  /** Width available to a left-hand panel, so it can never grow under the cash panel. */
  function leftRoom(w) {
    return Math.max(200, Math.min(OBJECTIVE_W, w - MARGIN - RIGHT - CASH_W - GAP - 24));
  }

  /** Health, wanted stars and save status, top-left. */
  function drawStatus(ctx, world, w) {
    const player = world.player ?? {};
    const health = clamp(Number(player.health ?? 0), 0, 100);
    const wanted = clamp(Math.round(Number(world.wanted ?? 0)), 0, MAX_STARS);

    const x = MARGIN;
    const y = MARGIN;
    const width = Math.min(HEALTH_W, leftRoom(w));
    const inner = Math.max(0, width - PAD * 2);

    panel(ctx, x, y, width, HEALTH_H);

    caption(ctx, 'HEALTH', x + PAD, y + 25);
    value(ctx, `${Math.round(health)}`, x + width - PAD, y + 25, 12, COLORS.cream, 90);

    const barX = x + PAD;
    const barY = y + 36;
    const barW = inner;
    const barH = 12;
    roundRect(ctx, barX, barY, barW, barH, 6);
    ctx.fillStyle = 'rgba(247, 241, 226, 0.13)';
    ctx.fill();

    if (health > 0) {
      const fillW = Math.max(barH, (barW * health) / 100);
      roundRect(ctx, barX, barY, Math.min(barW, fillW), barH, 6);
      ctx.fillStyle = health <= 30 ? COLORS.red : COLORS.green;
      ctx.fill();
    }

    caption(ctx, 'WANTED', x + PAD, y + 73);

    const starSpan = Math.min(MAX_STARS, Math.max(1, Math.floor(inner / 26)));
    const starsW = starSpan * 24 - 6;
    for (let i = 0; i < starSpan; i += 1) {
      const tint = STAR_TINTS[Math.min(i, STAR_TINTS.length - 1)];
      star(ctx, x + PAD + 9 + i * 24, y + 91, 9.5, i < wanted, tint);
    }

    // Save status shares the star row's tail, shortened rather than allowed to leave the box.
    if (world.saveStatus && world.saveStatus !== 'none') {
      const saveRoom = Math.max(0, inner - starsW - 16);
      if (saveRoom > 60) {
        setFont(ctx, 10, '600');
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + width - PAD - saveRoom, y + 80, saveRoom, 18);
        ctx.clip();
        ctx.translate(x + width - PAD, y + 94);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(169, 179, 184, 0.85)';
        fitText(ctx, `save: ${world.saveStatus}`, saveRoom);
        ctx.restore();
      }
    }
  }

  /** Objective / mission card, under the status panel. Hidden when there is no objective. */
  function drawObjective(ctx, world, w) {
    const objective = world.objective;
    if (!objective) return;

    const x = MARGIN;
    const y = MARGIN + HEALTH_H + GAP;
    const width = leftRoom(w);
    const inner = Math.max(0, width - PAD * 2);

    panel(ctx, x, y, width, OBJECTIVE_H);

    const jobNumber = Math.max(1, Math.round(world.jobsDone ?? 0) + 1);
    caption(ctx, `OBJECTIVE \u00b7 JOB ${jobNumber}`, x + PAD, y + 25);

    setFont(ctx, 15, '700');
    const pay = Number.isFinite(objective.pay) ? formatMoney(objective.pay) : '';
    const payW = pay ? Math.min(inner * 0.5, ctx.measureText(pay).width) : 0;
    const titleRoom = Math.max(60, inner - (pay ? payW + 16 : 0));

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + PAD, y + 34, titleRoom, 22);
    ctx.clip();
    ctx.translate(x + PAD, y + 52);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.gold;
    fitText(ctx, objective.title ?? 'Job', titleRoom);
    ctx.restore();

    if (pay) {
      value(ctx, pay, x + width - PAD, y + 52, 15, COLORS.green, inner * 0.5, '800');
    }

    const player = world.player ?? {};
    const hasPoint = Number.isFinite(objective.x) && Number.isFinite(objective.y)
      && Number.isFinite(player.x) && Number.isFinite(player.y);
    const away = hasPoint
      ? `${Math.max(0, Math.round(Math.hypot(objective.x - player.x, objective.y - player.y) / 10))} m`
      : '';

    setFont(ctx, 10, '600');
    const awayW = away ? Math.min(inner * 0.4, ctx.measureText(away).width) : 0;
    const detailRoom = Math.max(60, inner - (away ? awayW + 16 : 0));

    setFont(ctx, 12, '500');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + PAD, y + 63, detailRoom, 20);
    ctx.clip();
    ctx.translate(x + PAD, y + 80);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(247, 241, 226, 0.82)';
    fitText(ctx, objective.detail ?? '', detailRoom);
    ctx.restore();

    if (away) {
      setFont(ctx, 10, '600');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(away, x + width - PAD, y + 80, Math.max(0, inner * 0.4));
    }
  }

  /** Cash, in-game clock and day, top-right. The panel ends exactly at `w - RIGHT`. */
  function drawCash(ctx, world, w) {
    const player = world.player ?? {};
    const width = Math.min(CASH_W, Math.max(184, w - MARGIN - RIGHT - 40));
    const x = w - RIGHT - width;
    const y = MARGIN;
    const inner = Math.max(0, width - PAD * 2);

    panel(ctx, x, y, width, CASH_H);

    caption(ctx, 'CASH', x + PAD, y + 25);

    // The amount shrinks rather than spilling: "CASH" holds the left of the row, so the figure is
    // measured against the remainder and the font is scaled down until a large balance fits.
    const money = formatMoney(player.money ?? 0);
    const room = Math.max(40, inner - 52);
    setFont(ctx, 26, '800');
    const natural = ctx.measureText(money).width;
    const size = natural > room ? Math.max(14, Math.floor((26 * room) / natural)) : 26;
    setFont(ctx, size, '800');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.green;
    ctx.fillText(money, x + width - PAD, y + 46);

    ctx.strokeStyle = 'rgba(247, 241, 226, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + PAD, y + 62);
    ctx.lineTo(x + width - PAD, y + 62);
    ctx.stroke();

    const clock = formatClock(world.clock ?? 0);
    const dayText = `Day ${Math.max(1, Math.round(world.day ?? 1))}`;

    setFont(ctx, 20, '700');
    const clockW = ctx.measureText(clock).width;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.cream;
    ctx.fillText(clock, x + PAD, y + 88);

    const dayRoom = Math.max(0, inner - clockW - 14);
    if (dayRoom > 24) {
      setFont(ctx, 11, '600');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(dayText, x + width - PAD, y + 88);
    }
  }

  /**
   * Minimap, bottom-right, 150 px square, ending at `w - RIGHT` / `h - BOTTOM`. Sea, sand, roads,
   * cars and the marker all pass through one scale and one camera-centred offset, so they line up.
   */
  function drawMinimap(ctx, world, w, h) {
    const size = MINIMAP;
    const x = w - RIGHT - size;
    const y = h - BOTTOM - size;
    const city = world.city;
    const player = world.player ?? {};
    const view = world.view ?? {};
    const px = Number.isFinite(player.x) ? player.x : 0;
    const py = Number.isFinite(player.y) ? player.y : 0;

    roundRect(ctx, x, y, size, size, 10);
    ctx.save();
    ctx.clip();

    ctx.fillStyle = 'rgba(28, 61, 74, 0.92)';
    ctx.fillRect(x, y, size, size);

    if (city) {
      const zoom = Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom : 1;
      const span = Number.isFinite(view.width) && view.width > 0
        ? view.width
        : (Number.isFinite(view.w) && view.w > 0 ? view.w : 1280);
      const worldPerPx = span / zoom / (size * MINIMAP_VIEW);
      const scale = 1 / worldPerPx;
      const midX = x + size / 2;
      const midY = y + size / 2;
      const toX = (wx) => midX + (wx - px) * scale;
      const toY = (wy) => midY + (wy - py) * scale;

      const cityW = Number(city.width ?? city.shoreline ?? 0);
      const cityH = Number(city.height ?? 0);
      const shore = Number(city.shoreline ?? cityW);
      const sand = Number(city.beach?.w ?? city.beachWidth ?? CITY.beachWidth);
      const water = Number(city.water?.w ?? city.waterWidth ?? CITY.waterWidth);
      const block = Number(city.blockSize ?? city.block ?? CITY.block);
      const road = Number(city.roadWidth ?? city.road ?? CITY.road);
      const cols = Number(city.cols ?? CITY.cols);
      const rows = Number(city.rows ?? CITY.rows);

      if (cityH > 0) {
        // Sea, then sand, then the paved grid on top: the coast reads left to right.
        ctx.fillStyle = 'rgba(34, 127, 155, 0.95)';
        ctx.fillRect(toX(shore), toY(0), Math.max(1, water * scale), cityH * scale);
        ctx.fillStyle = 'rgba(232, 208, 166, 0.95)';
        ctx.fillRect(toX(shore - sand), toY(0), Math.max(1, sand * scale), cityH * scale);
        ctx.fillStyle = 'rgba(194, 187, 172, 0.92)';
        ctx.fillRect(toX(0), toY(0), Math.max(1, shore * scale), cityH * scale);
      }

      // Streets: one line per gap is enough at map scale.
      if (cityH > 0 && block > 0) {
        ctx.strokeStyle = 'rgba(61, 66, 75, 0.95)';
        ctx.lineWidth = Math.max(1, road * scale);
        ctx.beginPath();
        for (let c = 0; c <= cols; c += 1) {
          const wx = c * (block + road) + road / 2;
          ctx.moveTo(toX(wx), toY(-road));
          ctx.lineTo(toX(wx), toY(cityH + road));
        }
        for (let r = 0; r <= rows; r += 1) {
          const wy = r * (block + road) + road / 2;
          ctx.moveTo(toX(-road), toY(wy));
          ctx.lineTo(toX(shore + road), toY(wy));
        }
        ctx.stroke();
      }

      // Traffic as small dots, parked cars warmer: the map reads as "people are moving here".
      if (world.traffic && Array.isArray(world.traffic.list)) {
        ctx.fillStyle = 'rgba(247, 241, 226, 0.72)';
        for (const car of world.traffic.list) {
          if (!Number.isFinite(car.x) || !Number.isFinite(car.y)) continue;
          ctx.fillRect(toX(car.x) - 1, toY(car.y) - 1, 2, 2);
        }
      }
      if (Array.isArray(world.parked)) {
        ctx.fillStyle = 'rgba(242, 199, 92, 0.60)';
        for (const car of world.parked) {
          if (!Number.isFinite(car.x) || !Number.isFinite(car.y)) continue;
          ctx.fillRect(toX(car.x) - 1, toY(car.y) - 1, 2, 2);
        }
      }

      // Objective marker: a pulsing gold ring and dot, plus a spur pointing off the map's edge.
      const objective = world.objective;
      if (objective && Number.isFinite(objective.x) && Number.isFinite(objective.y)) {
        const ox = toX(objective.x);
        const oy = toY(objective.y);
        const pulse = 5.5 + Math.sin((Number.isFinite(world.time) ? world.time : 0) * 3.4) * 1.4;
        ctx.strokeStyle = COLORS.gold;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(ox, oy, pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ox, oy, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.gold;
        ctx.fill();

        const dx = ox - midX;
        const dy = oy - midY;
        const len = Math.hypot(dx, dy);
        const reach = size / 2 - 12;
        if (len > reach) {
          const n = reach / len;
          ctx.beginPath();
          ctx.moveTo(midX + dx * n, midY + dy * n);
          ctx.lineTo(midX + dx * n * 0.72, midY + dy * n * 0.72);
          ctx.strokeStyle = 'rgba(242, 199, 92, 0.55)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // The player, always dead centre: a heading wedge, so the map turns with the body.
      const bearing = Number.isFinite(player.facing) ? player.facing : 0;
      ctx.save();
      ctx.translate(midX, midY);
      ctx.rotate(bearing);
      ctx.beginPath();
      ctx.moveTo(6.5, 0);
      ctx.lineTo(-4, 4.2);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, -4.2);
      ctx.closePath();
      ctx.fillStyle = COLORS.cream;
      ctx.fill();
      ctx.restore();

      // Faint vignette, so the map's edge reads as an edge rather than a crop.
      const shade = ctx.createRadialGradient(midX, midY, size * 0.28, midX, midY, size * 0.72);
      shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
      shade.addColorStop(1, 'rgba(4, 9, 12, 0.42)');
      ctx.fillStyle = shade;
      ctx.fillRect(x, y, size, size);

      compass(ctx, x + size - 18, y + 18, 12, bearing);
    }

    ctx.restore();

    roundRect(ctx, x + 0.5, y + 0.5, size - 1, size - 1, 10);
    ctx.strokeStyle = COLORS.panelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Bottom-left hint strip: what the two keys not shown elsewhere do right now. */
  function drawHint(ctx, world, w, h) {
    const player = world.player ?? {};
    const car = player.car;
    const text = car
      ? `${Math.round(Math.abs(Number(car.speed) || 0) / 2.4)} km/h \u00b7 E to step out`
      : 'Shift to run \u00b7 E to take a car';
    const room = Math.max(120, w - MARGIN - RIGHT - MINIMAP - 40);

    setFont(ctx, 11, '600');
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN + 4, h - BOTTOM - 14, room, 20);
    ctx.clip();
    ctx.translate(MARGIN + 4, h - BOTTOM + 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(247, 241, 226, 0.62)';
    fitText(ctx, text, room);
    ctx.restore();
  }

  /**
   * The interaction prompt, centred just above the hint strip, and the toast strip above it. The
   * toast is pinned to the left margin with its own padding, capped in width so it can never reach
   * the centred prompt or the minimap.
   */
  function drawPrompts(ctx, w, h, interaction) {
    const cx = w / 2;
    const promptBottom = h - BOTTOM - 26;
    const hasPrompt = !!(interaction && interaction.label);

    let pillTop = promptBottom;
    if (hasPrompt) {
      setFont(ctx, 13, '600');
      const labelW = ctx.measureText(interaction.label).width;
      const pillH = 34;
      const pillW = Math.min(w - MARGIN - RIGHT - 24, Math.max(180, labelW + 78));
      const pillX = cx - pillW / 2;
      const pillY = promptBottom - pillH;
      pillTop = pillY;

      roundRect(ctx, pillX, pillY, pillW, pillH, 8);
      ctx.fillStyle = 'rgba(14, 22, 28, 0.86)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(242, 199, 92, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      roundRect(ctx, pillX + 8, pillY + 7, 22, pillH - 14, 5);
      ctx.fillStyle = 'rgba(242, 199, 92, 0.20)';
      ctx.fill();
      setFont(ctx, 11, '800');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.gold;
      ctx.fillText('E', pillX + 19, pillY + pillH / 2);

      setFont(ctx, 13, '600');
      ctx.save();
      ctx.beginPath();
      ctx.rect(pillX + 38, pillY, pillW - 46, pillH);
      ctx.clip();
      ctx.translate(pillX + 38, pillY + pillH / 2 + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.cream;
      fitText(ctx, interaction.label, pillW - 46);
      ctx.restore();
    }

    if (!message || messageTimer <= 0) return;

    // Fade out over the last fraction of a second the toast has left.
    const fadeWindow = Math.min(0.45, messageSeconds);
    const alpha = clamp(messageTimer / (fadeWindow || 1), 0, 1);

    setFont(ctx, 13, '600');
    const textW = ctx.measureText(message).width;
    const maxW = Math.max(160, Math.min(
      w - MARGIN - RIGHT - MINIMAP - 40,
      cx - MARGIN - 96,
    ));
    const toastW = Math.min(maxW, Math.max(160, textW + 32));
    const toastH = 34;
    const toastX = MARGIN + 8;
    const toastY = pillTop - 10 - toastH;

    ctx.globalAlpha = alpha;
    roundRect(ctx, toastX, toastY, toastW, toastH, 8);
    ctx.fillStyle = 'rgba(14, 22, 28, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(242, 199, 92, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(toastX + 14, toastY, Math.max(0, toastW - 28), toastH);
    ctx.clip();
    ctx.translate(toastX + 14, toastY + toastH / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.cream;
    fitText(ctx, message, toastW - 28);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Everything over the world: status, objective, cash, hint, minimap, prompts. */
  function drawGame(ctx, world, interaction = null) {
    const state = world ?? {};
    frame(ctx, (w, h) => {
      drawStatus(ctx, state, w);
      drawObjective(ctx, state, w);
      drawCash(ctx, state, w);
      drawMinimap(ctx, state, w, h);
      drawHint(ctx, state, w, h);
      drawPrompts(ctx, w, h, interaction);
    });
  }

  /** The title card: wordmark, prompt, control caps, and the small print at the bottom. */
  function drawTitle(ctx, view, options = {}) {
    const time = Number.isFinite(options.time) ? options.time : 0;
    const hasSave = !!options.hasSave;

    frame(ctx, (w, h) => {
      const cx = w / 2;
      const safe = w - MARGIN * 2;
      const top = Math.max(64, Math.min(h * 0.24, h - 300));

      veil(ctx, w, h, 0.46);

      // Wordmark with a soft drop shadow, sized to the screen but never wider than the safe area.
      const titleSize = Math.min(96, Math.max(44, w * 0.075));
      setFont(ctx, titleSize, '800');
      const titleW = ctx.measureText('SOLMAR').width;
      const fit = titleW > safe ? safe / titleW : 1;
      setFont(ctx, Math.floor(titleSize * fit), '800');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillText('SOLMAR', cx + 3, top + 3);
      ctx.fillStyle = COLORS.gold;
      ctx.fillText('SOLMAR', cx, top);

      banner(ctx, cx, top + 42, 'AN OPEN-WORLD CITY BY THE SEA', 12, COLORS.muted);

      const pulse = 0.62 + 0.38 * Math.sin(time * 2.6);
      setFont(ctx, 20, '700');
      ctx.fillStyle = COLORS.cream;
      ctx.globalAlpha = pulse;
      ctx.fillText('PRESS ENTER TO START', cx, top + 98);
      ctx.globalAlpha = 1;

      if (hasSave) {
        setFont(ctx, 13, '600');
        ctx.fillStyle = COLORS.muted;
        ctx.fillText('L continues your last session', cx, top + 124);
      }

      const rows = [
        [
          { key: 'WASD', action: 'walk / drive' },
          { key: 'SHIFT', action: 'run' },
          { key: 'SPACE', action: 'handbrake' },
          { key: 'E', action: 'in / out' },
          { key: 'ESC', action: 'pause' },
        ],
        [
          { key: 'F5', action: 'save' },
          { key: 'F9', action: 'load' },
        ],
      ];
      const rowY = top + 158;
      for (let i = 0; i < rows.length; i += 1) {
        const total = keyCapsWidth(ctx, rows[i]);
        const startX = total > safe ? MARGIN : cx - total / 2;
        keyCaps(ctx, startX, rowY + i * 62, rows[i], safe);
      }

      setFont(ctx, 11, '600');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(169, 179, 184, 0.78)';
      ctx.fillText('Built from a seed, one street at a time.', cx, h - BOTTOM - 4);
    });

    void view;
  }

  /** Pause card: dimmed world, a summary of the run so far, and the way back. */
  function drawPause(ctx, view, world) {
    const state = world ?? {};

    frame(ctx, (w, h) => {
      veil(ctx, w, h, 0.66);

      const cx = w / 2;
      const cardW = Math.min(470, w - MARGIN - RIGHT - 12);
      const cardH = 300;
      const cardX = cx - cardW / 2;
      const cardY = h / 2 - cardH / 2;

      panel(ctx, cardX, cardY, cardW, cardH, 14);

      setFont(ctx, 30, '800');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.cream;
      ctx.fillText('PAUSED', cx, cardY + 52);

      const player = state.player ?? {};
      const lines = [
        ['Cash', formatMoney(player.money ?? 0)],
        ['Health', `${Math.round(clamp(Number(player.health ?? 0), 0, 100))} / 100`],
        ['Time', `${formatClock(state.clock ?? 0)} \u00b7 day ${Math.max(1, Math.round(state.day ?? 1))}`],
        ['Wanted', `${clamp(Math.round(state.wanted ?? 0), 0, MAX_STARS)} / ${MAX_STARS}`],
        ['Jobs done', String(Math.max(0, Math.round(state.jobsDone ?? 0)))],
      ];

      const innerX = cardX + 24;
      const innerW = cardW - 48;
      for (let i = 0; i < lines.length; i += 1) {
        row(ctx, lines[i][0], lines[i][1], innerX, cardY + 90 + i * 24, innerW);
      }

      const ruleY = cardY + 110 + (lines.length - 1) * 24;
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(innerX, ruleY);
      ctx.lineTo(innerX + innerW, ruleY);
      ctx.stroke();

      const caps = [
        { key: 'ESC', action: 'resume' },
        { key: 'F5', action: 'save' },
        { key: 'F9', action: 'load' },
      ];
      const total = keyCapsWidth(ctx, caps);
      keyCaps(ctx, total > innerW ? innerX : cx - total / 2, cardY + cardH - 76, caps, innerW);
    });

    void view;
  }

  /** The wasted card: the run is over, one key restarts it. */
  function drawOver(ctx, view, world) {
    const state = world ?? {};

    frame(ctx, (w, h) => {
      veil(ctx, w, h, 0.74);

      const cx = w / 2;
      const cy = h / 2;
      const player = state.player ?? {};
      const day = Math.max(1, Math.round(state.day ?? 1));
      const clock = formatClock(state.clock ?? 0);
      const jobs = Math.max(0, Math.round(state.jobsDone ?? 0));
      const safe = w - MARGIN * 2;

      const size = Math.min(62, Math.max(34, w * 0.052));
      banner(ctx, cx, cy - 42, 'WASTED', size, COLORS.red);

      setFont(ctx, 14, '600');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLORS.cream;
      const earned = `${formatMoney(player.money ?? 0)} earned \u00b7 ${jobs} jobs`;
      ctx.fillText(earned, cx, cy + 4, safe);

      setFont(ctx, 12, '600');
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`Day ${day} \u00b7 ${clock}`, cx, cy + 28, safe);

      const pulse = 0.62 + 0.38 * Math.sin((Number.isFinite(state.time) ? state.time : 0) * 2.6);
      setFont(ctx, 16, '700');
      ctx.globalAlpha = pulse;
      ctx.fillStyle = COLORS.gold;
      ctx.fillText('PRESS ENTER TO TRY AGAIN', cx, cy + 74);
      ctx.globalAlpha = 1;
    });

    void view;
  }

  /** Fade-to-black sheet; `alpha` is 0 (clear) to 1 (black). */
  function drawFade(ctx, view, alpha) {
    const strength = clamp(Number(alpha) || 0, 0, 1);
    if (strength <= 0.001) return;

    frame(ctx, (w, h) => {
      ctx.fillStyle = `rgba(4, 8, 11, ${strength})`;
      ctx.fillRect(0, 0, w, h);
    });

    void view;
  }

  return {
    say,
    update,
    drawTitle,
    drawGame,
    drawPause,
    drawOver,
    drawFade,
  };
}