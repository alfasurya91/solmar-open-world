/**
 * Development static server for the Solmar build (Node standard library only).
 * No bundler, no build step, no dependencies.
 *
 *   node serve.ts                 # http://localhost:8080
 *   node serve.ts --port 8901     # listen on some other port
 *   PORT=8901 node serve.ts       # same, for callers that can only set the environment
 *
 * Scope is deliberately tiny: this is a local convenience rather than an
 * internet-facing server, which is why it binds the loopback interface only.
 *
 *   - `/` is `game/index.html`, `/src/main.js` is `game/src/main.js`, and
 *     `/screenshots/1-chase.jpg` is `screenshots/1-chase.jpg`. Each URL subtree
 *     maps to exactly one directory, and a request is only ever served from
 *     inside the directory its URL belongs to;
 *   - traversal cannot escape that directory. The path is normalised, then the
 *     final absolute path is re-checked against the mount root; anything outside
 *     is answered 404 — the same answer a missing file gets, so a refusal never
 *     confirms what does exist on disk;
 *   - the MIME map below covers what a browser game needs (documents and code,
 *     images, fonts, glTF assets, audio, WebAssembly); an unknown extension
 *     becomes `application/octet-stream`;
 *   - the method is never used for routing. There is no write path here, so every
 *     method is answered like GET (Node suppresses the body for HEAD itself) and
 *     the method only shows up in the access log;
 *   - responses carry `Cache-Control: no-cache` and `X-Content-Type-Options:
 *     nosniff`, so a reload always shows the file as it is on disk right now and
 *     the browser never second-guesses the declared type;
 *   - every request is logged as one line, and a port that is already taken is
 *     reported as a readable sentence before exiting non-zero;
 *   - a `--port`/`PORT` value that cannot be used is named as such and skipped
 *     rather than obeyed silently, and SIGINT/SIGTERM close the listener and
 *     exit 0, so a wrapper script sees a deliberate stop as success.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The slice of `node:http`'s IncomingMessage / ServerResponse that this file
 * touches. Declaring it here keeps the repo free of an @types/node devDependency
 * while documenting exactly what is used.
 */
interface ClientRequest {
  readonly method?: string;
  readonly url?: string;
}

interface ClientResponse {
  statusCode: number;
  writeHead(status: number, headers?: Record<string, string | number>): ClientResponse;
  end(chunk?: string): void;
  destroy(): void;
  once(event: 'finish', listener: () => void): void;
}

/** The shape of a socket `error` event, reduced to the two fields read here. */
interface ListenFailure {
  readonly code?: string;
  readonly message: string;
}

/** Absolute path of this checkout — `serve.ts` sits at its root. */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** The game's static files. Everything under it is reachable at the matching URL. */
const GAME_ROOT = join(REPO_ROOT, 'game');

/** Screenshots live beside `game/`, not inside it, so they get their own mount. */
const SCREENSHOTS_ROOT = join(REPO_ROOT, 'screenshots');

/**
 * One URL subtree and the single directory it may read from. `prefix` starts with
 * a slash; `dir` is absolute. The `'/'` entry is the catch-all and must sit last.
 */
interface Mount {
  readonly prefix: string;
  readonly dir: string;
}

/** Specific mounts first, catch-all last, so the first match is the tightest one. */
const MOUNTS: readonly Mount[] = [
  { prefix: '/screenshots/', dir: SCREENSHOTS_ROOT },
  { prefix: '/', dir: GAME_ROOT },
];

/** Appended to requests whose path ends in `/`, so directories get their entry document. */
const ENTRY_DOCUMENT = 'index.html';

/** Used when neither `--port` nor `PORT` supplies a usable value. */
const DEFAULT_PORT = 8080;

/** Serving on loopback keeps this dev-only server off the network. */
const LOOPBACK_HOST = '127.0.0.1';

