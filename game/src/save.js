// The save slot: one versioned JSON blob in localStorage. Every path in and out is guarded, so a
// private window, an exhausted quota or a hand-edited value degrade into "no save" instead of
// throwing into the game loop. A payload written by a future version is ignored rather than half
// read: Solmar has exactly one save format, and it does not migrate.

import { SAVE } from './config.js';

/** The payload version this build understands; anything else counts as foreign. */
const VERSION = 1;

/** localStorage, or null when the browser will not hand it over (policy, sandbox, privacy mode). */
function storage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Parse and shape-check a raw slot value. Returns the object, or null if it is not ours. */
function parse(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.version !== VERSION) return null;
  return data;
}

/** True when a readable save of this version is sitting in the slot. */
export function hasSave() {
  const store = storage();
  if (!store) return false;
  try {
    return parse(store.getItem(SAVE.key)) !== null;
  } catch {
    return false;
  }
}

/** The stored save, or null when there is none, it is foreign, or it carries no usable position. */
export function readSave() {
  const store = storage();
  if (!store) return null;
  let data;
  try {
    data = parse(store.getItem(SAVE.key));
  } catch {
    return null;
  }
  if (!data) return null;
  // A position is the one thing the game cannot invent, so refuse a save that has no real one.
  if (!data.player || !Number.isFinite(data.player.x) || !Number.isFinite(data.player.y)) return null;
  return data;
}

/**
 * Write `data` into the slot stamped with this build's version and a timestamp. Returns true when it
 * landed; false means storage is absent, full or read-only, and the game simply carries on.
 */
export function writeSave(data) {
  const store = storage();
  if (!store) return false;
  try {
    const payload = { version: VERSION, savedAt: Date.now(), ...data };
    store.setItem(SAVE.key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Delete the slot. A missing slot, or no storage at all, still counts as cleared. */
export function clearSave() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(SAVE.key);
  } catch {
    // Nothing to do: there is no usable storage to clear.
  }
}
