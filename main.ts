// Solmar — entry build.
//
// `node main.ts` mengubah checkout ini menjadi satu deliverable: salinan game/ dan screenshots/ di bawah output
// directory (MAKEFUN_OUTPUT_DIR, /output secara default) plus dossier.json yang mendeskripsikan keduanya, ditulis
// oleh pustaka make.fun di vendor/makefun-game.ts. `node serve.ts` menyajikan hasil build secara lokal.
//
// Build berjalan dalam empat langkah dengan urutan tetap, tiap langkah menjaga langkah berikutnya:
//
//   1. Bersihkan output directory, supaya sisa build lama — dossier, screenshot, berkas game yang sudah dihapus —
//      tidak bisa dikira bagian dari build ini.
//   2. Validasi input: game/ harus ada beserta game/index.html, dan screenshots/ harus muat dalam cap dossier
//      (paling banyak 4 berkas, masing-masing paling banyak 256 KiB). Gagal di sini berarti belum ada satu berkas
//      pun yang dibuat atau disalin.
//   3. Salin game/ dan screenshots/, lalu tulis dossier.json. Bila checkout belum punya satu render pun di
//      screenshots/, langkah ini menulis satu cover pengganti yang dilabeli (0-placeholder-cover.png) supaya dossier
//      tetap bisa dibangun dan diperiksa sebelum render asli ada; baris ringkasan di langkah 4 menyebutnya, jadi build
//      yang memakai pengganti tidak pernah bisa dikira build rilis.
//   4. Baca dossier.json kembali, buktikan ia JSON valid yang menyatakan skema makefun/dossier/v1 — dan, sejak revisi
//      kedua, buktikan tiap entri `images`-nya benar-benar ada di output: nama cocok, sha256 sama, media_type sesuai
//      magic byte berkasnya, `cover` menunjuk entri yang ada — lalu cetak satu baris `solmar: build ok:` berisi output
//      directory, ukuran dossier dalam byte, serta jumlah screenshot dan berkas game yang diserahkan.
//
// Kegagalan di langkah mana pun menghapus lagi output directory, jadi build yang gagal tidak meninggalkan
// dossier.json basi maupun pohon output separuh jadi untuk dipungut run berikutnya (atau skorer) — hanya alasannya
// di stderr, lalu exit 1.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { buildDossier, DOSSIER_SCHEMA } from './vendor/makefun-game.ts';

// ---------------------------------------------------------------- lokasi

/** Root checkout yang dibaca build ini: main.ts duduk di root-nya. */
const checkoutRoot = fileURLToPath(new URL('.', import.meta.url));
const gameSourceDir = join(checkoutRoot, 'game');
const gameIndexPath = join(gameSourceDir, 'index.html');
const screenshotsSourceDir = join(checkoutRoot, 'screenshots');

/** Tempat build menulis: MAKEFUN_OUTPUT_DIR bila di-set, /output (direktori platform) bila tidak. */
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const dossierPath = join(outputDir, 'dossier.json');

/**
 * Cap skorer (reference/gate.json); angkanya tidak diubah. text_max_bytes membentuk ukuran dossier; sisanya
 * menolak entri yang juga akan ditolak skorer: lebih dari 4 screenshot atau satu screenshot di atas 256 KiB,
 * lebih dari 993 entri di game/ atau 48 MiB berkas game seluruhnya, atau path di bawah game/ sepanjang lebih dari
 * 1000 byte — entri game/ dihitung berdampingan dengan cap 1000 entri /output sendiri, screenshots/ dan
 * dossier.json-nya.
 */
const dossierCaps = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

/** Cap screenshot yang sama, dinamai untuk pemeriksaan awal di langkah 2: satu sumber angka dengan buildDossier. */
const { max: MAX_SCREENSHOTS, max_bytes: MAX_SCREENSHOT_BYTES } = dossierCaps.screenshots;

// ---------------------------------------------------------------- util

