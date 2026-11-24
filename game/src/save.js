/*
 * Save slots.
 *
 * Three numbered slots (1..3), each JSON encoded and written defensively:
 *   - slot N lives under `${SAVE.key}.slot.N`
 *   - a backup of the last known-good payload sits beside it under
 *     `${SAVE.key}.slot.N.backup`, written *before* the slot is overwritten
 *   - the active slot index lives under `${SAVE.key}.active`
 *   - `${SAVE.key}` itself is kept as a mirror of the active slot, so older
 *     builds and hand-written tooling that only know the single-key layout
 *     still find a readable payload
 *   - every payload carries a schema version and a wall-clock stamp
 *
 * SLOTS. The module always exposes at least three slots even when the
 * config asks for fewer: slots 1 and 2 were added on top of the original
 * single-slot layout, so a build that ships `SAVE.slots: 1` still gets the
 * three the UI draws. SAVE_SLOT_IDS is the canonical list.
 *
 * Format changes are handled by migrate(), which upgrades older payloads on
 * read instead of rejecting them outright: version 0 (pre-versioned, just
 * { player }), version 1 ({ version, savedAt, player }), version 2 (same
 * plus migration bookkeeping) all land on the version 3 slot payload, and
 * version 3 lands on version 4. Payloads from a newer version than this build
 * understands are refused: silently downgrading them would destroy fields we
 * cannot interpret.
 *
 * Version 4 changes no existing field. It adds an optional `integrity` stamp
 * ({ algo, hash, bytes }) that writeSaveTo() attaches so a truncated or
 * hand-edited storage payload can be told apart from a valid one, and it is
 * the version every read path is validated against: validateSave() checks the
 * required fields, their types and their plausible ranges before anything is
 * handed to the game. Validation never rewrites a loadable save — problems
 * with optional fields come back as warnings — and a payload that cannot be
 * interpreted comes back as null with a human-readable reason instead of
 * throwing.
 *
 * Version 5 adds the `stats` block: lifetime counters that describe what the
 * player has done rather than where they are standing. It is optional on
 * read (a v4 save upgrades with zeroed counters) and is never required for a
 * payload to load, so a hand-trimmed save still works:
 *
 *   stats = {
 *     missionsCompleted, missionsFailed, missionsStarted,
 *     carsStolen, carsBought, pedsHit, copsDowned,
 *     distanceWalked, distanceDriven   // world units
 *   }
 *
 * Pre-slot installs also left saves under the keys listed in
 * SAVE.migrateFrom. Those are never read implicitly — migrateLegacySaves()
 * promotes them into real slots once, and only drops the legacy key after
 * it has read the new slot back.
 */

import { SAVE } from './config.js';

/* Current schema version. Bump this whenever the payload shape changes. */
const VERSION = 5;

/* Version 0 is the pre-versioned shape; version 1 is the oldest stamped one. */
const MIN_READABLE = 0;

const DEFAULT_SLOTS = 3;
const MAX_SLOTS = 16;
/* The floor SAVE.slots can never go below: three slots ship with the game. */
const MIN_SLOTS = 3;
const DEFAULT_MAX_KB = 512;

/* Integrity stamps are a cheap tamper/truncation signal, not a signature:
 * the hash is a non-cryptographic 32-bit FNV-1a over the payload body. It is
 * deliberately synchronous so the save path stays synchronous. */
const INTEGRITY_ALGO = 'fnv1a32';

/*
 * Plausible upper bounds used by validateSave(). They are not game rules —
 * they exist so a wildly out-of-range number (a NaN that JSON turned into
 * null, a coordinate that overflowed, a hand-edited money field) is reported
 * instead of being loaded silently. The simulation's own clamps still decide
 * what actually applies.
 */
const LIMITS = Object.freeze({
  coord: 1e6,        // player.x / player.y / facing
  money: 1e9,
  health: 1e6,
  ammo: 1e6,
  stamina: 1e4,
  clock: 1440,       // minutes in one in-game day
  day: 1e6,
  heat: 1e5,
  playtime: 1e9,
  savedAt: 4e12,     // ms since epoch, ~year 2096
  count: 1e9,        // lifetime stat counters
  distance: 1e12,    // world units walked/driven
});

/*
 * Lifetime statistics. Every counter is a non-negative integer (distances
 * may be fractional) and every one is optional: a payload that omits the
 * whole block upgrades with zeroes, and a payload carrying a garbage value
 * only earns a warning. STAT_KEYS is what normalizeStats() walks, so adding
 * a counter is a one-line change here plus the doc comment at the top.
 */
const STAT_KEYS = Object.freeze([
  'missionsCompleted',
  'missionsFailed',
  'missionsStarted',
  'carsStolen',
  'carsBought',
  'pedsHit',
  'copsDowned',
  'distanceWalked',
  'distanceDriven',
]);

const DISTANCE_STATS = Object.freeze(['distanceWalked', 'distanceDriven']);

function emptyStats() {
  const out = {};
  for (const key of STAT_KEYS) out[key] = 0;
  return out;
}

/*
 * normalizeStats(value) -> stats
 *
 * Coerces a stats block into a complete, valid one. Unknown keys are
 * dropped (so a future build's counters cannot smuggle junk into a
 * round trip), known keys are clamped to plausible non-negative values, and
 * anything unreadable becomes 0. Never throws, always returns every key.
 */
function normalizeStats(value) {
  const out = emptyStats();
  if (!isPlainObject(value)) return out;
  for (const key of STAT_KEYS) {
    const n = numberOf(value[key]);
    if (n === null || n < 0) continue;
    out[key] = DISTANCE_STATS.includes(key) ? Math.min(n, LIMITS.distance) : Math.floor(Math.min(n, LIMITS.count));
  }
  return out;
}


/* ------------------------------------------------------------------ */
/* environment                                                         */
/* ------------------------------------------------------------------ */

/* localStorage throws in private-mode/disabled-storage browsers, so the
 * lookup itself is guarded, not just the reads. globalThis keeps the module
 * importable outside a browser (tests, node --check) where it resolves to
 * nothing and every call degrades to the unavailable path. */