/** Extension (lowercase, with the dot) → Content-Type. Unlisted extensions fall back to octet-stream. */
const MIME_TYPES: Record<string, string> = {
  // Documents and code
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Fonts and 3D assets
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  // Audio and WebAssembly
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

/** The type used for any extension the table above does not mention. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Headers every served file carries.
 *
 * `no-cache` keeps the browser's copy but forces it to revalidate on each use, so
 * an edit is visible on the next reload without throwing away keep-alive reuse.
 * `nosniff` stops the browser from second-guessing the declared type; a file whose
 * extension is not in MIME_TYPES arrives as octet-stream and must not be sniffed
 * into something executable.
 */
const STATIC_FILE_HEADERS = {
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
} as const;

/**
 * Resolves the `Content-Type` for a file path from its extension.
 * Matching is case-insensitive, so `.JPG` and `.jpg` answer the same.
 */
function mimeTypeForFile(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return MIME_TYPES[extension] ?? FALLBACK_CONTENT_TYPE;
}

/** `candidate` as a port number, or `undefined` when it is not a whole number in 1–65535. */
function toUsablePort(candidate: unknown): number | undefined {
  if (candidate === undefined || candidate === '') return undefined;
  const requested = Number(candidate);
  return Number.isInteger(requested) && requested > 0 && requested < 65536 ? requested : undefined;
}

/** Which of the three sources supplied the port, for the startup banner and for a skipped-value note. */
type PortSource = 'flag' | 'env' | 'default';

interface ChosenPort {
  readonly port: number;
  readonly source: PortSource;
  /** The raw value that was skipped because it was unusable, if any. */
  readonly skipped: readonly string[];
}

/**
 * Picks the port to listen on, first usable value wins:
 *
 *   1. `--port <n>` on the command line (what the README documents);
 *   2. `PORT` in the environment (for callers that cannot pass argv);
 *   3. DEFAULT_PORT (8080).
 *
 * An unusable value is skipped rather than treated as fatal: a typo in a dev flag
 * should not stop the server from starting. What was skipped is returned too, so
 * the caller can say so instead of silently serving on a port nobody asked for.
 */
function chooseListenPort(argv: readonly string[], env: NodeJS.ProcessEnv): ChosenPort {
  const skipped: string[] = [];
  const flagIndex = argv.indexOf('--port');
  const rawFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const fromFlag = toUsablePort(rawFlag);
  if (rawFlag !== undefined && fromFlag === undefined) skipped.push(`--port ${JSON.stringify(rawFlag)}`);
  if (fromFlag !== undefined) return { port: fromFlag, source: 'flag', skipped };

  const rawEnv = env.PORT;
  const fromEnv = toUsablePort(rawEnv);
  if (rawEnv !== undefined && rawEnv !== '' && fromEnv === undefined) skipped.push(`PORT ${JSON.stringify(rawEnv)}`);
  if (fromEnv !== undefined) return { port: fromEnv, source: 'env', skipped };

  return { port: DEFAULT_PORT, source: 'default', skipped };
}

/** Outcome of a path resolution: an absolute file path, or the HTTP status to answer with. */
type PathResolution = { readonly file: string } | { readonly status: number };

/** The mount a decoded pathname addresses; the catch-all `'/'` covers the rest. */
function mountForPathname(pathname: string): Mount {
  return MOUNTS.find((mount) => pathname.startsWith(mount.prefix)) ?? MOUNTS[MOUNTS.length - 1];
}

/**
 * Turns a request URL into a file path inside the directory that URL addresses, or
 * into the status code that refusal deserves:
 *
 *   400 — the path is not valid percent-encoding (`decodeURIComponent` throws);
 *   404 — it decodes to something that escapes its mount. Escaping is answered as
 *         "not found" rather than "forbidden" on purpose: the response must not
 *         confirm that anything exists above the document root.
 *
 * Traversal defence has two independent layers: `normalize` collapses `.`/`..`
 * segments before the join, and the `startsWith(dir + sep)` check re-verifies the
 * final absolute path against the mount root. The second is the authoritative one —
 * it holds no matter how the URL was spelled (raw `..`, `%2e%2e`, doubled slashes,
 * backslashes).
 */
function resolveRequestPath(rawUrl: string | undefined): PathResolution {
  // Parse against a placeholder base — only `pathname` is used, never host or query.
  const encodedPathname = new URL(rawUrl ?? '/', 'http://localhost').pathname;

  let pathname: string;
  try {
    pathname = decodeURIComponent(encodedPathname);
  } catch {
    return { status: 400 };
  }

  // A request for a directory serves that directory's entry document.
  if (pathname.endsWith('/')) pathname += ENTRY_DOCUMENT;

  const mount = mountForPathname(pathname);
  const pathBelowMount = pathname.slice(mount.prefix.length);
  const filePath = resolve(join(mount.dir, normalize(pathBelowMount)));

  const staysInsideMount = filePath === mount.dir || filePath.startsWith(mount.dir + sep);
  return staysInsideMount ? { file: filePath } : { status: 404 };
}

/**
 * Size in bytes of a regular file, or `null` when the path is missing or is not a
 * regular file (a directory, a socket, a device…). Both cases are deliberately
 * indistinguishable: the client gets the same 404, so a response never reveals what
 * does exist on disk.
 */
function regularFileSize(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/** The header set of a 200 response for one file: its type, its length, and the static-file policy. */
function headersForServedFile(filePath: string, size: number): Record<string, string | number> {
  return {
    'content-type': mimeTypeForFile(filePath),
    'content-length': size,
    ...STATIC_FILE_HEADERS,
  };
}

/**
 * Streams a single file back to the client and reports the status it wrote.
 *
 * Read errors after the headers are out can no longer change the status, so the
 * connection is destroyed instead of leaving a half-written body on it.
 */
function streamFileToClient(filePath: string, response: ClientResponse): number {
  const size = regularFileSize(filePath);
  if (size === null) {
    response.writeHead(404).end('not found');
    return 404;
  }

  response.writeHead(200, headersForServedFile(filePath, size));

  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  // ClientResponse is the minimal shape declared here; at runtime it is a real
  // ServerResponse, which is a Writable, so the pipe target is exact.
  stream.pipe(response as unknown as NodeJS.WritableStream);
  return 200;
}

/**
 * Access log, one line per completed response: `GET /src/main.js 200`.
 * Logging on `finish` records the final status, even for a stream that fails after
 * its headers have already gone out.
 */
function logCompletedRequest(request: ClientRequest, response: ClientResponse): void {
  response.once('finish', () => {
    console.log(`${request.method ?? 'GET'} ${request.url ?? '/'} ${response.statusCode}`);
  });
}

/**
 * Request handler. The method is deliberately not consulted for routing: this
 * server exposes no mutating route, so every method is served the same way a GET
 * is, and HEAD works because Node suppresses the body itself.
 */
function handleRequest(request: ClientRequest, response: ClientResponse): void {
  logCompletedRequest(request, response);

  const resolution = resolveRequestPath(request.url);
  if ('status' in resolution) {
    response.writeHead(resolution.status).end(resolution.status === 400 ? 'bad request' : 'not found');
    return;
  }

  streamFileToClient(resolution.file, response);
}

/**
 * Turns a failed bind into readable advice instead of a stack trace, then exits
 * non-zero so a wrapper script does not mistake a dead server for a running one.
 */
function reportListenFailure(port: number, failure: ListenFailure): never {
  if (failure.code === 'EADDRINUSE') {
    console.error(`cannot start the game server: port ${port} is already in use on ${LOOPBACK_HOST}.`);
    console.error(`  stop whatever holds it, or choose another port: node serve.ts --port ${port + 1}`);
  } else if (failure.code === 'EACCES') {
    console.error(`cannot start the game server: port ${port} is not permitted on this machine.`);
    console.error('  pick one above 1023, e.g. node serve.ts --port 8080');
  } else {
    console.error(`cannot start the game server on ${LOOPBACK_HOST}:${port} (${failure.message}).`);
  }
  process.exit(1);
}

/**
 * Ends the process on a signal the way a dev tool should: stop accepting connections, let the
 * listener close, then exit 0 so the shell that started the server sees a deliberate stop.
 * A second signal that arrives before the close finishes exits at once.
 */
function stopOnSignals(server: ReturnType<typeof createServer>, port: number): void {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) {
        process.exit(0);
        return;
      }
      stopping = true;
      console.log(`game/ server on port ${port} is stopping (${signal})`);
      // The watchdog is not unref'd: this file declares no Node timer type, and exit(0) ends it either way.
      setTimeout(() => process.exit(0), 2000);
      server.close(() => process.exit(0));
    });
  }
}

const chosen = chooseListenPort(process.argv.slice(2), process.env);
const port = chosen.port;

for (const skipped of chosen.skipped) {
  console.warn(`ignoring an unusable port: ${skipped} is not a whole number in 1-65535`);
}

const server = createServer((request, response) => handleRequest(request, response));

server.on('error', (failure: ListenFailure) => reportListenFailure(port, failure));

stopOnSignals(server, port);

server.listen(port, LOOPBACK_HOST, () => {
  const from = chosen.source === 'default' ? ' (the default port)' : '';
  console.log(`game/ is on http://localhost:${port}${from}`);
});