/** Kenapa sebuah nilai yang tertangkap bilang gagal, supaya baris error tetap terbaca. */
function failureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tulis alasan build tidak bisa jalan ke stderr lalu keluar non-zero; tidak ada yang lain dicetak. */
function abortBuild(message: string): never {
  console.error(`solmar: build failed: ${message}`);
  process.exit(1);
}

/** Apakah path sebuah direktori yang ada, tanpa melempar untuk yang hilang, tak terbaca, atau sebuah link. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Apakah path berkas biasa yang ada, tanpa melempar: path hilang, direktori dan link semuanya menjawab tidak. */
function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Berkas biasa di bawah `dir` secara rekursif: entri yang ikut tersalin, direktorinya sendiri tidak dihitung. */
function regularFilesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...regularFilesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** Urutan code unit, sama di setiap mesin (localeCompare tidak). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Screenshot yang dihitung dossier: berkas biasa di level atas screenshots/, nama berawalan '.' dilewati.
 * Penyaringnya sama persis dengan yang dipakai buildDossier (yang juga mengabaikan subdirektori dan symlink),
 * jadi pemeriksaan awal di sini tidak pernah menolak berkas yang akan diterima dossier — atau sebaliknya.
 */
function dossierScreenshotNames(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    abortBuild(`cannot read the screenshots directory ${dir} (${failureReason(err)})`);
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(byCodeUnit);
}

/** Seperti dossierScreenshotNames, tetapi direktori yang tidak terbaca menjawab daftar kosong, bukan abortBuild. */
function dossierScreenshotNamesIfAny(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(byCodeUnit);
  } catch {
    return [];
  }
}

/** Ukuran sebuah berkas dalam byte, atau keluar lewat abortBuild bila tidak bisa dibaca. */
function sizeOf(path: string, shown: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    abortBuild(`cannot read the size of ${shown} (${failureReason(err)})`);
  }
}

// ---------------------------------------------------------------- cover pengganti

/**
 * Nama berkas cover pengganti. Berawalan angka seperti render asli, jadi bila screenshots/ kelak diisi render
 * sungguhan yang namanya lebih dulu secara code unit, pengganti ini tidak pernah tertinggal sebagai sampul.
 */
const PLACEHOLDER_COVER_NAME = '0-placeholder-cover.png';

/** Apakah build ini memakai cover pengganti: hanya build pra-render, dan baris ringkasan menyebutnya. */
let usedPlaceholderCover = false;

/** Font bitmap 5 × 7 untuk glyph yang dipakai banner cover pengganti; tiap baris satu baris piksel, '1' menyala. */
const BANNER_FONT: Record<string, readonly string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

/** Tabel CRC-32 PNG (polinomial 0xEDB88320), dihitung sekali. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 sekumpulan byte, seperti yang diminta tiap chunk PNG. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Satu chunk PNG: panjang, tipe, data, lalu CRC atas tipe dan data. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * PNG RGB 8-bit yang digambar di sini: latar gelap, bingkai, dan dua baris teks banner dari BANNER_FONT. Dipakai hanya
 * sebagai cover pengganti saat checkout belum punya render; pustaka standar Node saja, jadi tidak ada dependensi baru.
 */
