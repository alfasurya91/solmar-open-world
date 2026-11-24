// ============================================================================
// makefun-game.ts — Solmar: fondasi engine + pustaka make.fun untuk dossier
// TypeScript murni, tanpa dependensi selain pustaka standar Node.
//
// BAGIAN 1 — Fondasi engine (geometri, enumerasi dunia, konstanta, helper
// matematika, hashing deterministik, PRNG mulberry32, tile grid).
//
// BAGIAN 2 — Pustaka make.fun (makefun/dossier/v1): membaca game/ sebagai
// pohon berkas, membaca <script>/<link>/<img> halaman index.html, membaca
// import map, memindai impor statis, mengurutkan sumber seperti halaman
// memuatnya, dan buildDossier yang menulis dossier.json. Bagian ini adalah
// salinan perilaku pustaka kit make.fun byte demi byte: scorer membangun
// dossier lagi dengan pustaka yang sama dan membandingkan hasilnya byte demi
// byte, jadi keluarannya harus identik, bukan hanya mirip.
//
// main.ts mengimpor { buildDossier, DOSSIER_SCHEMA } dari berkas ini dan
// memanggil buildDossier(out, { text_max_bytes, screenshots, game_max_files,
// game_max_bytes, game_path_max_bytes }) untuk menulis /output/dossier.json.
// ============================================================================

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ----------------------------------------------------------------------------
// Geometri dasar
// ----------------------------------------------------------------------------

/** Titik / vektor 2D. */
export type Vec2 = { x: number; y: number };

/** Ukuran 2D (lebar & tinggi). */
export type Size2 = { width: number; height: number };

/** Persegi panjang axis-aligned. */
export type Rect = { x: number; y: number; width: number; height: number };

// ----------------------------------------------------------------------------
// Enumerasi dunia (kosakata tile & parcel kota Solmar)
// ----------------------------------------------------------------------------

/** Jenis permukaan tanah: bagaimana rasanya saat dilalui dan saat menyatu dengan petak sekitarnya. */
export type SurfaceKind =
  | "water"
  | "shallow"
  | "sand"
  | "grass"
  | "road"
  | "sidewalk"
  | "plaza"
  | "lot";

/** Gaya arsitektur sebuah parcel terbangun. */
export type BuildingStyle = "house" | "shop" | "apartment" | "office" | "tower";

/** Cara sebuah blok yang TIDAK terbangun digunakan. */
export type BlockUse = "built" | "park" | "plaza";

// ----------------------------------------------------------------------------
// Konstanta
// ----------------------------------------------------------------------------

/** Satu putaran penuh dalam radian (dua pi). */
export const TAU = Math.PI * 2;

// ----------------------------------------------------------------------------
// Helper matematika
// ----------------------------------------------------------------------------

/** Jepit `v` ke rentang inklusif [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Titik tengah sebuah persegi panjang. */
export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

// ----------------------------------------------------------------------------
// Hashing deterministik
// ----------------------------------------------------------------------------

// Basis FNV-1a 32-bit.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function avalanche32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hash sebuah string menjadi bilangan 32-bit unsigned (0 .. 0xFFFFFFFF).
 * Menggunakan FNV-1a atas UTF-16 code units lalu diavalanchekan agar seed
 * berurutan / berprefix sama tetap tersebar baik.
 */
export function hashString(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return avalanche32(h);
}

/**
 * Ubah seed (angka atau string) menjadi nilai benih 32-bit deterministik.
 * String di-hash; angka dilipat ke ruang 32-bit lalu diavalanchekan.
 */
export function hashSeed(seed: number | string): number {
  if (typeof seed === "string") {
    return hashString(seed);
  }
  if (!Number.isFinite(seed)) {
    return 0;
  }
  const s = seed >= 0 ? seed : -seed;
  const floor = Math.floor(s);
  const frac = s - floor;
  // Gabungkan bagian bulat (mod 2^32) dengan bagian pecahan sebagai bit.
  let h = (Math.imul(floor >>> 0, 0x9e3779b1) ^ Math.imul(Math.floor(frac * 0x100000000) >>> 0, 0x85ebca6b)) >>> 0;
  return avalanche32(h);
}

// ----------------------------------------------------------------------------
// PRNG deterministik — mulberry32
// ----------------------------------------------------------------------------

/**
 * PRNG berstatus 32-bit, kecil, cepat, dan deterministik (mulberry32).
 * Stream yang dihasilkan sama untuk seed yang sama di semua platform JS.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    // State 0 akan menghasilkan stream nol-semu; jangan pernah dibiarkan.
    this.state = hashSeed(seed) || 0x9e3779b9;
  }

  /** Nilai mentah berikutnya, bilangan float dalam [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float seragam dalam [min, max). */
  range(min: number, max: number): number {
    if (max <= min) return min;
    return min + this.next() * (max - min);
  }

  /** Integer seragam dalam [min, max] inklusif. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

// ----------------------------------------------------------------------------
// Tile grid
// ----------------------------------------------------------------------------

/**
 * Grid 2D sederhana berisi kode tile integer. Pembacaan di luar batas
 * mengembalikan 0, sehingga pencarian tetangga (deteksi tepi, pertumbuhan
 * petak) bisa berjalan tanpa pemeriksaan batas selama semua kode tile nyata
 * bernilai >= 1.
 */
export class TileGrid {
  readonly width: number;
  readonly height: number;
  private cells: Uint16Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
      throw new Error(`TileGrid: dimensi tidak valid (${width} x ${height})`);
    }
    this.width = width;
    this.height = height;
    this.cells = new Uint16Array(width * height);
  }

  /** Kode tile di (x, y); 0 bila di luar batas. */
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.cells[y * this.width + x];
  }

  /** Tulis kode tile di (x, y). Tulisan di luar batas diabaikan. */
  set(x: number, y: number, code: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[y * this.width + x] = code;
  }
}

// ============================================================================
// BAGIAN 2 — Pustaka make.fun: dossier game (makefun/dossier/v1)
// ============================================================================

/** Skema dossier yang ditulis buildDossier (contracts/dossier.ts DOSSIER_SCHEMA). */
export const DOSSIER_SCHEMA = 'makefun/dossier/v1';
/** Byte terbanyak yang boleh dimuat satu dossier (contracts/dossier.ts DOSSIER_MAX_BYTES): 4 MiB. */
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;
/** Gambar terbanyak dalam satu dossier (contracts/dossier.ts DOSSIER_MAX_IMAGES). */
export const DOSSIER_MAX_IMAGES = 8;
/** Halaman game: satu-satunya berkas yang wajib ada di game/. */
export const INDEX_HTML = 'index.html';
/** Byte terbanyak yang boleh dimuat game/index.html. */
export const INDEX_HTML_MAX_BYTES = 1024 * 1024;
/** Path terpanjang sebuah berkas game dalam byte UTF-8: path keluaran platform 1024 byte dikurangi 'game/'. */
export const GAME_PATH_MAX_BYTES = 1000;
/** Berapa berkas vendored yang didaftar blok Game per path sebelum sisanya hanya dihitung. */
const VENDORED_LISTED = 24;

/** Ekstensi yang membuat sebuah berkas menjadi sumber (huruf kecil; dicocokkan tanpa beda huruf besar/kecil). */
export const SOURCE_EXTENSIONS = ['html', 'js', 'mjs', 'css', 'glsl', 'vert', 'frag', 'wgsl', 'json'] as const;
/** Nama berkas hasil build: bukan sumber, apa pun ekstensinya. */
const GENERATED_NAME = /\.min\.(?:js|mjs|css)$/i;
/** Ekstensi sebuah berkas sumber. */
const SOURCE_NAME = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i');
/** Modul JS yang diikuti penelusuran impor. */
const MODULE_NAME = /\.(?:js|mjs)$/i;

/** Apa arti sebuah berkas di bawah game/ bagi dossier: sumber yang ditampilkan, berkas vendored, atau aset yang hanya dihitung. */
export type GameFileClass = 'source' | 'vendored' | 'asset';

/** Sebuah cap yang membuat buildDossier atau readGameTree menolak, dinamai di DossierError.limit. */
export type DossierLimit = 'text_max_bytes' | 'screenshots.max' | 'screenshots.max_bytes' | 'game_max_files' | 'game_max_bytes' | 'game_path_max_bytes';