function getStore() {
  try {
    const store = globalThis.localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readKey(store, key) {
  try {
    const raw = store.getItem(key);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function writeKey(store, key, value) {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function dropKey(store, key) {
  try {
    store.removeItem(key);
  } catch {
    /* storage unavailable or blocked — nothing sensible to do */
  }
}

/* ------------------------------------------------------------------ */
/* keys                                                                */
/* ------------------------------------------------------------------ */

const BASE_KEY = typeof SAVE?.key === 'string' && SAVE.key ? SAVE.key : 'solmar.save';
const BACKUP_KEY = `${BASE_KEY}.backup`;
const ACTIVE_KEY = `${BASE_KEY}.active`;
const SLOT_PREFIX = `${BASE_KEY}.slot.`;

/* Keys written by older builds. Filtered so a bad config cannot make us
 * read arbitrary storage entries. */
const LEGACY_KEYS = (() => {
  const configured = Array.isArray(SAVE?.migrateFrom) ? SAVE.migrateFrom : [];
  const seen = new Set([BASE_KEY]);
  const keys = [];
  for (const key of configured) {
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
})();

function slotKey(id) {
  return `${SLOT_PREFIX}${id}`;
}

function slotBackupKey(id) {
  return `${SLOT_PREFIX}${id}.backup`;
}

function slotCount() {
  const configured = Number.isInteger(SAVE?.slots) ? SAVE.slots : DEFAULT_SLOTS;
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, configured));
}

/** The canonical slot ids, in display order: [1, 2, 3, ...]. */
export function saveSlotIds() {
  const ids = [];
  for (let id = 1; id <= slotCount(); id += 1) ids.push(id);
  return ids;
}

function maxPayloadBytes() {
  const kb = Number.isFinite(SAVE?.maxSizeKb) ? SAVE.maxSizeKb : DEFAULT_MAX_KB;
  return Math.max(1, Math.floor(kb)) * 1024;
}

/* Slot ids arrive from the UI as strings as often as numbers, so accept
 * both and reject everything that is not a whole number in range. */
function normalizeSlotId(value) {
  const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(id)) return null;
  if (id < 1 || id > slotCount()) return null;
  return id;
}

/* ------------------------------------------------------------------ */
/* schema                                                              */
/* ------------------------------------------------------------------ */

function parseJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function byteLength(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    /* TextEncoder is missing only in exotic hosts; UTF-16 length is a
     * conservative-enough upper estimate for a quota guard. */
    return text.length * 2;
  }
}

/*
 * Non-cryptographic 32-bit FNV-1a over a string, as 8 lowercase hex digits.
 * Cheap, synchronous and stable across engines — good enough to notice a
 * truncated write or a payload edited by hand, and useless as a signature.
 */
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (text.charCodeAt(i) >> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/* Serialize a payload body for hashing. `integrity` is storage bookkeeping,
 * never part of the body, so it is dropped on both sides of the comparison. */
function bodyText(payload) {
  const { integrity, ...body } = payload;
  void integrity;
  return JSON.stringify(body);
}

/**
 * stampIntegrity(payload) -> object
 *
 * Returns a copy of payload with an `integrity` stamp of its body appended
 * last. The copy is what gets written to storage; callers never see the
 * stamp because migrate() strips it again on read.
 */
function stampIntegrity(payload) {
  const text = bodyText(payload);
  return {
    ...payload,
    integrity: { algo: INTEGRITY_ALGO, hash: hashText(text), bytes: byteLength(text) },
  };
}

/**
 * checkIntegrity(parsed) -> 'absent' | 'ok' | 'bad'
 *
 * 'absent' is the expected answer for every save written before version 4 and
 * for payloads imported from a text backup, so it is never an error. 'bad'
 * means the stamp is present but does not match: the payload was truncated,
 * hand-edited, or written by something that mangled it.
 */
function checkIntegrity(parsed) {
  const stamp = parsed?.integrity;
  if (stamp === undefined || stamp === null) return 'absent';
  if (!isPlainObject(stamp)) return 'bad';
  if (stamp.algo !== INTEGRITY_ALGO || typeof stamp.hash !== 'string') return 'bad';
  const text = bodyText(parsed);
  if (Number.isFinite(stamp.bytes) && stamp.bytes !== byteLength(text)) return 'bad';
  return hashText(text) === stamp.hash ? 'ok' : 'bad';
}

/* A finite number, or null when the value is not one. Strings that hold a
 * number are accepted because older writers occasionally stringified counts;
 * anything else (null, booleans, objects, objects with a bad toString) is
 * rejected rather than coerced, so `null` cannot masquerade as 0. */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/*
 * Field table consumed by validateSave(). `level: 'fatal'` means the payload
 * cannot be interpreted at all; `'warn'` means the value is out of its
 * plausible range but the game's own clamps handle it, so the save still
 * loads. Everything listed with a path is optional: absent fields are never
 * reported, which keeps version 0-2 payloads quiet.
 */
const FIELDS = [
  { path: ['player', 'x'], kind: 'number', min: -LIMITS.coord, max: LIMITS.coord, level: 'fatal' },
  { path: ['player', 'y'], kind: 'number', min: -LIMITS.coord, max: LIMITS.coord, level: 'fatal' },
  { path: ['player', 'facing'], kind: 'number', min: -LIMITS.coord, max: LIMITS.coord },
  { path: ['player', 'health'], kind: 'number', min: 0, max: LIMITS.health },
  { path: ['player', 'maxHealth'], kind: 'number', min: 0, max: LIMITS.health },
  { path: ['player', 'money'], kind: 'number', min: 0, max: LIMITS.money },
  { path: ['player', 'ammo'], kind: 'number', min: 0, max: LIMITS.ammo },
  { path: ['player', 'ammoReserve'], kind: 'number', min: 0, max: LIMITS.ammo },
  { path: ['player', 'stamina'], kind: 'number', min: 0, max: LIMITS.stamina },
  { path: ['player', 'hp'], kind: 'number', min: 0, max: LIMITS.health },
  { path: ['clock'], kind: 'number', min: -LIMITS.clock, max: LIMITS.clock },
  { path: ['day'], kind: 'number', min: 1, max: LIMITS.day },
  { path: ['heat'], kind: 'number', min: 0, max: LIMITS.heat },
  { path: ['earned'], kind: 'number', min: 0, max: LIMITS.money },
  { path: ['jobsDone'], kind: 'number', min: 0, max: 1e6 },
  { path: ['storyIndex'], kind: 'number', min: 0, max: 1e6 },
  { path: ['savedAt'], kind: 'number', min: 0, max: LIMITS.savedAt },
  { path: ['meta', 'playtime'], kind: 'number', min: 0, max: LIMITS.playtime },
  { path: ['meta', 'name'], kind: 'string', maxLength: 64 },
  /* v5 lifetime counters — all optional, so their level is the default
   * ('warn'): a stray value never blocks a load. */
  { path: ['stats', 'missionsCompleted'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'missionsFailed'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'missionsStarted'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'carsStolen'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'carsBought'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'pedsHit'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'copsDowned'], kind: 'number', min: 0, max: LIMITS.count },
  { path: ['stats', 'distanceWalked'], kind: 'number', min: 0, max: LIMITS.distance },
  { path: ['stats', 'distanceDriven'], kind: 'number', min: 0, max: LIMITS.distance },
];

function fieldAt(data, path) {
  let cursor = data;
  for (const key of path) {
    if (!isPlainObject(cursor)) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return { present: false };
    cursor = cursor[key];
  }
  return { present: true, value: cursor };
}

/**
 * validateSave(data) -> { ok, reason, errors, warnings }
 *
 * Schema check for an already-migrated payload: required fields, their types,
 * and plausible ranges. It never throws and never mutates `data`.
 *
 * `errors` is fatal — the payload cannot be used and readSave() returns null —
 * and its `reason` is a short human-readable sentence for logs and the UI.
 * `warnings` lists out-of-range or wrong-typed *optional* fields that the
 * game's own clamps already handle, so an old or slightly odd save still
 * loads instead of being refused.
 */
export function validateSave(data) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(data)) {
    return { ok: false, reason: 'save payload is not an object', errors: ['payload'], warnings };
  }
  if (!isPlainObject(data.player)) {
    return { ok: false, reason: 'save payload has no player block', errors: ['player'], warnings };
  }

  const version = data.version;
  if (!Number.isInteger(version)) errors.push('version');
  else if (version > VERSION) return { ok: false, reason: `save was written by a newer build (v${version} > v${VERSION})`, errors: ['version'], warnings };
  else if (version < MIN_READABLE) errors.push('version');

  for (const field of FIELDS) {
    const { present, value } = fieldAt(data, field.path);
    if (!present) {
      if (field.level === 'fatal') errors.push(field.path.join('.'));
      continue;
    }

    const name = field.path.join('.');
    let problem = null;

    if (field.kind === 'number') {
      const n = numberOf(value);
      if (n === null) problem = `${name} is not a finite number`;
      else if (n < field.min || n > field.max) problem = `${name} out of range (${n})`;
    } else if (field.kind === 'string') {
      if (typeof value !== 'string') problem = `${name} is not a string`;
      else if (value.length > field.maxLength) problem = `${name} is too long`;
    }

    if (problem === null) continue;
    if (field.level === 'fatal') errors.push(name);
    else warnings.push(problem);
  }

  if (errors.length > 0) {
    return { ok: false, reason: `save payload failed validation: ${errors.join(', ')}`, errors, warnings };
  }
  return { ok: true, reason: null, errors, warnings };
}

/*
 * migrate(data) -> normalized payload | null
 *
 * Accepts any parsed object, upgrades known older shapes to VERSION and
 * normalizes the invariants the rest of the game relies on (a player with
 * finite x/y). Returns null when the payload is unusable.
 *
 * The upgrade runs as a chain of single-step transforms so each historical
 * shape only needs to know how to become the next one:
 *
 *   v0  { player }                       pre-versioned
 *   v1  { version, savedAt, player }     first stamped build
 *   v2  v1 + migratedFrom                migration bookkeeping added
 *   v3  v2 + slot, meta                  multi-slot layout
 *   v4  v3 (+ integrity stamp)           integrity-checked payloads
 *   v5  v4 + stats                       lifetime counters
 */
function migrate(data) {
  if (!isPlainObject(data)) return null;

  const from = Number.isInteger(data.version) ? data.version : 0;
  if (from > VERSION) return null;          // written by a newer build
  if (from < MIN_READABLE) return null;     // negative / nonsense version

  let out = { ...data };
  const path = [];

  /* v0 -> v1: a bare { player } blob with no version and possibly no stamp.
   * Only accepted when it actually looks like a save, so random JSON that
   * happens to sit under one of our keys is still treated as corrupt. */
  if (from < 1) {
    if (!isPlainObject(out.player)) return null;
    path.push(0);
    if (!Number.isFinite(out.savedAt)) out.savedAt = Date.now();
    out.version = 1;
  }

  /* v1 -> v2: the player block stays, everything else gets defaults so
   * callers can read optional fields without null checks. */
  if (from < 2) {
    out.player = isPlainObject(out.player) ? { ...out.player } : out.player;
    if (!Number.isFinite(out.savedAt)) out.savedAt = Date.now();
    out.migratedFrom = from;
    path.push(1);
    out.version = 2;
  }

  /* v2 -> v3: slots are explicit and metadata gets a stable home. The player
   * block stays at the top level — every existing consumer reads it there. */
  if (from < 3) {
    out.slot = normalizeSlotId(out.slot) ?? 1;
    out.meta = isPlainObject(out.meta) ? { ...out.meta } : {};
    if (typeof out.meta.name !== 'string') out.meta.name = '';
    if (!Number.isFinite(out.meta.playtime) || out.meta.playtime < 0) out.meta.playtime = 0;
    path.push(2);
    out.version = 3;
  }

  /* v3 -> v4: deliberately no field changes. Version 4 only adds the optional
   * `integrity` stamp, which writeSaveTo() attaches and this function strips
   * again, so an upgraded v3 payload keeps every field it had. Nothing is
   * pushed onto `path` — there was no transform to record. */
  if (from < 4) {
    out.version = 4;
  }

  /* v4 -> v5: the lifetime stats block. A v4 save has done everything the
   * counters describe but never recorded it, so the counters start at zero
   * rather than pretending the playthrough was empty. Existing fields are
   * copied through untouched. */
  if (from < 5) {
    out.stats = normalizeStats(out.stats);
    path.push(4);
    out.version = 5;
  }

  /* Even at the current version, repair a missing or partial stats block: a
   * caller can hand us a payload it trimmed by hand. */
  out.stats = normalizeStats(out.stats);

  /* The stamp is storage bookkeeping, not save state: consumers must never
   * see it, and it must not survive a round trip through importSave(). */
  if (out.integrity !== undefined) delete out.integrity;

  /* Invariants every consumer depends on. */
  if (!isPlainObject(out.player)) return null;

  const x = Number(out.player.x);
  const y = Number(out.player.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const player = { ...out.player, x, y };
  if (player.hp !== undefined && !Number.isFinite(Number(player.hp))) delete player.hp;
  else if (player.hp !== undefined) player.hp = Number(player.hp);
  out.player = player;

  /* Timestamps are informational, but keep them well-formed. */
  if (!Number.isFinite(out.savedAt)) out.savedAt = Date.now();

  out.version = VERSION;

  /* Record how far we came from, without clobbering an older note. */
  if (path.length > 0) {
    if (!Number.isInteger(out.migratedFrom)) out.migratedFrom = from;
    if (!Number.isFinite(out.migratedAt)) out.migratedAt = out.savedAt;
    out.migratedPath = path;
  }

  return out;
}

/*
 * Pre-migration type check for the fields that make a payload loadable.
 *
 * migrate() coerces with Number(), which happily turns JSON `null` (what NaN
 * becomes on the way out) into 0. That would load a corrupt save at the world
 * origin instead of reporting it. Only fields that are actually present are
 * checked, so version 0-2 payloads are unaffected, and numeric strings are
 * still accepted for compatibility with older stringified writers.
 */
function rawTypeProblem(parsed) {
  if (!isPlainObject(parsed.player)) return null;   // migrate() explains this one
  for (const key of ['x', 'y']) {
    if (!Object.prototype.hasOwnProperty.call(parsed.player, key)) continue;
    if (numberOf(parsed.player[key]) === null) {
      return `player.${key} is not a finite number (corrupt save)`;
    }
  }
  return null;
}

/* Parse + migrate + validate one raw slot string.
 *
 * Returns { data, reason } so callers can report *why* a payload was refused.
 * `data` is null for anything validateSave() rejects; `reason` is null when
 * the payload is fine. Validation runs after migration so it always sees the
 * normalized shape, and it only rejects what migrate() already could not
 * interpret plus implausible required fields — a loadable save is never
 * turned away here. */
function loadSlot(raw) {
  const parsed = parseJson(raw);
  if (!parsed) return { data: null, reason: 'save payload is not valid JSON' };

  const typeProblem = rawTypeProblem(parsed);
  if (typeProblem !== null) return { data: null, reason: typeProblem };

  const data = migrate(parsed);
  if (!data) return { data: null, reason: 'save payload is unreadable or from a newer build' };
  const check = validateSave(data);
  if (!check.ok) return { data: null, reason: check.reason };
  return { data, reason: null };
}

/*
 * Classify a raw key without trusting it, so a payload written by a newer
 * build can be told apart from mere corruption: the former must be refused
 * outright (falling back would downgrade the player's progress), the latter
 * may fall back to a backup slot.
 *
 * An integrity mismatch is reported as 'corrupt', not 'future': the stamp
 * only exists on payloads this build wrote, so a mismatch means the bytes
 * were damaged in place rather than produced by a newer version.
 */
function inspectSlot(store, key) {
  const raw = readKey(store, key);
  if (raw === null) return { state: 'missing', data: null, reason: null };

  const parsed = parseJson(raw);
  if (!parsed) return { state: 'corrupt', data: null, reason: 'save payload is not valid JSON' };

  const version = Number.isInteger(parsed.version) ? parsed.version : 0;
  if (version > VERSION) {
    return { state: 'future', data: null, reason: `save was written by a newer build (v${version} > v${VERSION})` };
  }

  if (checkIntegrity(parsed) === 'bad') {
    return { state: 'corrupt', data: null, reason: 'save payload failed its integrity check (truncated or edited)' };
  }

  const loaded = loadSlot(raw);
  if (!loaded.data) return { state: 'corrupt', data: null, reason: loaded.reason };
  return { state: 'ok', data: loaded.data, reason: null };
}

/* ------------------------------------------------------------------ */
/* slot bookkeeping                                                    */
/* ------------------------------------------------------------------ */

function getActiveSlotId(store) {
  const raw = readKey(store, ACTIVE_KEY);
  const parsed = raw === null ? null : normalizeSlotId(raw.trim());
  return parsed ?? 1;
}

/* ------------------------------------------------------------------ */
/* resolution                                                          */
/* ------------------------------------------------------------------ */

/*
 * Sources are tried in a fixed order: the active slot, the plain-key mirror,
 * the pre-slot legacy keys, the remaining slots, and only then the backups
 * (active slot first, mirror last). A single 'future' source anywhere in the
 * live set poisons the whole read — mixing a newer payload's absence with an
 * older backup would silently roll progress back.
 */
function candidateSources(store, activeId) {
  const live = [{ key: slotKey(activeId), source: `slot:${activeId}` }];
  live.push({ key: BASE_KEY, source: 'primary' });
  for (const key of LEGACY_KEYS) live.push({ key, source: `legacy:${key}` });
  for (let id = 1; id <= slotCount(); id += 1) {
    if (id === activeId) continue;
    live.push({ key: slotKey(id), source: `slot:${id}` });
  }

  const backups = [{ key: slotBackupKey(activeId), source: `slot:${activeId}` }];
  for (let id = 1; id <= slotCount(); id += 1) {
    if (id === activeId) continue;
    backups.push({ key: slotBackupKey(id), source: `slot:${id}` });
  }
  backups.push({ key: BACKUP_KEY, source: 'primary' });

  return { live, backups };
}

function resolveSave() {
  const store = getStore();
  if (!store) return { state: 'missing', data: null, source: null, backup: false, reason: 'local storage is unavailable' };

  const activeId = getActiveSlotId(store);
  const { live, backups } = candidateSources(store, activeId);

  let sawFuture = false;
  let firstOk = null;
  let corruptReason = null;

  /* First pass over the live sources: a newer-build payload anywhere must
   * win over an older readable one, so nothing is returned until the whole
   * live set has been classified. */
  for (const { key, source } of live) {
    const result = inspectSlot(store, key);
    if (result.state === 'ok') {
      if (firstOk === null) firstOk = { state: 'ok', data: result.data, source, backup: false, reason: null };
    } else if (result.state === 'future') {
      sawFuture = true;
    } else if (result.state === 'corrupt' && corruptReason === null) {
      corruptReason = result.reason;
    }
  }

  if (sawFuture) {
    return { state: 'future', data: null, source: null, backup: false, reason: `save was written by a newer build (v${VERSION + 1}+)` };
  }
  if (firstOk !== null) return firstOk;

  for (const { key, source } of backups) {
    const result = inspectSlot(store, key);
    if (result.state === 'ok') {
      return { state: 'ok', data: result.data, source, backup: true, reason: null };
    }
    if (result.state === 'future') sawFuture = true;
    else if (result.state === 'corrupt' && corruptReason === null) corruptReason = result.reason;
  }

  if (sawFuture) {
    return { state: 'future', data: null, source: null, backup: false, reason: `save was written by a newer build (v${VERSION + 1}+)` };
  }
  /* No readable source: if something was there but unusable, say so rather
   * than reporting a clean "no save" — the UI can then explain the failure. */
  if (corruptReason !== null) {
    return { state: 'corrupt', data: null, source: null, backup: false, reason: corruptReason };
  }
  return { state: 'missing', data: null, source: null, backup: false, reason: null };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/** Current payload version understood by this build. */
export const SAVE_VERSION = VERSION;

/** Number of slots the config asks for, clamped to what we can address. */
export function saveSlotCount() {
  return slotCount();
}

/** Slot writes are refused above this many bytes (SAVE.maxSizeKb). */
export function saveSizeLimit() {
  return maxPayloadBytes();
}

/** True when any readable save exists (active slot, mirror, other slots,
 *  legacy keys, or a backup). A payload from a newer build counts as
 *  "no save": this build cannot load it. */
export function hasSave() {
  return resolveSave().state === 'ok';
}

/**
 * readSave() -> payload | null
 *
 * Returns the migrated save the game should continue from, in the same shape
 * as before: the player block stays at the top level and gains slot/meta
 * bookkeeping. A corrupt source falls through to the backup so one bad write
 * does not wipe a playthrough; a payload written by a newer build returns
 * null rather than a stale backup, because loading an older snapshot over
 * newer progress is a downgrade.
 */
export function readSave() {
  const resolved = resolveSave();
  return resolved.state === 'ok' ? resolved.data : null;
}

/**
 * readSaveReport() -> { state, data, source, backup, reason }
 *
 * readSave() plus the diagnosis: 'ok' | 'missing' | 'corrupt' | 'future',
 * which source answered, and a human-readable reason when nothing loaded.
 * Never throws; safe to call on a title screen before storage exists.
 */
export function readSaveReport() {
  const resolved = resolveSave();
  return {
    state: resolved.state,
    data: resolved.state === 'ok' ? resolved.data : null,
    source: resolved.source,
    backup: resolved.backup,
    reason: resolved.reason,
  };
}

/**
 * readSaveFrom(slotId) -> payload | null
 *
 * Reads one explicit slot (its backup included). Unknown ids and slots
 * written by a newer build return null instead of throwing, so the UI can
 * probe all slots without guarding each call.
 */
export function readSaveFrom(slotId) {
  const store = getStore();
  if (!store) return null;

  const id = normalizeSlotId(slotId);
  if (id === null) return null;

  const main = inspectSlot(store, slotKey(id));
  if (main.state === 'ok') return { ...main.data, slot: id };
  if (main.state === 'future') return null;

  const backup = inspectSlot(store, slotBackupKey(id));
  if (backup.state === 'ok') return { ...backup.data, slot: id };
  return null;
}

/**
 * inspectSaveFrom(slotId) -> { state, data, reason, source } | null
 *
 * The diagnostic form of readSaveFrom(): distinguishes 'missing' from
 * 'corrupt' and 'future', and carries a human-readable reason, so a slot
 * screen can explain a refusal instead of just showing an empty slot. Returns
 * null only when storage is unavailable or the id is unusable.
 */
export function inspectSaveFrom(slotId) {
  const store = getStore();
  if (!store) return null;

  const id = normalizeSlotId(slotId);
  if (id === null) return null;

  const main = inspectSlot(store, slotKey(id));
  if (main.state === 'ok') return { state: 'ok', data: { ...main.data, slot: id }, reason: null, source: `slot:${id}` };
  if (main.state === 'future') return { state: 'future', data: null, reason: main.reason, source: `slot:${id}` };

  const backup = inspectSlot(store, slotBackupKey(id));
  if (backup.state === 'ok') {
    return { state: 'ok', data: { ...backup.data, slot: id }, reason: null, source: `slot:${id}:backup` };
  }
  if (backup.state === 'future') return { state: 'future', data: null, reason: backup.reason, source: `slot:${id}:backup` };

  /* Nothing readable: report the first real explanation we found. */
  const reason = main.reason ?? backup.reason;
  const state = main.state === 'corrupt' || backup.state === 'corrupt' ? 'corrupt' : 'missing';
  return { state, data: null, reason, source: `slot:${id}` };
}

/**
 * writeSaveTo(slotId, data) -> boolean
 *
 * Copies the slot's current payload into its backup (only if it is valid),
 * then overwrites the slot with a freshly stamped payload. When the slot is
 * the active one, the plain-key mirror is refreshed best-effort. Returns
 * false when the slot id is unusable, storage is unavailable, the payload
 * exceeds SAVE.maxSizeKb, or the quota is exhausted; the previous payload is
 * left untouched in every failure case because setItem is atomic.
 */
export function writeSaveTo(slotId, data) {
  const store = getStore();
  if (!store) return false;

  const id = normalizeSlotId(slotId);
  if (id === null) return false;

  /* Preserve the outgoing save before it is replaced. */
  const previous = inspectSlot(store, slotKey(id));
  if (previous.state === 'ok') {
    const backup = { ...previous.data, backedUpAt: Date.now() };
    writeKey(store, slotBackupKey(id), JSON.stringify(backup));
  }

  const payload = {
    ...(isPlainObject(data) ? data : {}),
    version: VERSION,      // authoritative: callers cannot downgrade it
    savedAt: Date.now(),   // authoritative: callers cannot forge the stamp
    slot: id,              // authoritative: the key wins over the payload
    /* Every v5 write carries a complete stats block, so a reader never has
     * to distinguish "no counters yet" from "counters missing". */
    stats: normalizeStats(isPlainObject(data) ? data.stats : null),
  };

  /* Attach the integrity stamp last, so the hash covers the authoritative
   * fields rather than whatever the caller happened to pass in. */
  const stamped = stampIntegrity(payload);

  /* Callers pass whole game states; a runaway payload must not eat the
   * whole quota and take the backup with it. */
  const serialized = JSON.stringify(stamped);
  if (byteLength(serialized) > maxPayloadBytes()) return false;

  const written = writeKey(store, slotKey(id), serialized);
  if (!written) return false;

  if (id === getActiveSlotId(store)) {
    /* Best-effort compatibility mirror; the slot copy is authoritative, so a
     * quota failure here must not fail the save itself. */
    writeKey(store, BASE_KEY, serialized);
  }

  return true;
}

/**
 * writeSave(data) -> boolean
 *
 * Original single-key entry point. Writes the active slot (creating it if
 * the active index points at an empty one) and keeps the plain-key mirror in
 * step, so existing call sites keep working unchanged.
 */
export function writeSave(data) {
  const store = getStore();
  if (!store) return false;

  const id = getActiveSlotId(store);
  const written = writeSaveTo(id, data);
  if (!written) return false;

  /* writeSaveTo already mirrored when id was active; this covers the case
   * where the active index was unreadable and had to default. */
  writeKey(store, BASE_KEY, readKey(store, slotKey(id)));
  return true;
}

/** getActiveSlot() -> number: the slot writeSave() targets. */
export function getActiveSlot() {
  const store = getStore();
  if (!store) return 1;
  return getActiveSlotId(store);
}

/**
 * setActiveSlot(slotId) -> boolean
 *
 * Points future writeSave() calls at another slot. Returns false for ids
 * outside 1..SAVE.slots or when storage rejects the marker.
 */
export function setActiveSlot(slotId) {
  const store = getStore();
  if (!store) return false;

  const id = normalizeSlotId(slotId);
  if (id === null) return false;

  return writeKey(store, ACTIVE_KEY, String(id));
}

/**
 * listSlots() -> Array<{ id, active, exists, savedAt, name, playtime,
 *                        player, version, source, stats }>
 *
 * Cheap metadata view for a slot-select screen: never throws, never
 * mutates, and reports unreadable slots as exists: false with a status so
 * the UI can say "newer version" instead of "empty". `stats` is the slot's
 * lifetime counters block (zeroed when absent) so a slot card can show
 * missions done and cars stolen without a second read.
 */
export function listSlots() {
  const store = getStore();
  const activeId = store ? getActiveSlotId(store) : 1;
  const slots = [];

  for (let id = 1; id <= slotCount(); id += 1) {
    const entry = {
      id,
      active: id === activeId,
      exists: false,
      status: 'missing',
      reason: null,
      savedAt: null,
      name: '',
      playtime: 0,
      player: null,
      version: null,
      source: null,
      stats: null,
    };

    if (store) {
      const main = inspectSlot(store, slotKey(id));
      let result = main;
      let source = `slot:${id}`;

      /* Status parity with the pre-versioning build: the main key decides,
       * and only a readable backup can override it. `reason` is new
       * information carried alongside the same status values. */
      if (main.state !== 'ok') {
        const backup = inspectSlot(store, slotBackupKey(id));
        if (backup.state === 'ok') {
          result = backup;
          source = `slot:${id}:backup`;
        }
      }

      if (result.state === 'ok') {
        const data = result.data;
        entry.exists = true;
        entry.status = 'ok';
        entry.savedAt = Number.isFinite(data.savedAt) ? data.savedAt : null;
        entry.name = typeof data.meta?.name === 'string' ? data.meta.name : '';
        entry.playtime = Number.isFinite(data.meta?.playtime) ? data.meta.playtime : 0;
        entry.player = { x: data.player.x, y: data.player.y };
        entry.version = data.version;
        entry.source = source;
        entry.stats = normalizeStats(data.stats);
      } else if (result.state === 'future') {
        entry.status = 'future';
        entry.reason = result.reason;
      } else if (result.state === 'corrupt') {
        entry.status = 'corrupt';
        entry.reason = result.reason;
      } else if (main.state !== 'missing') {
        entry.reason = main.reason;
      }
    }

    slots.push(entry);
  }

  return slots;
}

/**
 * deleteSlot(slotId) -> boolean
 *
 * Drops one slot, its backup, and any plain-key mirror of that payload, so
 * a deleted save cannot come back through the mirror on the next read. When
 * the deleted slot was the active one, the active marker moves to the first
 * remaining slot that still has a payload (or stays put when none do).
 */
export function deleteSlot(slotId) {
  const store = getStore();
  if (!store) return false;

  const id = normalizeSlotId(slotId);
  if (id === null) return false;

  const wasActive = id === getActiveSlotId(store);

  dropKey(store, slotKey(id));
  dropKey(store, slotBackupKey(id));

  /* The mirror and its backup belong to the active slot. Leaving them
   * behind would let resolveSave() read the just-deleted payload straight
   * back out of BASE_KEY. */
  if (wasActive) {
    dropKey(store, BASE_KEY);
    dropKey(store, BACKUP_KEY);
  }

  /* Point the active marker at a slot that still holds something, so the
   * next autosave does not silently recreate the slot just deleted. */
  if (wasActive) {
    for (let other = 1; other <= slotCount(); other += 1) {
      if (other === id) continue;
      if (inspectSlot(store, slotKey(other)).state === 'ok') {
        writeKey(store, ACTIVE_KEY, String(other));
        break;
      }
    }
  }

  return true;
}

/**
 * deleteAllSlots() -> number
 *
 * The "clear everything" button: drops every slot, every backup, the mirror
 * and the active marker. Returns how many slots were actually occupied
 * before the wipe, which a confirmation dialog can report back.
 */
export function deleteAllSlots() {
  const store = getStore();
  if (!store) return 0;

  let removed = 0;
  for (let id = 1; id <= slotCount(); id += 1) {
    if (inspectSlot(store, slotKey(id)).state !== 'missing') removed += 1;
    dropKey(store, slotKey(id));
    dropKey(store, slotBackupKey(id));
  }
  dropKey(store, BASE_KEY);
  dropKey(store, BACKUP_KEY);
  dropKey(store, ACTIVE_KEY);
  return removed;
}

/** True when the slot has a readable payload (or a readable backup). */
export function hasSlot(slotId) {
  const store = getStore();
  if (!store) return false;
  const id = normalizeSlotId(slotId);
  if (id === null) return false;
  if (inspectSlot(store, slotKey(id)).state === 'ok') return true;
  return inspectSlot(store, slotBackupKey(id)).state === 'ok';
}

/** The slot writeSave() would target next; 1 when none is marked. */
export function activeSlot() {
  const store = getStore();
  return store ? getActiveSlotId(store) : 1;
}

/**
 * clearSave() -> void
 *
 * Drops the active slot, its backup, the plain-key mirror and the mirror's
 * backup. Kept void for compatibility with existing callers.
 */
export function clearSave() {
  const store = getStore();
  if (!store) return;

  const activeId = getActiveSlotId(store);
  dropKey(store, slotKey(activeId));
  dropKey(store, slotBackupKey(activeId));
  dropKey(store, BASE_KEY);
  dropKey(store, BACKUP_KEY);
}

/** clearAllSaves() -> void: drops every slot, every backup and the markers. */
export function clearAllSaves() {
  const store = getStore();
  if (!store) return;

  for (let id = 1; id <= slotCount(); id += 1) {
    dropKey(store, slotKey(id));
    dropKey(store, slotBackupKey(id));
  }
  dropKey(store, BASE_KEY);
  dropKey(store, BACKUP_KEY);
  dropKey(store, ACTIVE_KEY);
}

/**
 * migrateLegacySaves() -> { migrated: number[], skipped: string[] }
 *
 * Promotes saves left under SAVE.migrateFrom into free slots. The new slot is
 * read back before the legacy key is removed, so a failure at any point
 * leaves the original untouched. Runs once in practice: afterwards the legacy
 * keys are gone and the call is a no-op.
 */
export function migrateLegacySaves() {
  const report = { migrated: [], skipped: [] };

  const store = getStore();
  if (!store) return report;

  const taken = new Set();
  for (let id = 1; id <= slotCount(); id += 1) {
    if (inspectSlot(store, slotKey(id)).state !== 'missing') taken.add(id);
  }

  for (const key of LEGACY_KEYS) {
    const legacy = inspectSlot(store, key);
    if (legacy.state !== 'ok') {
      if (legacy.state !== 'missing') report.skipped.push(key);
      continue;
    }

    let target = null;
    for (let id = 1; id <= slotCount(); id += 1) {
      if (!taken.has(id)) {
        target = id;
        break;
      }
    }
    if (target === null) {
      report.skipped.push(key);
      continue;
    }

    const payload = { ...legacy.data, slot: target, migratedFrom: legacy.data.migratedFrom ?? 0 };
    if (!writeSaveTo(target, payload)) {
      report.skipped.push(key);
      continue;
    }

    /* Read back before trusting the copy. */
    const check = inspectSlot(store, slotKey(target));
    if (check.state !== 'ok') {
      report.skipped.push(key);
      continue;
    }

    taken.add(target);
    dropKey(store, key);
    report.migrated.push(target);
  }

  return report;
}

/**
 * migrateSave(data) -> { data, from, to, migrated, reason }
 *
 * Public, storage-free entry point for upgrading a parsed payload. Safe on
 * anything: returns `migrated: false` and the caller's object untouched (same
 * reference) when it is already at SAVE_VERSION, and `{ data: null, reason }`
 * when the payload cannot be interpreted. Never throws.
 *
 * `from` is the version it came in as, `to` is always SAVE_VERSION on
 * success. Useful for a backup file being restored, or a payload handed over
 * by another tab.
 */
export function migrateSave(data) {
  if (!isPlainObject(data)) {
    return { data: null, from: null, to: null, migrated: false, reason: 'save payload is not an object' };
  }

  const from = Number.isInteger(data.version) ? data.version : 0;

  /* Already current: hand it back as-is, byte for byte, so callers that only
   * call this defensively never pay for a clone. */
  if (from === VERSION) {
    const check = validateSave(data);
    if (!check.ok) return { data: null, from, to: null, migrated: false, reason: check.reason };
    return { data, from, to: VERSION, migrated: false, reason: null };
  }

  if (from > VERSION) {
    return { data: null, from, to: null, migrated: false, reason: `save was written by a newer build (v${from} > v${VERSION})` };
  }

  const migrated = migrate(data);
  if (!migrated) return { data: null, from, to: null, migrated: false, reason: 'save payload is unreadable' };

  const check = validateSave(migrated);
  if (!check.ok) return { data: null, from, to: null, migrated: false, reason: check.reason };

  return { data: migrated, from, to: VERSION, migrated: true, reason: null };
}

/**
 * exportSave(slotId?) -> string | null
 *
 * Migrated JSON for backup files / share codes. Defaults to the slot
 * readSave() would use, so the round trip through importSave() is lossless.
 * The string is round-trip safe: it never contains the storage-only
 * `integrity` stamp, so a restored backup does not depend on this build's
 * hash function.
 */
export function exportSave(slotId) {
  const data = slotId === undefined ? readSave() : readSaveFrom(slotId);
  if (!data) return null;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return null;
  }
}

/**
 * validateImportedSave(raw) -> { ok, reason, warnings, data }
 *
 * Dry run for importSave(): parses, migrates and validates a text payload
 * without touching storage, so a UI can show "this backup is for v1, restore
 * it?" or "this file is not a Solmar save" before committing. `data` is the
 * migrated payload on success.
 */
export function validateImportedSave(raw) {
  const parsed = parseJson(typeof raw === 'string' ? raw : null);
  if (!parsed) return { ok: false, reason: 'backup is not a JSON object', warnings: [], data: null };

  const result = migrateSave(parsed);
  if (!result.data) return { ok: false, reason: result.reason, warnings: [], data: null };

  const check = validateSave(result.data);
  return { ok: check.ok, reason: check.reason, warnings: check.warnings, data: result.data };
}

/**
 * importSave(raw, slotId?) -> boolean
 *
 * Inverse of exportSave(), and the entry point for payloads from older
 * builds: anything migrate() understands lands in the target slot (active by
 * default) as a current-version payload. Returns false — never throws — for
 * malformed JSON, an unreadable payload, a slot id out of range, or a
 * storage write failure.
 */
export function importSave(raw, slotId) {
  const store = getStore();
  if (!store) return false;

  const result = validateImportedSave(typeof raw === 'string' ? raw : null);
  if (!result.ok || !result.data) return false;

  const target = slotId === undefined ? getActiveSlotId(store) : normalizeSlotId(slotId);
  if (target === null) return false;

  return writeSaveTo(target, result.data);
}

/* ------------------------------------------------------------------ */
/* lifetime statistics                                                 */
/* ------------------------------------------------------------------ */

/** The counter names carried by a save's `stats` block, in display order. */
export const SAVE_STAT_KEYS = STAT_KEYS;

/** A fresh, all-zero stats block. Callers get their own copy. */
export function emptySaveStats() {
  return emptyStats();
}

/**
 * readStats(slotId?) -> stats
 *
 * The lifetime counters from one slot (active by default), always complete
 * and always non-negative: a save written before v5, a corrupt block or a
 * missing slot all return zeroes rather than null, so a stats screen never
 * needs a null check. Unknown keys are dropped.
 */
export function readStats(slotId) {
  const data = slotId === undefined ? readSave() : readSaveFrom(slotId);
  return normalizeStats(data?.stats);
}

/**
 * writeStats(slotId, stats) -> boolean
 *
 * Merges counters into the stats block of an existing save without touching
 * anything else in the payload: read the slot, normalize the incoming
 * values, write it back through the usual backup + integrity path. Returns
 * false when the slot is empty/unreadable — counters are never allowed to
 * create a save, because a stats-only payload has no player position and
 * would not load.
 */
export function writeStats(slotId, stats) {
  const store = getStore();
  if (!store) return false;

  const id = normalizeSlotId(slotId);
  if (id === null) return false;

  const current = readSaveFrom(id);
  if (!current) return false;

  const merged = { ...normalizeStats(current.stats), ...normalizeStats(stats) };
  return writeSaveTo(id, { ...current, stats: merged });
}

/**
 * bumpStats(slotId, delta, options?) -> stats | null
 *
 * Adds to one or more counters in place and returns the new block. This is
 * the call site a game loop wants: `bumpStats(1, { carsStolen: 1 })` after a
 * hotwire, `bumpStats(1, { missionsCompleted: 1, distanceDriven: 412.5 })`
 * when a job lands. Negative deltas are ignored (counters only go up) and
 * unknown keys are dropped, so a typo cannot corrupt a save.
 *
 *   slotId   target slot, or undefined for the active one
 *   delta    partial stats object
 *   options  { save: false } skips the write and just returns the preview
 */
export function bumpStats(slotId, delta, options = {}) {
  const target = slotId === undefined ? activeSlot() : normalizeSlotId(slotId);
  if (target === null) return null;

  const base = readStats(target);
  const add = normalizeStats(delta);
  const next = { ...base };
  for (const key of STAT_KEYS) next[key] = base[key] + add[key];

  if (options.save === false) return next;
  return writeStats(target, next) ? next : null;
}

/** Format a stats block for a slot list or a results screen. Distances are
 *  world units, reported in kilometres at one unit per metre (matching
 *  SPEEDS.toKmh in config.js). */
export function formatStats(stats) {
  const s = normalizeStats(stats);
  const km = (units) => `${(units / 1000).toFixed(2)} km`;
  return {
    missions: `${s.missionsCompleted} done / ${s.missionsFailed} failed`,
    missionsCompleted: s.missionsCompleted,
    carsStolen: s.carsStolen,
    walked: km(s.distanceWalked),
    driven: km(s.distanceDriven),
    row: `${s.missionsCompleted} missions · ${s.carsStolen} cars stolen · ${km(s.distanceDriven)} driven`,
  };
}