function placeholderCoverPng(width: number, height: number, banner: string): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  const background = [0x10, 0x18, 0x24];
  const frame = [0x2e, 0x3d, 0x55];
  const ink = [0xe8, 0xc0, 0x6a];
  const put = (x: number, y: number, rgb: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 3;
    pixels[at] = rgb[0]!;
    pixels[at + 1] = rgb[1]!;
    pixels[at + 2] = rgb[2]!;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, background);
  const inset = Math.round(Math.min(width, height) * 0.04);
  for (let x = inset; x < width - inset; x++) {
    put(x, inset, frame);
    put(x, height - inset - 1, frame);
  }
  for (let y = inset; y < height - inset; y++) {
    put(inset, y, frame);
    put(width - inset - 1, y, frame);
  }

  // Skala glyph: banner harus muat di 80% lebar dengan margin, dan tiap baris teks setinggi ~10% tinggi.
  const lines = [banner, 'NO RENDERS YET'];
  const glyphsOf = (line: string): readonly (readonly string[])[] => [...line].map((ch) => BANNER_FONT[ch] ?? BANNER_FONT[' ']!);
  const widest = Math.max(...lines.map((line) => glyphsOf(line).length * 6 - 1));
  const scale = Math.max(1, Math.min(Math.floor((width * 0.8) / widest), Math.floor((height * 0.16) / 7)));
  const textHeight = 7 * scale;
  lines.forEach((line, index) => {
    const lineGlyphs = glyphsOf(line);
    const lineColumns = lineGlyphs.length * 6 - 1;
    const left = Math.floor((width - lineColumns * scale) / 2);
    const top = Math.floor(height / 2 - textHeight + index * Math.round(textHeight * 1.4));
    lineGlyphs.forEach((rows, cell) => {
      rows.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) {
          if (row[gx] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              put(left + cell * 6 * scale + gx * scale + dx, top + gy * scale + dy, ink);
            }
          }
        }
      });
    });
  });

  // Scanline PNG: satu byte filter (0 = none) lalu tiga byte per piksel.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // kedalaman bit
  ihdr[9] = 2; // truecolour RGB
  ihdr[10] = 0; // kompresi deflate
  ihdr[11] = 0; // filter standar
  ihdr[12] = 0; // tanpa interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------- langkah

/** Langkah 1: output build lama tidak boleh bertahan ke build ini, apa pun yang terjadi di bawah. */
function resetOutputDirectory(): void {
  console.log(`solmar: step 1/4 clearing the output directory ${outputDir}`);
  try {
    rmSync(outputDir, { recursive: true, force: true });
  } catch (err) {
    abortBuild(`cannot clear the output directory ${outputDir} (${failureReason(err)})`);
  }
}

/**
 * Langkah 2b: tolak lebih awal entri yang akan ditolak buildDossier — screenshots/ berisi lebih dari 4 berkas,
 * atau satu berkas di atas 256 KiB. Cermin cap dossierCaps.screenshots, jadi hasil akhirnya sama persis; bedanya
 * build berhenti sebelum satu berkas pun disalin. Direktori screenshots/ yang tidak ada sengaja dilewatkan:
 * ketiadaannya buildDossier yang melaporkan, seperti sebelumnya.
 */
function checkScreenshotLimits(): void {
  if (!existsSync(screenshotsSourceDir)) return;
  const names = dossierScreenshotNames(screenshotsSourceDir);
  if (names.length > MAX_SCREENSHOTS) {
    abortBuild(
      `screenshots/ holds ${names.length} files (${names.join(', ')}), over the ${MAX_SCREENSHOTS} the dossier allows: keep at most ${MAX_SCREENSHOTS} renders, the first by name being the cover`,
    );
  }
  for (const name of names) {
    const shown = `screenshots/${name}`;
    const size = sizeOf(join(screenshotsSourceDir, name), shown);
    if (size > MAX_SCREENSHOT_BYTES) {
      abortBuild(`${shown} is ${size} bytes, over the ${MAX_SCREENSHOT_BYTES} the dossier allows: shrink the render first`);
    }
  }
}

/** Langkah 2: input diperiksa sebelum apa pun dibuat, jadi checkout tanpa game tidak meninggalkan output sama sekali. */
function validateInputs(): void {
  console.log('solmar: step 2/4 validating inputs (game/, game/index.html, screenshots/ caps)');
  if (!isDirectory(gameSourceDir)) {
    abortBuild(`no game/ directory at ${gameSourceDir}: a build needs the game's static files, its index.html at the root`);
  }
  if (!isPlainFile(gameIndexPath)) {
    abortBuild(`no game/index.html at ${gameIndexPath}: a build needs the game's page at the root of game/`);
  }
  checkScreenshotLimits();
}