/** Mengapa buildDossier tidak menulis dossier untuk sebuah direktori: cap, game/, atau screenshots/-nya. */
export class DossierError extends Error {
  /** Cap pemanggil yang dilampaui masukan (kunci DossierCaps atau GameCaps), atau null bila masukannya sendiri yang salah. */
  readonly limit: DossierLimit | null;
  constructor(message: string, limit: DossierLimit | null = null) {
    super(message);
    this.name = 'DossierError';
    this.limit = limit;
  }
}

/**
 * Apa yang dipegang readGameTree, tiap cap boleh tidak ada.
 *   game_max_files        berkas dan direktori di bawah game/, dijumlah (satu entri masing-masing, seperti platform menghitungnya).
 *   game_max_bytes        ukuran berkas, dijumlah (byte yang dimakan game/, direktorinya nol).
 *   game_path_max_bytes   panjang tiap path dalam byte UTF-8, relatif terhadap game/.
 */
export interface GameCaps {
  game_max_files?: number;
  game_max_bytes?: number;
  game_path_max_bytes?: number;
}

/** Satu berkas di bawah game/. */
export interface GameFile {
  /** Path POSIX relatif terhadap game/, seperti `src/main.js`. */
  path: string;
  /** Ukurannya dalam byte. */
  bytes: number;
  cls: GameFileClass;
}

/** Setiap entri di bawah game/, ditelusuri sekali. */
export interface GameTree {
  /** Berkas, dalam urutan path per code unit. */
  files: GameFile[];
  /** Path direktori, dalam urutan code unit (game/ sendiri adalah '' dan tidak didaftar). */
  directories: string[];
  /** Berapa entri yang dimuat game/: berkas dan direktori, hitungan platform sendiri. */
  count: number;
  /** Ukuran berkas, dijumlah. */
  totalBytes: number;
}

/**
 * Apa yang dipegang buildDossier: cap teks dalam byte UTF-8, cap screenshot (paling banyak `max` gambar, masing-masing
 * paling banyak `max_bytes` byte; DOSSIER_MAX_IMAGES dan DOSSIER_MAX_BYTES dossier tetap berlaku) dan cap readGameTree.
 * gate.json sebuah bounty boleh dilewatkan utuh: buildDossier hanya membaca kunci-kunci ini.
 */
export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  game_max_files?: number;
  game_max_bytes?: number;
  game_path_max_bytes?: number;
}

// ---------------------------------------------------------------- byte

const utf8 = new TextDecoder('utf-8');

/** Urutan code unit, sama di setiap mesin (localeCompare tidak). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Byte sebuah string sebagai teks, hanya untuk ditampilkan (UTF-8 tak valid menjadi U+FFFD). */
const text = (bytes: Uint8Array): string => utf8.decode(bytes);

/** Baris sebuah sumber: 0 bila kosong, selain itu jumlah newline ditambah satu bila baris terakhir tanpa newline. */
function lineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** Pagar Markdown satu backtick lebih panjang dari rentetan terpanjang di `body`, minimal tiga. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Tag bahasa pagar untuk sebuah path sumber. */
function languageOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'mjs' || ext === 'js') return 'js';
  if (ext === 'glsl' || ext === 'vert' || ext === 'frag') return 'glsl';
  if (ext === 'wgsl') return 'wgsl';
  if (ext === 'html') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  return 'text';
}

// ---------------------------------------------------------------- pohon game

/** GameCaps pemanggil yang sudah diperiksa: tiap cap yang diberikan bilangan bulat, yang tidak ada Infinity. */
function gameCapsOf(caps: GameCaps, who: string): Record<keyof GameCaps, number> {
  const out = { game_max_files: Infinity, game_max_bytes: Infinity, game_path_max_bytes: GAME_PATH_MAX_BYTES };
  for (const k of ['game_max_files', 'game_max_bytes', 'game_path_max_bytes'] as const) {
    const v = caps[k] as unknown;
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new TypeError(`${who}: caps.${k} must be a whole number, not ${String(v)}`);
    out[k] = v;
  }
  return out;
}

/**
 * Apa arti sebuah path di bawah game/ bagi dossier: sumber yang ditampilkan, atau berkas vendored / aset yang hanya
 * dihitung. Nama hasil build (*.min.js, *.min.mjs, *.min.css) dan path mana pun di bawah direktori bernama vendor
 * adalah vendored, ekstensi sumber di luar itu adalah sumber, dan sisanya aset.
 */
export function classifyGamePath(path: string): GameFileClass {
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? '';
  const dirs = segs.slice(0, -1);
  if (dirs.includes('vendor') || GENERATED_NAME.test(base)) return 'vendored';
  return SOURCE_NAME.test(base) ? 'source' : 'asset';
}

/** Apakah sebuah path di bawah game/ adalah berkas sumber (classifyGamePath mengembalikan 'source'). */
export function isSourcePath(path: string): boolean {
  return classifyGamePath(path) === 'source';
}

/**
 * Setiap berkas dan direktori di bawah game/, per path, dengan byte dan kelas tiap berkas serta totalnya. Symbolic link
 * dan berkas khusus lain ditolak, begitu pula lebih dari caps.game_max_files entri, lebih dari caps.game_max_bytes
 * byte di berkas-berkasnya, dan path yang lebih panjang dari caps.game_path_max_bytes. Tidak ada yang dibaca kecuali
 * daftar direktori. Melempar DossierError.
 */
export function readGameTree(gameDir: string, caps: GameCaps = {}): GameTree {
  const c = gameCapsOf(caps, 'readGameTree');
  let root;
  try {
    root = lstatSync(gameDir);
  } catch {
    throw new DossierError('game/: no such directory: a game is a directory of static files, its index.html at its root');
  }
  if (!root.isDirectory()) throw new DossierError('game/: not a directory (a game is a directory of static files)');
  const files: GameFile[] = [];
  const directories: string[] = [];
  const stack: string[] = [''];
  let count = 0;
  let totalBytes = 0;
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel === '' ? gameDir : join(gameDir, rel), { withFileTypes: true });
    } catch (err) {
      throw new DossierError(`game/${rel === '' ? '' : `${rel}/`}: cannot be read (${(err as Error).message})`);
    }
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      const pathBytes = byteLength(path);
      if (pathBytes > c.game_path_max_bytes) {
        throw new DossierError(`game/${path}: a path of ${pathBytes} bytes, over the ${c.game_path_max_bytes} allowed (game_path_max_bytes)`, 'game_path_max_bytes');
      }
      const shown = `game/${path}`;
      let st;
      try {
        st = lstatSync(join(gameDir, path));
      } catch {
        throw new DossierError(`${shown}: cannot be read`);
      }
      count++;
      if (count > c.game_max_files) {
        throw new DossierError(`game/: holds more than the ${c.game_max_files} files and directories allowed (game_max_files)`, 'game_max_files');
      }
      if (st.isDirectory()) {
        directories.push(path);
        stack.push(path);
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > c.game_max_bytes) {
          throw new DossierError(`game/: its files come to more than the ${c.game_max_bytes} bytes allowed (game_max_bytes)`, 'game_max_bytes');
        }
        files.push({ path, bytes: st.size, cls: classifyGamePath(path) });
      } else {
        throw new DossierError(`${shown}: a symbolic link or special file (game/ holds plain files and directories only)`);
      }
    }
  }
  files.sort((a, b) => byCodeUnit(a.path, b.path));
  directories.sort(byCodeUnit);
  return { files, directories, count, totalBytes };
}

