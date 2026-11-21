// Solmar, build N10-S1 (foundation): config, utils, city, input and save rewritten from their reference specs with identical behavior and exports; this entry copies game/ and screenshots/ to /output and writes the dossier via vendor/makefun-game.ts (MAKEFUN_OUTPUT_DIR overrides /output; `node serve.ts` serves locally).
//
// The entry clears the output directory first, then validates its inputs (a game/ directory, with game/index.html)
// and refuses with a clear message and a non-zero exit before it copies or creates anything, so a failed build
// leaves neither a stale dossier.json, screenshot or game file from an earlier run nor a partial output directory.
//
// After the dossier is written it is read back and checked: it must parse as JSON and declare the makefun/dossier/v1
// schema, or the build fails like any other and clears what it wrote. A build that passes prints one summary line —
// the output directory, the dossier's size in bytes, and how many screenshots and game files were copied there — so
// the run says what it handed in instead of only that it finished.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier, DOSSIER_SCHEMA } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const gameDir = join(here, 'game');
const shotsDir = join(here, 'screenshots');

/** Writes why the build cannot run to stderr and exits non-zero. */
function refuse(message: string): never {
  console.error(`solmar: build failed: ${message}`);
  process.exit(1);
  throw new Error(message);
}

/** Whether a path is an existing directory, without throwing on one that is missing or unreadable. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The regular files under `dir`, recursively: the entries a copy of it carries, directories themselves not counted. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Reads the dossier back from disk, proves it is the JSON this build means to hand in, and prints the one summary
 * line. Throws on anything a reader of the output could trip over, so the caller clears the output and refuses.
 */
function verifyBuild(): void {
  const dossierPath = join(out, 'dossier.json');
  let raw: Buffer;
  try {
    raw = readFileSync(dossierPath);
  } catch (err) {
    throw new Error(`cannot read back the dossier at ${dossierPath} (${err instanceof Error ? err.message : String(err)})`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`the dossier at ${dossierPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  const schema = typeof doc === 'object' && doc !== null ? (doc as { schema?: unknown }).schema : undefined;
  if (schema !== DOSSIER_SCHEMA) {
    throw new Error(`the dossier at ${dossierPath} declares schema ${JSON.stringify(schema)}, not ${JSON.stringify(DOSSIER_SCHEMA)}: it was not written, or not written correctly`);
  }

  const dossierBytes = statSync(dossierPath).size;
  const screenshots = filesUnder(join(out, 'screenshots')).length;
  const gameFiles = filesUnder(join(out, 'game')).length;
  console.log(
    `solmar: build ok: output ${out}, dossier.json ${dossierBytes} bytes (schema ${DOSSIER_SCHEMA}), ${screenshots} screenshot${screenshots === 1 ? '' : 's'}, ${gameFiles} game file${gameFiles === 1 ? '' : 's'}`,
  );
}

// Clear first: an earlier build's output (its dossier.json, its screenshots, game files since removed) must never
// survive into this one, and a build that then fails below leaves no stale dossier beside a half-copied game/.
try {
  rmSync(out, { recursive: true, force: true });
} catch (err) {
  refuse(`cannot clear the output directory ${out} (${err instanceof Error ? err.message : String(err)})`);
}

// Fail fast: the inputs are checked before anything is created or copied, so a checkout without a game leaves no
// output at all, partial or otherwise.
if (!isDirectory(gameDir)) refuse(`no game/ directory at ${gameDir}: a build needs the game's static files, its index.html at the root`);
const indexHtml = join(gameDir, 'index.html');
if (!existsSync(indexHtml) || !lstatSync(indexHtml).isFile()) refuse(`no game/index.html at ${indexHtml}: a build needs the game's page at the root of game/`);

try {
  mkdirSync(out, { recursive: true });

  cpSync(gameDir, join(out, 'game'), { recursive: true });
  mkdirSync(join(out, 'screenshots'), { recursive: true });
  if (existsSync(shotsDir)) cpSync(shotsDir, join(out, 'screenshots'), { recursive: true });

  // The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
  // scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
  // files, in all, or a path under game/ over 1000 bytes: game/ counts beside /output's own 1000-entry cap, its
  // screenshots/ and dossier.json).
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, {
      text_max_bytes: 163840,
      screenshots: { max: 4, max_bytes: 262144 },
      game_max_files: 993,
      game_max_bytes: 50331648,
      game_path_max_bytes: 1000,
    }),
  );

  // Last step: what was written is read back and checked, and the run reports what it handed in.
  verifyBuild();
} catch (err) {
  // A build that fails part way — the dossier's own checks included — leaves nothing behind for the next run (or the
  // scorer) to pick up.
  try {
    rmSync(out, { recursive: true, force: true });
  } catch {
    // Nothing more to do: the original error below is the one that matters.
  }
  refuse(err instanceof Error ? err.message : String(err));
}