/** Langkah 3a: game/ selalu, screenshots/ bila checkout punya (ketiadaannya buildDossier yang melaporkan). */
function copyInputs(): void {
  console.log('solmar: step 3/4 copying game/ and screenshots/, then writing dossier.json');
  mkdirSync(outputDir, { recursive: true });
  cpSync(gameSourceDir, join(outputDir, 'game'), { recursive: true });
  mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
  if (existsSync(screenshotsSourceDir)) cpSync(screenshotsSourceDir, join(outputDir, 'screenshots'), { recursive: true });
}

/**
 * Langkah 3b: bila salinan screenshots/ di output masih kosong, tulis satu cover pengganti di sana supaya dossier bisa
 * dibangun sebelum render asli ada. Direktori yang sudah berisi render tidak pernah disentuh: build dengan render
 * sungguhan tidak boleh mendapat berkas tambahan dari sini.
 */
function ensureDossierCover(): void {
  const copied = join(outputDir, 'screenshots');
  if (dossierScreenshotNamesIfAny(copied).length > 0) return;
  const cover = placeholderCoverPng(1280, 720, 'SOLMAR');
  writeFileSync(join(copied, PLACEHOLDER_COVER_NAME), cover);
  usedPlaceholderCover = true;
  console.log(
    `solmar: screenshots/ holds no render, so the dossier carries a labelled placeholder cover (${PLACEHOLDER_COVER_NAME}, ${cover.length} bytes); replace it with real renders before the entry is submitted`,
  );
}

/** Langkah 3c: dossier.json ditulis dengan cap skorer di atas; isi dan byte-nya milik buildDossier. */
function writeDossierFile(): void {
  writeFileSync(dossierPath, buildDossier(outputDir, dossierCaps));
}

/** Magic byte pembuka PNG dan JPEG: dasar `media_type` yang ditulis buildDossier. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** Apakah `bytes` dibuka oleh `magic`; dipakai untuk menurunkan media_type sebuah render. */
function opensWith(bytes: Buffer, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
}

/** Satu entri `images` dossier, sebatas yang diperiksa langkah 4. */
interface DossierImage {
  readonly name?: unknown;
  readonly media_type?: unknown;
  readonly sha256?: unknown;
  readonly base64?: unknown;
}

/**
 * Langkah 4b: cocokkan tiap entri `images` dossier dengan berkas yang benar-benar ada di output — nama berkasnya ada,
 * byte-nya sama dengan `sha256` dan `base64` yang dicatat, `media_type`-nya sesuai magic byte, dan `cover` menunjuk
 * entri yang ada. Dossier yang mencatat gambar yang tidak ada di output akan ditolak skorer; build ini menolaknya
 * lebih dulu, sebelum baris `build ok:` sempat dicetak. Melempar untuk ketidakcocokan pertama.
 */