/** Byte game/index.html dari pohon, atau mengapa tidak ada: ditolak bila hilang, sebuah direktori, link, atau melewati cap. */
function readIndexHtml(gameDir: string, tree: GameTree): Uint8Array {
  const file = tree.files.find((f) => f.path === INDEX_HTML);
  if (file === undefined) {
    if (tree.directories.includes(INDEX_HTML)) throw new DossierError('buildDossier: game/index.html: a directory, not the page');
    throw new DossierError('buildDossier: game/index.html: no such file: a game is a directory of static files, its index.html at its root');
  }
  if (file.bytes > INDEX_HTML_MAX_BYTES) throw new DossierError(`buildDossier: game/index.html: ${file.bytes} bytes, over the ${INDEX_HTML_MAX_BYTES} a page may be`);
  try {
    return new Uint8Array(readFileSync(join(gameDir, INDEX_HTML)));
  } catch (err) {
    throw new DossierError(`buildDossier: game/index.html: cannot be read (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------- halaman

/** Satu <script> sebuah halaman. */
export interface HtmlScript {
  /** Atribut src-nya, atau null bila skrip inline. */
  src: string | null;
  /** Atribut type-nya, huruf kecil dan dirapikan ('' bila tidak ada). */
  type: string;
  /** Teks skrip inline ('' untuk yang punya src atau tanpa isi). */
  text: string;
}

/** Satu <link> sebuah halaman. */
export interface HtmlLink {
  href: string;
  /** Atribut rel-nya, huruf kecil dan dirapikan. */
  rel: string;
}

/** Satu elemen halaman yang memuat berkas lewat atribut src: <img>, <source>, <video>, <audio> atau <iframe>. */
export interface HtmlResource {
  /** Nama tag-nya, huruf kecil. */
  tag: string;
  /** Atribut src-nya. */
  src: string;
}

/** Tag-tag yang src-nya adalah sumber daya yang dimuat halaman. */
const RESOURCE_TAGS = ['img', 'source', 'video', 'audio', 'iframe'] as const;

/** Satu blok <script type="importmap">. */
export interface HtmlImportMap {
  /** JSON-nya, bila berhasil di-parse. */
  value: unknown;
  /** Mengapa teksnya bukan JSON, atau null. */
  error: string | null;
}

/** Apa yang dikatakan markup sebuah halaman tentang berkas yang dimuatnya. */
export interface HtmlFacts {
  /** Setiap <script>, dalam urutan dokumen. */
  scripts: HtmlScript[];
  /** Setiap <link> dengan href, dalam urutan dokumen. */
  links: HtmlLink[];
  /** Setiap <img>, <source>, <video>, <audio> dan <iframe> dengan src, dalam urutan dokumen. */
  resources: HtmlResource[];
  /** Setiap <script type="importmap">, dalam urutan dokumen. */
  importMaps: HtmlImportMap[];
}

/** Indeks `>` yang menutup tag yang isinya mulai di `from`, menghormati nilai atribut berkutip; -1 bila tidak ada. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i]!;
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/** Atribut isi sebuah tag: nama huruf kecil, nilai tanpa kutip; atribut yang ada tanpa nilai adalah ''. */
function attributesOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s/]/.test(body[i]!)) i++;
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && !/[\s=/>]/.test(body[i]!)) i++;
    const name = body.slice(start, i).toLowerCase();
    while (i < body.length && /\s/.test(body[i]!)) i++;
    let value = '';
    if (body[i] === '=') {
      i++;
      while (i < body.length && /\s/.test(body[i]!)) i++;
      const quote = body[i];
      if (quote === '"' || quote === "'") {
        const end = body.indexOf(quote, i + 1);
        value = body.slice(i + 1, end < 0 ? body.length : end);
        i = end < 0 ? body.length : end + 1;
      } else {
        // Nilai tanpa kutip berjalan sampai spasi atau `>` tag; `/` di dalamnya bagian dari nilai.
        const s = i;
        while (i < body.length && !/[\s>]/.test(body[i]!)) i++;
        value = body.slice(s, i);
      }
    }
    if (name !== '') out.set(name, value);
  }
  return out;
}

/** Indeks `</name` pada atau setelah `from`, tanpa beda huruf besar/kecil ASCII; -1 bila tidak ada. */
function closeIndexOf(html: string, from: number, name: string): number {
  const needle = `</${name}`;
  for (let i = from; i + needle.length <= html.length; i++) {
    if (html[i] !== '<') continue;
    let hit = true;
    for (let j = 1; j < needle.length; j++) {
      const a = html[i + j]!.toLowerCase();
      if (a !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * Setiap <script>, <link href>, <img src>, <source src>, <video src>, <audio src>, <iframe src> dan
 * <script type="importmap"> sebuah halaman, dalam urutan dokumen. Komentar dan doctype dilewati. Ini pemindaian tag,
 * bukan parser HTML: ia hanya membaca atribut yang dibawa tag-tag itu.
 */
export function htmlFacts(html: string): HtmlFacts {
  const scripts: HtmlScript[] = [];
  const links: HtmlLink[] = [];
  const resources: HtmlResource[] = [];
  const importMaps: HtmlImportMap[] = [];
  let i = 0;
  while (i < html.length) {
    const at = html.indexOf('<', i);
    if (at < 0) break;
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', at)) {
      const end = html.indexOf('>', at + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const rest = html.slice(at + 1, at + 8).toLowerCase();
    if (rest.startsWith('script') && !/[A-Za-z0-9]/.test(html[at + 7] ?? '')) {
      const end = tagEnd(html, at + 7);
      if (end < 0) break;
      const attrs = attributesOf(html.slice(at + 7, end));
      const type = (attrs.get('type') ?? '').trim().toLowerCase();
      const src = attrs.get('src') ?? null;
      let body = '';
      if (src === null) {
        const close = closeIndexOf(html, end + 1, 'script');
        body = html.slice(end + 1, close < 0 ? html.length : close);
        i = close < 0 ? html.length : close + 8;
      } else {
        const close = closeIndexOf(html, end + 1, 'script');
        i = close < 0 ? html.length : close + 8;
      }
      if (type === 'importmap') {
        let value: unknown = null;
        let error: string | null = null;
        try {
          value = JSON.parse(body);
        } catch (err) {
          error = (err as Error).message;
        }
        importMaps.push({ value, error });
      } else {
        scripts.push({ src, type, text: src === null ? body : '' });
      }
      continue;
    }
    if (rest.startsWith('link') && !/[A-Za-z0-9]/.test(html[at + 5] ?? '')) {
      const end = tagEnd(html, at + 5);
      if (end < 0) break;
      const attrs = attributesOf(html.slice(at + 5, end));
      const href = attrs.get('href');
      if (href !== undefined) links.push({ href, rel: (attrs.get('rel') ?? '').trim().toLowerCase() });
      i = end + 1;
      continue;
    }
    const tag = RESOURCE_TAGS.find((name) => rest.startsWith(name) && !/[A-Za-z0-9]/.test(html[at + 1 + name.length] ?? ''));
    if (tag !== undefined) {
      const end = tagEnd(html, at + 1 + tag.length);
      if (end < 0) break;
      const attrs = attributesOf(html.slice(at + 1 + tag.length, end));
      const src = attrs.get('src');
      if (src !== undefined) resources.push({ tag, src });
      i = end + 1;
      continue;
    }
    const end = tagEnd(html, at + 1);
    i = end < 0 ? html.length : end + 1;
  }
  return { scripts, links, resources, importMaps };
}

/** Import map sebuah halaman: imports dan scopes-nya, masing-masing specifier ke sebuah referensi; nilai null memblokir. */
export interface ImportMap {
  imports: Record<string, string | null>;
  scopes: Record<string, Record<string, string | null>>;
}

/**
 * Satu-satunya import map sebuah halaman, atau tidak ada: `map` dan `error` sama-sama null bila halaman tidak punya
 * import map (opsional), `map` null dan `error` menjelaskan mengapa bila halaman punya satu yang tak bisa dipakai.
 */
export interface ImportMapRead {
  map: ImportMap | null;
  error: string | null;
}

/** Apakah `value` objek biasa. */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Properti milik sendiri yang enumerable apa pun kuncinya: kunci "__proto__" tetap sebuah kunci, bukan prototipe. */
function setOwn<T>(o: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Import map halaman, sudah di-parse: tidak ada (map dan error null) bila halaman tidak punya
 * <script type="importmap">, selain itu map-nya, atau mengapa ia tak bisa dipakai (map kedua, teks bukan JSON, atau
 * bentuk yang bukan import map). "imports" dan "scopes" masing-masing opsional; nilai null dipertahankan: ia
 * memblokir specifier-nya.
 */
export function importMapOf(facts: HtmlFacts): ImportMapRead {
  if (facts.importMaps.length === 0) return { map: null, error: null };
  if (facts.importMaps.length > 1) return { map: null, error: `index.html holds ${facts.importMaps.length} import maps: a page holds one at most` };
  const only = facts.importMaps[0]!;
  if (only.error !== null) return { map: null, error: `index.html's import map is not JSON (${only.error})` };
  if (!isObject(only.value)) return { map: null, error: 'index.html\'s import map is not a JSON object' };
  const importsRaw = only.value.imports ?? {};
  if (!isObject(importsRaw)) return { map: null, error: 'index.html\'s import map holds an "imports" that is not an object' };
  const imports: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(importsRaw)) {
    if (value !== null && typeof value !== 'string') return { map: null, error: `index.html's import map maps ${JSON.stringify(key)} to no string` };
    setOwn(imports, key, value);
  }
  const scopes: Record<string, Record<string, string | null>> = {};
  const scopesRaw = only.value.scopes;
  if (scopesRaw !== undefined) {
    if (!isObject(scopesRaw)) return { map: null, error: 'index.html\'s import map holds a "scopes" that is not an object' };
    for (const [scope, entries] of Object.entries(scopesRaw)) {
      if (!isObject(entries)) return { map: null, error: `index.html's import map scope ${JSON.stringify(scope)} is not an object` };
      const inner: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (value !== null && typeof value !== 'string') return { map: null, error: `index.html's import map scope ${JSON.stringify(scope)} maps ${JSON.stringify(key)} to no string` };
        setOwn(inner, key, value);
      }
      setOwn(scopes, scope, inner);
    }
  }
  return { map: { imports, scopes }, error: null };
}