function verifyDossierImages(doc: unknown): number {
  if (typeof doc !== 'object' || doc === null) return 0;
  const cover = (doc as { cover?: unknown }).cover;
  const images = (doc as { images?: unknown }).images;
  if (!Array.isArray(images)) throw new Error(`the dossier at ${dossierPath} holds no images array`);
  if (typeof cover !== 'number' || !Number.isInteger(cover) || cover < 0 || cover >= images.length) {
    throw new Error(`the dossier at ${dossierPath} names cover ${JSON.stringify(cover)}, which is not an index of its ${images.length} image(s)`);
  }
  const shotsDir = join(outputDir, 'screenshots');
  images.forEach((raw, index) => {
    const image = (typeof raw === 'object' && raw !== null ? raw : {}) as DossierImage;
    const { name, media_type: mediaType, sha256, base64 } = image;
    if (typeof name !== 'string' || name === '') throw new Error(`the dossier's image ${index} has no name`);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`the dossier's image ${name} carries no sha256`);
    }
    const path = join(shotsDir, name);
    if (!isPlainFile(path)) throw new Error(`the dossier's image ${name} is not a file at ${path}`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (err) {
      throw new Error(`cannot read the dossier's image ${name} (${failureReason(err)})`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw new Error(`the dossier's image ${name} hashes to ${actual}, not the ${sha256} the dossier records`);
    }
    const expectedType = opensWith(bytes, PNG_MAGIC)
      ? 'image/png'
      : opensWith(bytes, JPEG_MAGIC)
        ? 'image/jpeg'
        : null;
    if (expectedType === null) throw new Error(`the dossier's image ${name} is neither a PNG nor a JPEG`);
    if (mediaType !== expectedType) {
      throw new Error(`the dossier's image ${name} declares ${JSON.stringify(mediaType)}, but its bytes are ${expectedType}`);
    }
    if (typeof base64 === 'string' && Buffer.from(bytes).toString('base64') !== base64) {
      throw new Error(`the dossier's image ${name} carries base64 that is not the file at ${path}`);
    }
  });
  return images.length;
}

/**
 * Langkah 4: baca dossier kembali dari disk, buktikan ia JSON yang memang akan diserahkan build ini, lalu cetak
 * satu baris ringkasan. Melempar untuk apa pun yang bisa membuat pembaca output tersandung, sehingga pemanggil
 * membersihkan output dan melaporkan alasannya.
 */
function verifyDossierAndReport(): void {
  console.log('solmar: step 4/4 reading dossier.json back, verifying it, and reporting the build');

  let raw: Buffer;
  try {
    raw = readFileSync(dossierPath);
  } catch (err) {
    throw new Error(`cannot read back the dossier at ${dossierPath} (${failureReason(err)})`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`the dossier at ${dossierPath} is not valid JSON (${failureReason(err)})`);
  }

  const schema = typeof doc === 'object' && doc !== null ? (doc as { schema?: unknown }).schema : undefined;
  if (schema !== DOSSIER_SCHEMA) {
    throw new Error(
      `the dossier at ${dossierPath} declares schema ${JSON.stringify(schema)}, not ${JSON.stringify(DOSSIER_SCHEMA)}: it was not written, or not written correctly`,
    );
  }

  const imageCount = verifyDossierImages(doc);
  const dossierBytes = statSync(dossierPath).size;
  const screenshots = regularFilesUnder(join(outputDir, 'screenshots')).length;
  const gameFiles = regularFilesUnder(join(outputDir, 'game')).length;
  const cover = usedPlaceholderCover ? ` (cover is the labelled placeholder ${PLACEHOLDER_COVER_NAME})` : '';
  const mismatch = imageCount === screenshots ? '' : `, ${screenshots - imageCount} file(s) in screenshots/ not in the dossier`;
  console.log(
    `solmar: build ok: output ${outputDir}, dossier.json ${dossierBytes} bytes (schema ${DOSSIER_SCHEMA}), ${imageCount} image${imageCount === 1 ? '' : 's'} verified, ${gameFiles} game file${gameFiles === 1 ? '' : 's'}${cover}`,
  );
  if (mismatch !== '') console.log(`solmar: note: screenshots/ holds${mismatch}`);
}

/**
 * Menjalankan keempat langkah berurutan. Kegagalan setelah output directory dibuat — termasuk pemeriksaan dossier
 * sendiri — membawa seluruh output pergi bersama alasan yang menyebabkannya.
 */
function main(): void {
  resetOutputDirectory();
  validateInputs();

  try {
    copyInputs();
    ensureDossierCover();
    writeDossierFile();
    verifyDossierAndReport();
  } catch (err) {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // Tidak ada lagi yang bisa dilakukan: error build di bawah ini yang penting.
    }
    abortBuild(failureReason(err));
  }
}

main();