/** Skema URI di depan `name:`. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Apakah sebuah referensi relatif: tidak kosong, tanpa skema, tanpa // di depan dan tanpa / di depan. */
export function isRelativeRef(ref: string): boolean {
  return ref.length > 0 && !URI_SCHEME.test(ref) && !ref.startsWith('//') && !ref.startsWith('/');
}

/**
 * Apakah sebuah specifier modul relatif dalam pengertian JavaScript: dimulai ./ atau ../ (atau . atau ..). Specifier
 * seperti `phaser` atau `main.js` adalah bare: browser menyelesaikannya lewat import map atau gagal, ia tidak pernah
 * memuat berkas di sebelah importer. isRelativeRef menjawab untuk referensi URL (atribut atau nilai import map),
 * di mana `main.js` relatif terhadap halaman.
 */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Path di bawah game/ yang dinamai referensi relatif `ref`, diselesaikan terhadap path berkas pengimpor (`from`,
 * POSIX dan relatif terhadap game/, seperti `src/main.js`; index.html adalah `index.html`). Query atau fragmen dibuang.
 * Null bila `ref` tidak relatif, tidak menamai apa pun, atau memanjat keluar game/.
 */
export function resolveGamePath(ref: string, from: string): string | null {
  if (!isRelativeRef(ref)) return null;
  const cut = ref.search(/[?#]/);
  const raw = cut < 0 ? ref : ref.slice(0, cut);
  if (raw === '') return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

/** Apa kata import map tentang sebuah specifier: found false bila tidak memetakan apa pun, atau value null bila entri null memblokirnya. */
export interface ImportMapMatch {
  found: boolean;
  value: string | null;
}

/** Entri sebuah specifier di satu map: kunci milik sendiri yang persis, selain itu kunci milik sendiri terpanjang berakhiran / yang menjadi prefiksnya. */
function entryOf(entries: Record<string, string | null>, specifier: string): ImportMapMatch {
  if (Object.hasOwn(entries, specifier)) return { found: true, value: entries[specifier]! };
  let best: string | null = null;
  for (const key of Object.keys(entries)) {
    if (key.endsWith('/') && specifier.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  if (best === null) return { found: false, value: null };
  const base = entries[best]!;
  if (base === null) return { found: true, value: null };
  return { found: true, value: `${base}${specifier.slice(best.length)}` };
}

/**
 * Path game yang dinamai prefiks URL sebuah kunci scope, atau null bila tak bisa menamai satu: referensi yang
 * diselesaikan terhadap index.html, dengan '.' dan './' adalah game/ itu sendiri. Scope absolut menamai jalur situs,
 * bukan berkas game.
 */
function scopePath(scope: string): string | null {
  const cut = scope.search(/[?#]/);
  const raw = cut < 0 ? scope : scope.slice(0, cut);
  if (raw === '.' || raw === './') return '';
  return resolveGamePath(scope, INDEX_HTML);
}

/**
 * Apa kata import map halaman untuk `specifier` yang diimpor dari `from` (path di bawah game/, index.html untuk skrip
 * inline): map scope yang cocok dulu, prefiks URL terpanjangnya menang, lalu imports tingkat atas.
 */
export function importMapMatch(map: ImportMap | null, specifier: string, from: string = INDEX_HTML): ImportMapMatch {
  if (map === null) return { found: false, value: null };
  let best: { prefix: string; entries: Record<string, string | null> } | null = null;
  for (const [scope, entries] of Object.entries(map.scopes)) {
    const prefix = scopePath(scope);
    if (prefix === null || !from.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, entries };
  }
  if (best !== null) {
    const scoped = entryOf(best.entries, specifier);
    if (scoped.found) return scoped;
  }
  return entryOf(map.imports, specifier);
}

/**
 * Nilai yang diberikan import map untuk sebuah specifier bare yang diimpor dari `from`: entri scope yang cocok atau
 * entri tingkat atas, kunci persis dulu lalu kunci terpanjang berakhiran / yang menjadi prefiksnya; null bila tidak
 * ada yang memetakannya atau entri null memblokirnya.
 */
export function mappedSpecifier(map: ImportMap | null, specifier: string, from: string = INDEX_HTML): string | null {
  const match = importMapMatch(map, specifier, from);
  return match.found ? match.value : null;
}

/** Path yang dinamai sebuah specifier dari `from`: relatif terhadap pengimpor, atau lewat import map; null bila keduanya tidak memberi path di bawah game/. */
function resolveSpecifier(specifier: string, from: string, map: ImportMap | null): string | null {
  if (isRelativeSpecifier(specifier)) return resolveGamePath(specifier, from);
  const match = importMapMatch(map, specifier, from);
  if (!match.found || match.value === null || !isRelativeRef(match.value)) return null;
  return resolveGamePath(match.value, INDEX_HTML);
}

// ---------------------------------------------------------------- impor statis

/** Apa yang sedang dilakukan pemindaian leksikal atas teks sebuah modul, karakter demi karakter. */
const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

/**
 * Specifier impor statis dan export-from sebuah modul, dalam urutan sumber, lewat pemindaian leksikal: komentar,
 * string, template literal dan literal ekspresi reguler dilewati, sehingga kata-kata di dalamnya tidak pernah dibaca
 * sebagai impor. Ini bukan parser; ia mengenali `import 'x'`, `import ... from 'x'`, `export ... from 'x'` dan
 * `export * from 'x'`, dan membiarkan sisanya.
 */
export function sourceImports(source: string): string[] {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  /** Karakter berarti (bukan spasi, bukan komentar) terakhir, untuk menebak regex versus pembagian. */
  const regexPosition = (prev: string): boolean => prev === '' || '([{,;:=!&|?+-*%^~<>'.includes(prev);
  let prev = '';

  const skipSpace = (): void => {
    for (;;) {
      while (i < n && /\s/.test(source[i]!)) i++;
      if (source.startsWith('//', i)) {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      return;
    }
  };
  const skipString = (quote: string): string | null => {
    i++;
    let s = '';
    while (i < n) {
      const ch = source[i]!;
      if (ch === quote) {
        i++;
        return s;
      }
      if (ch === '\\') {
        const next = source[i + 1];
        if (next === undefined) return null;
        s += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        i += 2;
        continue;
      }
      if (ch === '\n') return null;
      s += ch;
      i++;
    }
    return null;
  };
  const skipTemplate = (): void => {
    i++;
    while (i < n) {
      const ch = source[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        return;
      }
      i++;
    }
  };
  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n) {
      const ch = source[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i++;
        return;
      } else if (ch === '\n') return;
      i++;
    }
  };
  const readWord = (): string => {
    const start = i;
    while (i < n && IDENT.test(source[i]!)) i++;
    return source.slice(start, i);
  };
  /** Membaca literal string di i, atau null; memajukan i melewatinya bagaimanapun. */
  const maybeString = (): string | null => {
    skipSpace();
    const ch = source[i];
    if (ch !== '"' && ch !== "'") return null;
    return skipString(ch);
  };
  /** Dari tepat setelah `import`/`export`, membaca klausa dan `from 'x'`-nya; mengembalikan specifier atau null. */
  const clause = (stopAt: string[]): string | null => {
    for (;;) {
      skipSpace();
      if (i >= n) return null;
      const ch = source[i]!;
      if (stopAt.includes(ch)) return null;
      if (ch === '"' || ch === "'") return skipString(ch);
      if (ch === '{' || ch === '}') {
        i++;
        continue;
      }
      if (ch === ',' || ch === '*') {
        i++;
        continue;
      }
      if (IDENT_START.test(ch)) {
        const word = readWord();
        if (word === 'from') {
          const spec = maybeString();
          return spec;
        }
        if (word === 'as' || word === 'type') continue;
        continue;
      }
      return null;
    }
  };

  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      skipString(ch);
      prev = ch;
      continue;
    }
    if (ch === '`') {
      skipTemplate();
      prev = '`';
      continue;
    }
    if (ch === '/') {
      if (regexPosition(prev)) skipRegex();
      else i++;
      prev = '/';
      continue;
    }
    if (IDENT_START.test(ch)) {
      const word = readWord();
      prev = 'a';
      if (word === 'import') {
        skipSpace();
        if (source[i] === '(' || source[i] === '.') continue;
        const spec = clause(['=', ';']);
        if (spec !== null) out.push(spec);
        continue;
      }
      if (word === 'export') {
        skipSpace();
        if (source[i] !== '*' && source[i] !== '{') continue;
        const spec = clause(['=', ';']);
        if (spec !== null) out.push(spec);
        continue;
      }
      continue;
    }
    prev = ch;
    i++;
  }
  return out;
}

/** Sebuah berkas sumber game: path di bawah game/ dan byte-nya. */
export interface GameSource {
  path: string;
  bytes: Uint8Array;
}

/** Tipe MIME JavaScript (daftar standar HTML, per esensi) yang membuat sebuah <script> menjadi skrip klasik. */
const CLASSIC_SCRIPT_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** Apakah type sebuah <script> (htmlFacts mengecilkan dan merapikannya) membuatnya skrip klasik: kosong, atau tipe MIME JavaScript. */
function isClassicScript(type: string): boolean {
  return type === '' || CLASSIC_SCRIPT_TYPES.has(type.split(';')[0]!.trim());
}

/**
 * Berkas sumber JS sebuah game dalam urutan halaman memuatnya: skrip index.html dalam urutan dokumen, src skrip
 * klasik (tidak ada, atau tipe MIME JavaScript: <script src="game.js">) di tempatnya, dan skrip modul
 * (<script type="module">), src-nya atau impor dari teks inline-nya, diikuti penelusuran depth-first atas impor
 * statis, impor setiap modul yang dicapai dalam urutan sumbernya, pada kali pertama sebuah path dicapai. src skrip
 * klasik diselesaikan relatif terhadap index.html, dan teksnya tidak ditelusuri (skrip klasik tidak punya impor
 * statis); specifier sebuah modul diselesaikan relatif terhadap pengimpor atau lewat import map halaman (entri scope
 * yang cocok milik modul pengimpor atau entri tingkat atas; sebuah nilai diselesaikan terhadap index.html). Referensi
 * yang tidak menghasilkan berkas JS sumber dilewati, skrip bertipe lain (teks shader, data JSON) dilewati, dan berkas
 * yang sudah dicapai tidak pernah didaftar atau ditelusuri dua kali. `sources` adalah setiap berkas sumber game/
 * (index.html termasuk, yang tidak pernah muncul di hasil).
 */
export function importOrder(sources: readonly GameSource[], facts: HtmlFacts): string[] {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const map = importMapOf(facts).map;
  const textOf = (path: string): string => {
    const file = byPath.get(path);
    return file === undefined ? '' : text(file.bytes);
  };
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (path: string, walk = true): void => {
    if (seen.has(path) || !MODULE_NAME.test(path) || !byPath.has(path)) return;
    seen.add(path);
    order.push(path);
    if (!walk) return;
    for (const specifier of sourceImports(textOf(path))) {
      const target = resolveSpecifier(specifier, path, map);
      if (target !== null) visit(target);
    }
  };
  for (const script of facts.scripts) {
    if (script.type !== 'module') {
      // Skrip klasik memuat src-nya di tempatnya dan tidak mengimpor apa pun secara statis; import map tidak berlaku.
      if (isClassicScript(script.type) && script.src !== null && isRelativeRef(script.src)) {
        const target = resolveGamePath(script.src, INDEX_HTML);
        if (target !== null) visit(target, false);
      }
      continue;
    }
    if (script.src !== null) {
      // src sebuah skrip adalah referensi URL, bukan specifier modul: `main.js` relatif terhadap halaman.
      const target = isRelativeRef(script.src) ? resolveGamePath(script.src, INDEX_HTML) : resolveSpecifier(script.src, INDEX_HTML, map);
      if (target !== null) visit(target);
    } else {
      for (const specifier of sourceImports(script.text)) {
        const target = resolveSpecifier(specifier, INDEX_HTML, map);
        if (target !== null) visit(target);
      }
    }
  }
  return order;
}

// ---------------------------------------------------------------- JSON kanonik

/**
 * JSON dengan kunci setiap objek dalam urutan code unit dan tanpa spasi: satu ejaan per nilai. Menerima null,
 * boolean, angka hingga, string, array dan objek biasa; melempar TypeError untuk hal lain (undefined, fungsi, bigint,
 * NaN, Infinity, instance kelas).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

// ---------------------------------------------------------------- dossier

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** contracts/dossier.ts DossierImageName. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const opensWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean => bytes.length >= at + magic.length && magic.every((b, i) => bytes[at + i] === b);

/** Grup ekstensi sebuah gambar dossier: byte sebuah berkas dikelompokkan menurut ekstensi yang dihitung blok Game. */
const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '(none)';
};

/** Baris blok `## Game`: apa yang dimuat game/, per kelas, dengan totalnya (tanpa teks sumber). */
function gameBlockLines(tree: GameTree): string[] {
  const source = tree.files.filter((f) => f.cls === 'source');
  const vendored = tree.files.filter((f) => f.cls === 'vendored');
  const assets = tree.files.filter((f) => f.cls === 'asset');
  const sum = (list: readonly GameFile[]): number => list.reduce((n, f) => n + f.bytes, 0);
  const lines = [
    '## Game',
    '',
    `Source files: ${source.length} (${sum(source)} bytes)`,
    `Vendored files: ${vendored.length} (${sum(vendored)} bytes)`,
  ];
  if (vendored.length > 0) {
    const listed = vendored.slice(0, VENDORED_LISTED).map((f) => `game/${f.path} (${f.bytes} bytes)`);
    const more = vendored.length > VENDORED_LISTED ? `, and ${vendored.length - VENDORED_LISTED} more` : '';
    lines.push(`  ${listed.join(', ')}${more}`);
  }
  const byExt = new Map<string, { n: number; bytes: number }>();
  for (const f of assets) {
    const ext = extensionOf(f.path);
    const at = byExt.get(ext) ?? { n: 0, bytes: 0 };
    at.n++;
    at.bytes += f.bytes;
    byExt.set(ext, at);
  }
  const extText = [...byExt]
    .sort((a, b) => byCodeUnit(a[0], b[0]))
    .map(([ext, at]) => `${ext} ${at.n} (${at.bytes} bytes)`)
    .join(', ');
  lines.push(`Assets: ${extText === '' ? 'none' : extText}`);
  lines.push(`Totals: ${tree.count} files and directories (${tree.totalBytes} bytes)`);
  return lines;
}

/** Sebuah sumber berbeda seperti yang ditampilkan dossier. */
interface SourceCode {
  norm: Uint8Array;
  text: string;
  fence: string;
  /** Blok berpagar: pagar dan bahasanya, teksnya (LF terakhir ditambah bila tidak ada), pagarnya, satu baris kosong. */
  block: string;
  blockBytes: number;
  lines: number;
}

/**
 * Bagian sebuah sumber yang dipotong di dalam teksnya: judulnya, k baris pertamanya di pagarnya (ditutup), satu baris
 * yang menyebut berapa barisnya tidak ditampilkan, lalu `tail(hidden)` (baris potong, diberi byte sumber yang
 * ditinggalkan berkas ini), k adalah jumlah baris terbanyak (paling sedikit satu, kurang dari semua) yang utuh muat di
 * `room` byte UTF-8; null bila tidak satu baris pun muat. Ia memotong hanya setelah LF sebuah baris, yang tidak pernah
 * berada di dalam urutan UTF-8 maupun byte karakter pengganti, jadi tidak ada karakter terbelah, dan byte tampil
 * sebuah baris adalah byte teksnya.
 */
function sourceHead(heading: string, code: { norm: Uint8Array; text: string; fence: string }, language: string, room: number, tail: (hidden: number) => string): string | null {
  const total = lineCount(code.norm);
  const lines = code.text.split('\n');
  const open = `${code.fence}${language}\n`;
  const close = `${code.fence}\n\n`;
  const note = (k: number): string => `[${total - k} of this file's ${total} lines not shown.]\n`;
  const fixed = byteLength(heading) + byteLength(open) + byteLength(close);
  let best = 0;
  let shown = 0;
  let raw = 0;
  for (let k = 1; k < total; k++) {
    shown += byteLength(lines[k - 1]!) + 1;
    raw = code.norm.indexOf(0x0a, raw) + 1;
    if (fixed + shown + byteLength(note(k)) + byteLength(tail(code.norm.length - raw)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = code.norm.indexOf(0x0a, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${heading}${open}${head}${close}${note(best)}${tail(code.norm.length - rawEnd)}`;
}

/**
 * Dossier (makefun/dossier/v1, contracts/dossier.ts) sebuah direktori entri, sebagai byte JSON kanonik:
 * sumber `dir/game/` dan berkas PNG serta JPEG `dir/screenshots/` (nama berawalan '.' dilewati). `images` adalah
 * screenshot dalam urutan nama, yang pertama sampulnya; `text` adalah blok "## Game" (hitungan sumber, vendored dan
 * aset serta totalnya) lalu "## Sources", index.html dulu, lalu berkas JS sumber dalam urutan importOrder, lalu berkas
 * sumber lain per path, masing-masing di bawah baris judul yang menyebut path, baris dan byte-nya, lalu teksnya di
 * dalam pagar. Teks memuat paling banyak `caps.text_max_bytes` byte UTF-8: setiap sumber yang muat masuk utuh, dalam
 * urutan itu; yang pertama tidak muat masuk sampai baris utuh terakhir yang muat (pagarnya ditutup, lalu satu baris
 * yang menyebut berapa barisnya tidak ditampilkan), atau tidak sama sekali bila tidak satu baris pun muat; setelahnya
 * hanya satu baris terakhir yang menyebut berapa berkas utuh dan berapa byte sumber yang ditinggalkan. Teksnya
 * deterministik: direktori yang sama menulis byte yang sama.
 *
 * Melempar DossierError untuk pohon game yang tak bisa dibaca atau melewati sebuah cap (readGameTree), game/index.html
 * yang hilang, screenshots yang tak bisa dimuat dossier mana pun, cap teks yang tak bisa memuat blok Game dan baris
 * potong, atau dossier yang melewati DOSSIER_MAX_BYTES.
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`, 'text_max_bytes');
  // Cap screenshot yang mengikat, masing-masing dengan pemiliknya: milik pemanggil bila diberikan dan lebih ketat, selain itu milik dossier.
  let maxImages = { n: DOSSIER_MAX_IMAGES, whose: 'a dossier holds' };
  let maxImageBytes = { n: DOSSIER_MAX_BYTES, whose: 'a dossier holds' };
  if (caps.screenshots !== undefined) {
    const s = caps.screenshots as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) throw new DossierError('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    for (const k of ['max', 'max_bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new DossierError(`buildDossier: caps.screenshots.${k} must be a positive integer, not ${String(v)}`, `screenshots.${k}`);
    }
    if ((s.max as number) < maxImages.n) maxImages = { n: s.max as number, whose: 'caps.screenshots.max allows' };
    if ((s.max_bytes as number) < maxImageBytes.n) maxImageBytes = { n: s.max_bytes as number, whose: 'caps.screenshots.max_bytes allows' };
  }
  const gameCaps: GameCaps = {};
  for (const k of ['game_max_files', 'game_max_bytes', 'game_path_max_bytes'] as const) {
    const v = caps[k] as unknown;
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new DossierError(`buildDossier: caps.${k} must be a whole number, not ${String(v)}`, k);
    gameCaps[k] = v;
  }

  const gameDir = join(dir, 'game');
  const tree = readGameTree(gameDir, gameCaps);
  const htmlBytes = readIndexHtml(gameDir, tree);
  const html = htmlFacts(text(htmlBytes));

  const sources = tree.files.filter((f) => f.cls === 'source').map((f) => ({ path: f.path, bytes: new Uint8Array(readFileSync(join(gameDir, f.path))) }));
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const ordered = importOrder(sources, html).filter((p) => p !== INDEX_HTML);
  const seen = new Set<string>([INDEX_HTML, ...ordered]);
  const rest = sources.map((s) => s.path).filter((p) => !seen.has(p)).sort(byCodeUnit);
  const order = [INDEX_HTML, ...ordered, ...rest];

  const codes = new Map<string, SourceCode>();
  const codeOf = (path: string): SourceCode | null => {
    let code = codes.get(path);
    if (code !== undefined) return code;
    const file = byPath.get(path);
    if (file === undefined) return null;
    const t = text(file.bytes);
    const fence = fenceFor(t);
    const block = `${fence}${languageOf(path)}\n${t}${t.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    code = { norm: file.bytes, text: t, fence, block, blockBytes: byteLength(block), lines: lineCount(file.bytes) };
    codes.set(path, code);
    return code;
  };

  const shotNames = (() => {
    const shotsDir = join(dir, 'screenshots');
    let shotDirStat;
    try {
      shotDirStat = lstatSync(shotsDir);
    } catch {
      throw new DossierError('buildDossier: no screenshots/ directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
    }
    if (!shotDirStat.isDirectory()) throw new DossierError('buildDossier: screenshots is not a directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
    let names: string[];
    try {
      names = readdirSync(shotsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort(byCodeUnit);
    } catch (err) {
      throw new DossierError(`buildDossier: screenshots/ cannot be read (${(err as Error).message})`);
    }
    return names;
  })();
  if (shotNames.length === 0) throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  if (shotNames.length > maxImages.n) throw new DossierError(`buildDossier: screenshots/ holds ${shotNames.length} files, over the ${maxImages.n} ${maxImages.whose}`, 'screenshots.max');
  const images = shotNames.map((name) => {
    if (!IMAGE_NAME.test(name)) throw new DossierError(`buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
    const size = lstatSync(join(dir, 'screenshots', name)).size;
    if (size > maxImageBytes.n) throw new DossierError(`buildDossier: screenshots/${name} is ${size} bytes, over the ${maxImageBytes.n} ${maxImageBytes.whose}`, 'screenshots.max_bytes');
    const bytes = new Uint8Array(readFileSync(join(dir, 'screenshots', name)));
    if (bytes.length > maxImageBytes.n) throw new DossierError(`buildDossier: screenshots/${name} is ${bytes.length} bytes, over the ${maxImageBytes.n} ${maxImageBytes.whose}`, 'screenshots.max_bytes');
    const media_type = opensWith(bytes, PNG_MAGIC) ? 'image/png' : opensWith(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
    if (media_type === null) throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });

  const head = [...gameBlockLines(tree), '', '## Sources', '', ''].join('\n');
  const sections = order.map((path) => {
    const code = codeOf(path);
    const lines = code === null ? 0 : code.lines;
    const bytes = code === null ? 0 : code.norm.length;
    const heading = `### game/${path} (${lines} ${lines === 1 ? 'line' : 'lines'}, ${bytes} bytes)\n\n`;
    const shown = lines === 0 ? null : code;
    return { heading, code: shown, size: byteLength(heading) + (shown === null ? 0 : shown.blockBytes), bytes };
  });
  // restBytes[k]: byte sumber berkas-berkas setelah bagian k.
  const restBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) restBytes[k] = restBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);

  const cutLine = (files: number, bytes: number): string => `[Cut at ${max} bytes: ${files} file${files === 1 ? '' : 's'} and ${bytes} bytes of source left out.]\n`;
  let out = head;
  let used = byteLength(head);
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : byteLength(cutLine(restCount, restBytes[kept]!));
    if (used + section.size + tail > max) break;
    out += section.code === null ? section.heading : `${section.heading}${section.code.block}`;
    used += section.size;
  }
  if (kept < sections.length) {
    // Sumber pertama yang tidak muat utuh: judulnya, sampai baris utuh terakhir yang muat, lalu tidak ada lagi.
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = restBytes[kept]!;
    const part = first.code === null ? null : sourceHead(first.heading, first.code, languageOf(order[kept]!), max - used, (hidden) => cutLine(restCount, after + hidden));
    out += part ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (byteLength(out) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Game block and the cut line`, 'text_max_bytes');

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

// ============================================================================
// BAGIAN 3 — Verifikasi dossier (makefun/dossier/v1)
// ============================================================================
//
// buildDossier menulis dossier dari isi game/ dan screenshots/. Bagian ini
// memeriksa dossier yang sudah ada — byte yang dibaca dari disk, dokumen yang
// baru di-JSON.parse, atau nilai apa pun yang diklaim sebagai dossier — tanpa
// membaca game/ lagi. Semua fungsi di sini murni pembaca: tidak ada yang
// menulis berkas, dan buildDossier tidak memakai satu pun dari mereka,
// sehingga keluarannya tetap byte demi byte sama.
//
// Yang diperiksa adalah hal-hal yang membuat sebuah dossier ditolak pembaca:
// skema, bentuk dokumen, `cover` yang menunjuk gambar, nama gambar, media_type
// yang cocok dengan magic byte, sha256 dan base64 yang benar-benar milik
// byte-nya, ukuran teks dan jumlah gambar terhadap cap, serta ukuran byte
// dossier terhadap DOSSIER_MAX_BYTES.

/** Kunci sebuah dokumen dossier; kunci lain di luar ini bukan dossier v1. */
export const DOSSIER_KEYS = ['cover', 'images', 'schema', 'text'] as const;

/** Satu entri `images` dossier yang sudah diperiksa bentuknya. */
export interface DossierImageEntry {
  /** Nama berkas di screenshots/, tanpa direktori. */
  name: string;
  media_type: 'image/png' | 'image/jpeg';
  /** sha256 byte berkas, 64 huruf heksadesimal kecil. */
  sha256: string;
  /** Byte berkas sebagai base64 kanonik. */
  base64: string;
}

/** Dokumen makefun/dossier/v1 yang sudah diperiksa bentuknya. */
export interface DossierDoc {
  schema: string;
  /** Indeks `images` yang menjadi sampul; buildDossier selalu 0 (gambar pertama menurut nama). */
  cover: number;
  text: string;
  images: DossierImageEntry[];
}

/** Apa yang salah dengan sebuah nilai, dinamai supaya bisa diperiksa pemanggil tanpa membaca pesannya. */
export type DossierProblemCode =
  | 'size'
  | 'utf8'
  | 'json'
  | 'not_object'
  | 'unknown_key'
  | 'schema'
  | 'cover'
  | 'text'
  | 'text_max_bytes'
  | 'images'
  | 'images.max'
  | 'image'
  | 'image.name'
  | 'image.duplicate'
  | 'image.media_type'
  | 'image.sha256'
  | 'image.base64'
  | 'image.content'
  | 'file.missing';

/** Satu masalah: di mana (`$.images[2].sha256`), apa, dan mengapa. */
export interface DossierProblem {
  path: string;
  code: DossierProblemCode;
  message: string;
}

/**
 * Cap yang dipakai memeriksa sebuah dossier. Semuanya boleh tidak ada:
 * text_max_bytes (bawaan Infinity), max_images (bawaan DOSSIER_MAX_IMAGES),
 * max_bytes (bawaan DOSSIER_MAX_BYTES), require_sections (bawaan true: teksnya
 * harus dibuka blok `## Game` dan memuat `## Sources`).
 */
export interface DossierCheckOptions {
  text_max_bytes?: number;
  max_images?: number;
  max_bytes?: number;
  require_sections?: boolean;
}

/** Hasil verifyDossier: byte yang dibaca, masalah yang ditemukan, dokumen bila bersih. */
export interface DossierReport {
  ok: boolean;
  problems: DossierProblem[];
  /** Panjang masukan dalam byte. */
  bytes: number;
  /** Dokumen yang sudah diperiksa; null bila ada satu masalah pun. */
  document: DossierDoc | null;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** base64 kanonik: kelipatan 4, alfabet standar, padding benar, dan encode ulang byte-nya sama persis. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Sebuah opsi cap: bilangan bulat tidak negatif, selain itu TypeError (bukan masalah dossier). */
function checkOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`dossier: ${name} must be a whole number, not ${String(value)}`);
  }
  return value;
}

/** Byte sebuah gambar dossier, atau null bila base64-nya tidak kanonik. */
export function decodeDossierImage(image: { readonly base64?: unknown }): Uint8Array | null {
  const { base64 } = image;
  if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !BASE64.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) return null;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

/** Media type yang diturunkan magic byte; null bila byte-nya bukan PNG maupun JPEG. */
function mediaTypeOfBytes(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (opensWith(bytes, PNG_MAGIC)) return 'image/png';
  if (opensWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  return null;
}

/** Apakah `value` objek biasa (bukan null, bukan array, prototipe Object atau null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Setiap masalah bentuk sebuah nilai yang diklaim dossier v1, tanpa menyentuh
 * disk: skema, kunci yang dikenal, `cover`, `text` (string, memuat blok Game
 * dan Sources bila diminta, tidak melewati text_max_bytes), dan `images`
 * (jumlahnya, nama unik yang sah, media_type sesuai magic byte, sha256 dan
 * base64 kanonik yang benar-benar milik byte-nya). Daftar kosong berarti
 * dossier itu lolos. Melempar TypeError hanya untuk opsi yang salah.
 */
export function dossierProblems(value: unknown, options: DossierCheckOptions = {}): DossierProblem[] {
  const maxText = checkOption('text_max_bytes', options.text_max_bytes, Infinity);
  const maxImages = checkOption('max_images', options.max_images, DOSSIER_MAX_IMAGES);
  const requireSections = options.require_sections ?? true;
  const problems: DossierProblem[] = [];
  const add = (path: string, code: DossierProblemCode, message: string): void => {
    problems.push({ path, code, message });
  };

  if (!isPlainObject(value)) {
    add('$', 'not_object', `a dossier is a JSON object, not ${Array.isArray(value) ? 'an array' : typeof value}`);
    return problems;
  }
  for (const key of Object.keys(value)) {
    if (!(DOSSIER_KEYS as readonly string[]).includes(key)) add(`$.${key}`, 'unknown_key', `a dossier v1 has no key ${JSON.stringify(key)}`);
  }
  if (value.schema !== DOSSIER_SCHEMA) {
    add('$.schema', 'schema', `schema is ${JSON.stringify(value.schema)}, not ${JSON.stringify(DOSSIER_SCHEMA)}`);
  }

  if (typeof value.text !== 'string') {
    add('$.text', 'text', `text is a string, not ${typeof value.text}`);
  } else {
    const t = value.text;
    if (requireSections && !t.startsWith('## Game\n')) add('$.text', 'text', 'text does not open with the "## Game" block buildDossier writes');
    if (requireSections && !t.includes('\n## Sources\n')) add('$.text', 'text', 'text holds no "## Sources" block');
    if (t !== '' && !t.endsWith('\n')) add('$.text', 'text', 'text does not end with a newline');
    const size = byteLength(t);
    if (size > maxText) add('$.text', 'text_max_bytes', `text is ${size} bytes, over the ${maxText} allowed`);
  }

  const images = value.images;
  if (!Array.isArray(images)) {
    add('$.images', 'images', `images is an array, not ${typeof images}`);
    return problems;
  }
  if (images.length === 0) add('$.images', 'images', 'images holds no cover');
  if (images.length > maxImages) add('$.images', 'images.max', `images holds ${images.length}, over the ${maxImages} allowed`);

  const seen = new Set<string>();
  images.forEach((raw, index) => {
    const at = `$.images[${index}]`;
    if (!isPlainObject(raw)) {
      add(at, 'image', `an image is an object, not ${Array.isArray(raw) ? 'an array' : typeof raw}`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!['base64', 'media_type', 'name', 'sha256'].includes(key)) add(`${at}.${key}`, 'unknown_key', `an image has no key ${JSON.stringify(key)}`);
    }
    const { name, media_type: mediaType, sha256, base64 } = raw;
    if (typeof name !== 'string' || !IMAGE_NAME.test(name)) {
      add(`${at}.name`, 'image.name', `name ${JSON.stringify(name)} is not letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
    } else if (name.includes('/') || name === '.' || name === '..') {
      add(`${at}.name`, 'image.name', `name ${JSON.stringify(name)} is not a bare file name`);
    } else if (seen.has(name)) {
      add(`${at}.name`, 'image.duplicate', `name ${JSON.stringify(name)} appears more than once`);
    } else {
      seen.add(name);
    }
    let bytes: Uint8Array | null = null;
    if (typeof base64 !== 'string') {
      add(`${at}.base64`, 'image.base64', `base64 is a string, not ${typeof base64}`);
    } else if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
      add(`${at}.base64`, 'image.base64', 'base64 is not canonical (length a multiple of 4, standard alphabet, correct padding)');
    } else {
      bytes = decodeDossierImage({ base64 });
      if (bytes === null) add(`${at}.base64`, 'image.base64', 'base64 does not round-trip to the same bytes');
    }
    if (bytes !== null) {
      const actualType = mediaTypeOfBytes(bytes);
      if (actualType === null) {
        add(`${at}.media_type`, 'image.media_type', 'the bytes are neither a PNG nor a JPEG');
      } else if (mediaType !== actualType) {
        add(`${at}.media_type`, 'image.media_type', `media_type is ${JSON.stringify(mediaType)}, but the bytes are ${actualType}`);
      }
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
        add(`${at}.sha256`, 'image.sha256', `sha256 is 64 lowercase hex digits, not ${JSON.stringify(sha256)}`);
      } else {
        const actual = sha256Hex(bytes);
        if (actual !== sha256) add(`${at}.sha256`, 'image.sha256', `the bytes hash to ${actual}, not the recorded ${sha256}`);
      }
    } else if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      add(`${at}.sha256`, 'image.sha256', `sha256 is 64 lowercase hex digits, not ${JSON.stringify(sha256)}`);
    }
  });

  const cover = value.cover;
  if (typeof cover !== 'number' || !Number.isInteger(cover) || cover < 0 || cover >= images.length) {
    add('$.cover', 'cover', `cover ${JSON.stringify(cover)} is not an index of the ${images.length} image(s)`);
  }
  return problems;
}

/**
 * Dossier dari byte yang dibaca di disk (atau string JSON), diperiksa utuh:
 * ukuran byte terhadap DOSSIER_MAX_BYTES, UTF-8 ketat tanpa BOM, JSON, lalu
 * bentuk dokumennya (dossierProblems). Tidak pernah melempar untuk masukan
 * yang buruk — semua masalah ada di `problems`; yang dilempar hanya TypeError
 * untuk opsi cap yang salah.
 */
export function verifyDossier(input: string | Uint8Array, options: DossierCheckOptions = {}): DossierReport {
  const maxBytes = checkOption('max_bytes', options.max_bytes, DOSSIER_MAX_BYTES);
  const raw = typeof input === 'string' ? new Uint8Array(Buffer.from(input, 'utf8')) : new Uint8Array(input);
  const problems: DossierProblem[] = [];
  const add = (path: string, code: DossierProblemCode, message: string): void => {
    problems.push({ path, code, message });
  };

  if (raw.length === 0) add('$', 'size', 'the dossier is empty');
  else if (raw.length > maxBytes) add('$', 'size', `the dossier is ${raw.length} bytes, over the ${maxBytes} one holds`);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    add('$', 'utf8', 'the dossier opens with a UTF-8 BOM, which buildDossier never writes');
  }

  let parsed: unknown;
  let text: string | null = null;
  try {
    text = utf8Strict.decode(raw);
  } catch {
    add('$', 'utf8', 'the dossier is not valid UTF-8');
  }
  if (text !== null) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      add('$', 'json', `the dossier is not valid JSON (${(err as Error).message})`);
    }
    if (problems.length === 0) problems.push(...dossierProblems(parsed, options));
  }

  const ok = problems.length === 0;
  return { ok, problems, bytes: raw.length, document: ok ? (parsed as DossierDoc) : null };
}

/** Satu baris per masalah, untuk log: `$.images[1].sha256: <pesan>`. */
export function formatDossierProblems(problems: readonly DossierProblem[]): string[] {
  return problems.map((p) => `${p.path}: ${p.message}`);
}

/**
 * verifyDossier, tetapi melempar DossierError untuk dossier yang tidak lolos:
 * pesan pertama, lalu jumlah sisanya, supaya build berhenti dengan satu baris
 * yang menyebut sebabnya.
 */
export function parseDossier(input: string | Uint8Array, options: DossierCheckOptions = {}): DossierDoc {
  const report = verifyDossier(input, options);
  if (report.problems.length > 0) {
    const first = report.problems[0]!;
    const more = report.problems.length > 1 ? ` (and ${report.problems.length - 1} more problem(s))` : '';
    throw new DossierError(`parseDossier: ${first.path}: ${first.message}${more}`);
  }
  return report.document as DossierDoc;
}

/**
 * Byte gambar `images` yang benar-benar ada di `<dir>/screenshots/` dan sama
 * dengan yang dicatat dossier: berkas biasa, byte-nya dibaca ulang, sha256 dan
 * media_type-nya cocok, dan ukurannya tidak melewati `max_bytes` (bawaan
 * DOSSIER_MAX_BYTES). Daftar kosong berarti semua gambar ada dan utuh.
 */
export function dossierFileProblems(dir: string, doc: DossierDoc, options: { max_bytes?: number } = {}): DossierProblem[] {
  const maxBytes = checkOption('max_bytes', options.max_bytes, DOSSIER_MAX_BYTES);
  const problems: DossierProblem[] = [];
  const shotsDir = join(dir, 'screenshots');
  doc.images.forEach((image, index) => {
    const at = `$.images[${index}]`;
    const path = join(shotsDir, image.name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      problems.push({ path: at, code: 'file.missing', message: `${image.name} is not at ${path}` });
      return;
    }
    if (!stat.isFile()) {
      problems.push({ path: at, code: 'file.missing', message: `${image.name} is not a plain file at ${path}` });
      return;
    }
    if (stat.size > maxBytes) {
      problems.push({ path: at, code: 'size', message: `${image.name} is ${stat.size} bytes, over the ${maxBytes} allowed` });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch (err) {
      problems.push({ path: at, code: 'file.missing', message: `${image.name} cannot be read (${(err as Error).message})` });
      return;
    }
    const actual = sha256Hex(bytes);
    if (actual !== image.sha256) {
      problems.push({ path: at, code: 'image.content', message: `${image.name} hashes to ${actual}, not the recorded ${image.sha256}` });
      return;
    }
    const actualType = mediaTypeOfBytes(bytes);
    if (actualType !== image.media_type) {
      problems.push({ path: at, code: 'image.media_type', message: `${image.name} declares ${image.media_type}, but its bytes are ${String(actualType)}` });
    }
  });
  return problems;
}

/**
 * sha256 dokumen dossier dalam bentuk kanonik: dua dossier yang sama isinya
 * memberi digest yang sama, apa pun urutan kunci di berkas asalnya. Berguna
 * untuk membandingkan dossier yang ditulis build dengan yang dibangun ulang.
 * Melempar TypeError untuk nilai yang tidak punya bentuk JSON (canonicalJson).
 */
export function dossierDigest(doc: unknown): string {
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex');
}
