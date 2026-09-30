#!/usr/bin/env node
/**
 * endpoint_finder.js — Bug-bounty endpoint finder (bookmarklet logic as a CLI)
 *
 * Same mechanism as your bookmarklets, run headlessly in Chromium:
 *   1. Render page in real Chromium (headless)
 *   2. Collect <script src=...> + network-observed .js URLs + absolute
 *      https://….js URLs mentioned in HTML/JS (2nd bookmarklet), fetch bodies
 *   3. Run the /path regex on page HTML + every JS file, plus one discovery
 *      round: .js files referenced-but-never-loaded get fetched too
 *   4. Resolve every "/path" to a complete absolute URL, save sorted unique
 *      (in-scope only by default; --scope all keeps everything)
 *
 * Exact bookmarklet regex (runs NATIVELY here — no Python lookbehind workaround):
 *   /(?<=("|%27|`))\/[a-zA-Z0-9_?&=\/\-\#\.]*(?=("|'|%60))/g
 *
 * Usage:
 *   node endpoint_finder.js -i subs.txt
 *   node endpoint_finder.js -i https://example.com/page
 *   node endpoint_finder.js -u https://example.com/page
 *   node endpoint_finder.js https://example.com/page
 *   cat subs.txt | node endpoint_finder.js
 *
 * Output files — always a pair, urls and js never mixed (unless -o is given):
 *   single target   -> <domain>-urls.txt + <domain>-js.txt
 *   several targets -> urls1.txt+js1.txt, urls2.txt+js2.txt, … (first free pair,
 *                      never overwrites, so the next scan gets fresh files)
 *   explicit -o foo.txt -> foo.txt (urls) + foo-js.txt (js)
 *
 * Scope filter (default: domain): only URLs on the target's registrable
 * domain are kept — third-party trackers (oracleinfinity.io, taboola,
 * bing, …) are dropped. Use --scope all to keep everything,
 * --scope host for exact-hostname matches only.
 *
 * Install:
 *   npm install
 *   npx playwright install chromium
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Bookmarklet regex — native JS, exact copy
// ---------------------------------------------------------------------------
// biome-ignore lint: intentional exact bookmarklet copy
const STRICT_RE = /(?<=("|%27|`))\/[a-zA-Z0-9_?&=\/\-\#\.]*(?=("|'|%60))/g;
// Robust fix: original misses '/api/x' (no raw ' in lookbehind),
// `/api/x` (no raw ` in lookahead) and %27...%27 pairs. Same mechanism,
// just accepts all quote styles on both sides.
const ROBUST_RE = /(?<=("|'|%22|%27|`|%60))\/[a-zA-Z0-9_?&=\/\-\#\.]*(?=("|'|%22|%27|`|%60))/g;

function extractPaths(text, strict = false) {
  if (!text) return new Set();
  const rx = strict ? STRICT_RE : ROBUST_RE;
  rx.lastIndex = 0;
  const out = new Set();
  for (const m of text.matchAll(rx)) {
    const p = m[0];
    if (!p || p.length <= 1) continue; // skip bare "/"
    if (p === '//') continue;
    out.add(p);
  }
  return out;
}

// Second bookmarklet, exact copy: absolute .js file URLs mentioned in
// HTML/JS bodies — lazy chunks, dynamic imports, commented URLs that the
// browser never loads as scripts (so tag + network collection misses them).
// biome-ignore lint: intentional exact bookmarklet copy
const JS_URL_RE = /https?:\/\/[^\s"'`<>]+\.js(?:\?[^\s"'`<>]*)?/g;

function extractJsUrls(text) {
  const out = new Set();
  if (!text) return out;
  JS_URL_RE.lastIndex = 0;
  for (const m of text.matchAll(JS_URL_RE)) {
    try {
      const parsed = new URL(m[0]);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      out.add(parsed.href);
    } catch { /* malformed — skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
const SKIP_SCHEMES = ['data:', 'blob:', 'javascript:', 'about:', 'mailto:', 'tel:', 'ws:', 'wss:'];

const STATIC_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.avi', '.mov', '.pdf', '.zip',
]);

function cleanToken(tok) {
  const s = (tok ?? '').trim().replace(/^['"`,;]+|['"`,;]+$/g, '');
  if (!s || s.startsWith('#')) return null;
  return s;
}

function splitMaybeMulti(line) {
  return line
    .split(/[,\s]+/)
    .map(cleanToken)
    .filter(Boolean);
}

function looksLikeTarget(s) {
  const t = (s ?? '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!t) return false;
  if (/^(https?:\/\/|\/\/)/i.test(t)) return true;
  if (!t.includes('/') && !t.includes('\\') && /^[\w\-.~]+\.(txt|csv|lst|list|json|dic)$/i.test(t)) {
    return false; // missing file, not a host
  }
  if (/^[A-Za-z0-9_.\-]+(?::\d+)?(?:\/.*)?$/.test(t) && t.split('/')[0].includes('.')) return true;
  // fallback for IDN/unicode hosts (münchen.de) the ASCII regex rejects:
  // if it parses as a URL with a dotted hostname, it's a target.
  // (runs after the missing-file guard above, so subs.txt still errors)
  try {
    if (new URL(`https://${t}`).hostname.includes('.')) return true;
  } catch { /* not a URL — fall through */ }
  return false;
}

function candidateUrls(raw) {
  const s = (raw ?? '').trim();
  if (!s) return [];
  if (/^https?:\/\//i.test(s)) return [s];
  if (s.startsWith('//')) return [`https:${s}`, `http:${s}`];
  return [`https://${s}`, `http://${s}`];
}

function shouldSkipScriptSrc(src) {
  if (!src || !src.trim()) return true;
  const low = src.trim().toLowerCase();
  return SKIP_SCHEMES.some((p) => low.startsWith(p));
}

function resolveToAbsolute(basePageUrl, rawPath) {
  if (!rawPath || !rawPath.startsWith('/') || rawPath.length <= 1) return null;
  try {
    if (rawPath.startsWith('//')) {
      const scheme = new URL(basePageUrl).protocol || 'https:';
      return `${scheme}${rawPath}`;
    }
    const abs = new URL(rawPath, basePageUrl).href;
    const u = new URL(abs);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.host) return null;
    return abs;
  } catch {
    return null;
  }
}

function isStaticNoise(absUrl) {
  try {
    const p = new URL(absUrl).pathname.toLowerCase();
    for (const ext of STATIC_EXTS) {
      if (p.endsWith(ext)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** Normal logs (suppressed with -q/--quiet). FAIL + DONE always print. */
function info(...a) {
  if (!globalThis.__QUIET) console.log(...a);
}

// Result table (no borders, aligned spacing)
const TW = 62; // target column width
function cell(s, w) {
  s = String(s ?? '');
  if (s.length > w) s = s.slice(0, w - 1) + '…';
  return s.padEnd(w);
}
function tableHeader() {
  return `${'TARGET'.padEnd(TW)} ${'SCRIPTS'.padStart(7)} ${'PATHS'.padStart(7)} ${'URLS'.padStart(7)} ${'NEW'.padStart(7)}`;
}
function okRow(target, js, paths, urls, added) {
  return `${cell(target, TW)} ${String(js).padStart(7)} ${String(paths).padStart(7)} ${String(urls).padStart(7)} ${(`+${added}`).padStart(7)}`;
}
function failRow(input, err) {
  let e = String(err ?? '');
  if (e.length > 70) e = e.slice(0, 69) + '…';
  return `${cell(input, TW)}  FAIL  ${e}`;
}

/** Truncate huge URLs (B2C/OAuth redirect chains) so logs stay readable. */
function short(url, max = 120) {
  if (!url) return url;
  return url.length > max ? `${url.slice(0, max)}…(len=${url.length})` : url;
}

// ---------------------------------------------------------------------------
// Scope helpers — keep target domains, drop third-party trackers
// ---------------------------------------------------------------------------
// Minimal multi-label public suffixes so registrableDomain() works for
// common ccTLDs (co.uk, co.in, com.au, …) without a full PSL dependency.
const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk', 'sch.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'res.in', 'firm.in', 'gen.in',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'com.br', 'com.mx', 'com.tr', 'co.kr', 'com.ar',
  'co.id', 'co.th', 'com.sg', 'com.hk', 'com.tw', 'com.ph', 'com.vn', 'com.my',
  'co.il', 'com.eg', 'com.sa', 'com.ae', 'com.qa', 'com.kw',
]);

/** e.g. www.dell.com -> dell.com ; sub.example.co.uk -> example.co.uk ; 1.2.3.4 -> 1.2.3.4 */
function registrableDomain(host) {
  const h = (host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return h; // IPv4 / IPv6
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

function hostnameOfUrl(absUrl) {
  try {
    return new URL(absUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Hostname for a raw target string (bare host or full URL). */
function targetHostname(raw) {
  const s = (raw ?? '').trim();
  if (!s) return '';
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).hostname.toLowerCase();
    if (s.startsWith('//')) return new URL(`https:${s}`).hostname.toLowerCase();
    return s.split('/')[0].split(':')[0].toLowerCase();
  } catch {
    return '';
  }
}

function sanitizeFilename(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9.\-]+/g, '_');
}

/** Default output pair for one target: <host>-urls.txt + <host>-js.txt */
function deriveOutputFilenames(targets) {
  const hosts = [...new Set(targets.map(targetHostname).filter(Boolean))];
  const base = hosts.length === 1 ? sanitizeFilename(hosts[0]) : 'endpoints';
  return { urls: `${base}-urls.txt`, js: `${base}-js.txt` };
}

/** First free numbered pair: urls1.txt+js1.txt, urls2.txt+js2.txt, … (never overwrites) */
function nextNumberedPair(dir) {
  let n = 1;
  while (fs.existsSync(path.join(dir, `urls${n}.txt`))
      || fs.existsSync(path.join(dir, `js${n}.txt`))) n++;
  return {
    urls: path.join(dir, `urls${n}.txt`),
    js: path.join(dir, `js${n}.txt`),
  };
}

/** Explicit -o names the urls file; js goes to a sibling (foo.txt -> foo-js.txt). */
function jsSiblingFilename(outFile) {
  const dot = outFile.lastIndexOf('.');
  if (dot > 0) return `${outFile.slice(0, dot)}-js${outFile.slice(dot)}`;
  return `${outFile}-js.txt`;
}

/** True if the URL points to a JS file (path ends .js, query ignored). */
function isJsFile(absUrl) {
  try {
    return new URL(absUrl).pathname.toLowerCase().endsWith('.js');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auto-tuned parallelism + per-host rate limiting (no user flags).
// Pages run on parallel workers; requests to the SAME host are spaced out
// with jitter so scans stay fast across hosts without tripping IP bans.
// ---------------------------------------------------------------------------
const PAGE_WORKERS_MAX = 10;  // parallel pages (auto: fewer for small lists)
const JS_POOL_SIZE = 12;      // parallel JS fetches (global)
const JS_DISCOVERY_EXTRA = 20; // extra fetches for round-2 discovered .js files
const PAGE_GAP_MS = 300;      // min gap between page loads on the SAME host
const JS_GAP_MS = 100;        // min gap between JS fetches on the SAME host
const JITTER_MS = 120;        // random extra delay (human-like spacing)
const PREFLIGHT_MS = 4000;    // TCP connect check: dead hosts fail in ~4s, not 30s

function autoPageWorkers(nTargets) {
  return Math.min(PAGE_WORKERS_MAX, Math.max(4, nTargets));
}

/** Serializes per-host access with a minimum gap + jitter between calls. */
class HostThrottle {
  constructor() {
    this.last = new Map();
    this.tails = new Map();
  }
  async acquire(host, gapMs) {
    const h = (host || '').toLowerCase();
    if (!h) return;
    const prev = this.tails.get(h) || Promise.resolve();
    let release;
    const cur = new Promise((r) => { release = r; });
    this.tails.set(h, prev.then(() => cur));
    await prev;
    try {
      const waitMs = gapMs + Math.random() * JITTER_MS - (Date.now() - (this.last.get(h) || 0));
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    } finally {
      this.last.set(h, Date.now());
      release();
    }
  }
}

/** Bounded parallel map (fixed pool, preserves order). */
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.min(size, items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

const pageThrottle = new HostThrottle();
const jsThrottle = new HostThrottle();
const jsCache = new Map(); // url -> Promise<string|null> (shared across targets)

async function fetchTextOnce(url, timeoutSec, maxBytes = 8_000_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': globalThis.__UA },
    });
    if (res.status >= 400) return null;
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (/image\/|video\/|audio\/|font|\boctet-stream\b/.test(ctype)) {
      if (!url.toLowerCase().split('?')[0].endsWith('.js')) return null;
    }
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Throttled + globally cached JS fetch (same CDN file fetched once per run).
 *  Failures are NOT cached, so another target sharing the file retries it. */
function fetchText(url, timeoutSec, maxBytes = 8_000_000) {
  let p = jsCache.get(url);
  if (!p) {
    p = (async () => {
      await jsThrottle.acquire(hostnameOfUrl(url), JS_GAP_MS);
      const text = await fetchTextOnce(url, timeoutSec, maxBytes);
      if (text === null) jsCache.delete(url);
      return text;
    })();
    jsCache.set(url, p);
  }
  return p;
}

/** Fast TCP preflight: unreachable hosts fail in ~PREFLIGHT_MS instead of the
 *  full 30s browser timeout. Returns true if host:port accepts a connection. */
function tcpReachable(host, port, timeoutMs = PREFLIGHT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const s = new net.Socket();
    // overall timer: socket timeout alone may not cover a stalled DNS lookup
    const overall = setTimeout(() => finish(false), timeoutMs + 1000);
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
    try {
      s.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

// ---------------------------------------------------------------------------
// CLI parsing (no deps)
// ---------------------------------------------------------------------------
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const args = {
    input: null,
    urls: [],
    targets: [],
    output: null, // null = auto-name (single: <domain>-endpoints.txt, multi: endpointsN.txt)
    outputExplicit: false,
    timeout: 30,
    jsTimeout: 15,
    wait: 3,
    maxScripts: 100,
    headless: true,
    noFallback: false,
    fallback: false,
    strict: false,
    noInline: false,
    excludeStatic: false,
    scope: 'domain', // domain | host | all
    quiet: false,
    userAgent: DEFAULT_UA,
    verbose: false,
    help: false,
  };
  const a = argv.slice(2);
  let i = 0;
  // honor -q anywhere in argv before any logging happens
  if (a.includes('-q') || a.includes('--quiet')) globalThis.__QUIET = true;
  const need = (flag) => {
    const v = a[++i];
    if (v === undefined) {
      console.error(`Missing value for ${flag}`);
      process.exit(2);
    }
    return v;
  };
  while (i < a.length) {
    const t = a[i];
    switch (t) {
      case '-h':
      case '--help': args.help = true; i++; break;
      case '-i':
      case '--input': args.input = need(t); i++; break;
      case '-u':
      case '--url': args.urls.push(need(t)); i++; break;
      case '-o':
      case '--output': args.output = need(t); args.outputExplicit = true; i++; break;
      case '--timeout': args.timeout = Math.max(1, parseFloat(need(t)) || 30); i++; break;
      case '--js-timeout': args.jsTimeout = Math.max(1, parseFloat(need(t)) || 15); i++; break;
      case '--wait': args.wait = parseFloat(need(t)); if (Number.isNaN(args.wait) || args.wait < 0) args.wait = 3; i++; break;
      case '--max-scripts': args.maxScripts = Math.min(1000, Math.max(0, parseInt(need(t), 10) || 0)); i++; break;
      case '--headless': args.headless = true; i++; break;
      case '--no-headless': args.headless = false; i++; break;
      case '--no-fallback': args.noFallback = true; i++; break;
      case '--fallback': args.fallback = true; i++; break;
      case '--strict': args.strict = true; i++; break;
      case '--no-inline': args.noInline = true; i++; break;
      case '--exclude-static': args.excludeStatic = true; i++; break;
      case '--scope': {
        const v = need(t).toLowerCase();
        if (!['domain', 'host', 'all'].includes(v)) {
          console.error(`Invalid --scope: ${v} (choose domain|host|all)`);
          process.exit(2);
        }
        args.scope = v; i++; break;
      }
      case '--user-agent': args.userAgent = need(t); i++; break;
      case '--verbose': args.verbose = true; i++; break;
      case '-q':
      case '--quiet': args.quiet = true; globalThis.__QUIET = true; i++; break;
      default:
        if (t.startsWith('-')) {
          console.error(`Unknown flag: ${t} (see --help)`);
          process.exit(2);
        }
        // forgive a missing dash: bare `u <url>` == `-u <url>`
        // (same for i/o). Only when the next token exists, isn't another
        // flag, and this token isn't an actual file on disk.
        if (/^[iuo]$/.test(t) && i + 1 < a.length && !a[i + 1].startsWith('-')
            && !(fs.existsSync(t) && fs.statSync(t).isFile())) {
          const v = a[++i];
          if (t === 'i') args.input = v;
          else if (t === 'u') args.urls.push(v);
          else if (t === 'o') { args.output = v; args.outputExplicit = true; }
          info(`[FIX] treated bare "${t} ${short(v, 60)}" as "-${t} ${short(v, 60)}" (missing dash)`);
          i++;
          break;
        }
        args.targets.push(t); i++;
    }
  }
  return args;
}

function printHelp() {
  console.log(`endpoint_finder.js — headless endpoint finder (bookmarklet logic)

Usage:
  node endpoint_finder.js -i subs.txt
  node endpoint_finder.js -i https://example.com/page
  node endpoint_finder.js -u https://example.com/page
  node endpoint_finder.js https://example.com/page
  cat subs.txt | node endpoint_finder.js

  Single-letter flags also work without the dash: u <url> == -u <url>
  (same for i, o).

  Speed is automatic: parallel pages + parallel JS fetches with per-host
  rate limiting and jitter (no thread flags needed, IP-ban safe).

  Output file is auto-named from the target unless -o is given:
  dell.com -> dell.com-endpoints.txt

Options:
  -i, --input <file|url>   file with targets (one per line) or a single URL/host
  -u, --url <url>          single target (repeatable)
  -o, --output <file>      names the urls file (a js sibling is added beside it:
                           foo.txt -> foo.txt + foo-js.txt).
                           Single target default: <domain>-urls.txt + <domain>-js.txt;
                           multi-target default: urls1.txt+js1.txt, urls2.txt+js2.txt…
                           (first free pair, never overwrites)
  --timeout <s>            per-page goto timeout (default: 30)
  --js-timeout <s>         per-JS fetch timeout (default: 15)
  --wait <s>               fixed wait after load, mirrors bookmarklet setTimeout(3000) (default: 3)
  --max-scripts <n>        max JS files per page (default: 100)
  --headless / --no-headless
  --no-fallback            bare hosts: try https only (default tries https then http)
  --fallback               explicit https URL failing also tries http variant
  --strict                 exact bookmarklet quote handling (misses single-quoted paths)
  --no-inline              skip inline <script> bodies
  --exclude-static         drop png/jpg/woff/mp4/... assets
  --scope <mode>           domain (default): keep target's registrable domain only,
                           drops third-party trackers (oracleinfinity.io, taboola…);
                           host: exact hostname only (a redirect to another
                           hostname is then out of scope); all: keep everything
  --user-agent <str>       browser + fetch UA
  --verbose                retry/timeout logs
  -q, --quiet              clean output: only [FAIL] and [DONE] print
  -h, --help               this help`);
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Bare localhost (no dot) is a legit target; other dot-less strings are typos. */
function isBareLocalhost(s) {
  return /^localhost(?::\d+)?(?:\/.*)?$/i.test((s || '').trim());
}

/** Entries that are existing files expand to their lines (target lists). */
function expandEntries(entries) {
  const lines = [];
  for (const e of entries || []) {
    if (fs.existsSync(e) && fs.statSync(e).isFile()) {
      lines.push(...readLines(e));
    } else {
      lines.push(e);
    }
  }
  return lines;
}

/** Read a text file as lines, stripping a UTF-8 BOM (Windows-edited lists). */
function readLines(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
}

/** Normalized dedupe key: dell.com == https://dell.com/ (same scan, run once). */
function dedupeKey(part) {
  try {
    const first = candidateUrls(part)[0];
    if (!first) return part.trim().toLowerCase();
    const u = new URL(first);
    const host = u.hostname.toLowerCase();
    let port = u.port;
    if ((u.protocol === 'https:' && port === '443') || (u.protocol === 'http:' && port === '80')) port = '';
    const p = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${host}${port ? `:${port}` : ''}${p}${u.search}`;
  } catch {
    return part.trim().toLowerCase();
  }
}

async function loadTargets(args) {
  let rawLines = [];
  if (args.input) {
    if (fs.existsSync(args.input) && fs.statSync(args.input).isFile()) {
      rawLines = readLines(args.input);
    } else if (looksLikeTarget(args.input)) {
      rawLines = [args.input]; // single URL passed to -i
    } else {
      console.error(`Input file not found: ${args.input}`);
      process.exit(2);
    }
  }
  rawLines.push(...expandEntries(args.urls), ...expandEntries(args.targets));
  if (rawLines.length === 0) {
    const stdin = await readStdin();
    if (stdin == null) {
      console.error('No targets given. Use -i subs.txt | -i <url> | -u <url> | positional URL | pipe stdin.');
      process.exit(2);
    }
    rawLines = stdin.replace(/^\uFEFF/, '').split(/\r?\n/);
  }
  const seen = new Set();
  const targets = [];
  let skipped = 0;
  for (const line of rawLines) {
    for (const part of splitMaybeMulti(line)) {
      if (!looksLikeTarget(part) && !isBareLocalhost(part)) {
        skipped++;
        // cap the noise: first 10 in full, rest as one summary line
        if (skipped <= 10) {
          info(`[SKIP] "${short(part, 80)}" doesn't look like a URL/host (did you mean "-i ${part}"?). To force it, pass as http://...`);
        }
        continue;
      }
      const key = dedupeKey(part);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(part);
      }
    }
  }
  if (skipped > 10) info(`[SKIP] …and ${skipped - 10} more invalid entries skipped`);
  if (targets.length === 0) {
    console.error('No targets found in input.');
    process.exit(2);
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Per-target worker
// ---------------------------------------------------------------------------
async function processSingleUrl(targetUrl, browser, args) {
  const foundRaw = new Set();
  const scriptSrcs = new Set();
  const discoveredJs = new Set(); // absolute .js URLs found in text (2nd bookmarklet)
  const networkJs = new Set();
  let finalUrl = targetUrl;

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: args.userAgent,
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  page.on('response', (resp) => {
    try {
      const u = resp.url();
      const ctype = (resp.headers()['content-type'] || '').toLowerCase();
      if (u.split('?')[0].includes('.js') || ctype.includes('javascript')) {
        if (!shouldSkipScriptSrc(u)) networkJs.add(u);
      }
    } catch { /* ignore */ }
  });

  try {
    // rate-limit page loads per host (polite, avoids IP ban)
    await pageThrottle.acquire(hostnameOfUrl(targetUrl), PAGE_GAP_MS);
    try {
      const resp = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: args.timeout * 1000,
      });
      if (resp?.url()) {
        finalUrl = resp.url();
      } else {
        const cur = page.url() || targetUrl;
        finalUrl = cur.startsWith('about:') ? targetUrl : cur;
      }
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Timeout/i.test(msg)) {
        if (args.verbose) info(`[WARN] goto timeout ${short(targetUrl)}`);
        const cur = (() => { try { return page.url() || targetUrl; } catch { return targetUrl; } })();
        finalUrl = cur.startsWith('about:') ? targetUrl : cur;
      } else {
        throw new Error(`goto failed: ${msg.split('\n')[0]}`);
      }
    }

    // helpers bound to this page (finalUrl may advance after redirects)
    const scopeHostNow = () => registrableDomain(hostnameOfUrl(finalUrl));
    const sameFirst = (list) => {
      const sh = scopeHostNow();
      return [...list].sort((a, b) => {
        const ad = registrableDomain(hostnameOfUrl(a)) === sh ? 0 : 1;
        const bd = registrableDomain(hostnameOfUrl(b)) === sh ? 0 : 1;
        return ad - bd || (a < b ? -1 : a > b ? 1 : 0);
      });
    };
    // <script src> tags known RIGHT NOW (early pass runs pre-wait, late pass post-wait)
    const collectTagSrcs = async () => {
      const found = new Set();
      try {
        const srcs = await page.$$eval('script[src]', (els) => els.map((e) => e.src));
        for (const s of srcs || []) {
          if (shouldSkipScriptSrc(s)) continue;
          try {
            const abs = new URL(s, finalUrl).href;
            if (/^https?:\/\//i.test(abs)) found.add(abs);
          } catch { /* bad src */ }
        }
      } catch { /* no scripts yet */ }
      return found;
    };

    // EARLY pass: fetch known scripts in the BACKGROUND while the page
    // settles below — the fixed wait is no longer idle time.
    for (const u of await collectTagSrcs()) scriptSrcs.add(u);
    for (const u of networkJs) {
      try {
        scriptSrcs.add(new URL(u, finalUrl).href);
      } catch { /* ignore */ }
    }
    const earlyList = sameFirst(scriptSrcs).slice(0, args.maxScripts);
    const fetched = new Set(earlyList);
    const bgProducts = mapPool(earlyList, JS_POOL_SIZE, (u) => fetchText(u, args.jsTimeout));

    try {
      await page.waitForLoadState('networkidle', { timeout: 2500 });
    } catch { /* slow SPA / beacon-heavy pages — fixed wait below still applies */ }
    if (args.wait > 0) await new Promise((r) => setTimeout(r, args.wait * 1000));
    try {
      const cur = page.url() || finalUrl;
      if (cur && !cur.startsWith('about:')) finalUrl = cur;
    } catch { /* keep finalUrl */ }

    // LATE pass: scripts injected during load + full page content
    for (const u of await collectTagSrcs()) scriptSrcs.add(u);
    for (const u of networkJs) {
      try {
        scriptSrcs.add(new URL(u, finalUrl).href);
      } catch { /* ignore */ }
    }

    // page HTML == document.documentElement.outerHTML
    try {
      const html = await page.content();
      for (const p of extractPaths(html, args.strict)) foundRaw.add(p);
      for (const u of extractJsUrls(html)) {
        scriptSrcs.add(u);
        discoveredJs.add(u);
      }
    } catch { /* ignore */ }

    if (!args.noInline) {
      try {
        const inlines = await page.$$eval('script:not([src])', (els) =>
          els.map((e) => e.textContent || ''),
        );
        for (const body of inlines || []) {
          if (!body) continue;
          for (const p of extractPaths(body, args.strict)) foundRaw.add(p);
          for (const u of extractJsUrls(body)) {
            scriptSrcs.add(u);
            discoveredJs.add(u);
          }
        }
      } catch { /* ignore */ }
    }

    // fetch each JS body == fetch(t).then(t.text())
    // bounded pool + per-host throttle + global cache (fast, no ban).
    // same-domain scripts first: they hold in-scope endpoints, so a
    // max-scripts cap never cuts them in favor of third-party trackers.
    // every absolute .js URL we know (tag srcs included) is endpoint output
    // if in scope — same as the 2nd bookmarklet listing them.
    for (const u of scriptSrcs) discoveredJs.add(u);

    // round 1: background results + anything discovered since (within cap)
    const restList = sameFirst([...scriptSrcs].filter((u) => !fetched.has(u)))
      .slice(0, Math.max(0, args.maxScripts - earlyList.length));
    for (const u of restList) fetched.add(u);
    const restProducts = mapPool(restList, JS_POOL_SIZE, (u) => fetchText(u, args.jsTimeout));

    const allBodies = [...(await bgProducts), ...(await restProducts)];

    // round 2: absolute .js URLs discovered inside round-1 bodies —
    // files the page references but never loads (2nd bookmarklet's trick)
    const round2 = [];
    for (const txt of allBodies) {
      if (!txt) continue;
      for (const p of extractPaths(txt, args.strict)) foundRaw.add(p);
      for (const u of extractJsUrls(txt)) {
        discoveredJs.add(u);
        if (!fetched.has(u)) {
          fetched.add(u);
          round2.push(u);
        }
      }
    }
    const jsList2 = sameFirst(round2).slice(0, JS_DISCOVERY_EXTRA);
    const products2 = await mapPool(jsList2, JS_POOL_SIZE, (u) => fetchText(u, args.jsTimeout));
    for (const txt of products2) {
      if (!txt) continue;
      for (const p of extractPaths(txt, args.strict)) foundRaw.add(p);
      for (const u of extractJsUrls(txt)) discoveredJs.add(u); // listed, not fetched (depth cap)
    }

    // late-injected DOM: bot sensors/beacons write links after load —
    // re-read the page once (~free) so they aren't missed.
    try {
      const html2 = await page.content();
      for (const p of extractPaths(html2, args.strict)) foundRaw.add(p);
      for (const u of extractJsUrls(html2)) discoveredJs.add(u);
    } catch { /* ignore */ }

    const absolute = new Set();
    for (const rawPath of foundRaw) {
      const abs = resolveToAbsolute(finalUrl, rawPath);
      if (!abs) continue;
      if (args.excludeStatic && isStaticNoise(abs)) continue;
      absolute.add(abs);
    }
    // discovered absolute .js files are endpoints too (scope-filtered downstream)
    for (const u of discoveredJs) absolute.add(u);

    return { ok: true, finalUrl, jsCount: earlyList.length + restList.length + jsList2.length, rawCount: foundRaw.size, urls: absolute };
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    try { await context.close(); } catch { /* ignore */ }
  }
}

async function processTarget(rawInput, browser, args) {
  const stripped = rawInput.trim();
  const isExplicit = /^https?:\/\//i.test(stripped);
  const isProtoRel = stripped.startsWith('//');
  let tried = candidateUrls(rawInput);
  if (isExplicit && !args.fallback) tried = tried.slice(0, 1);
  if (args.noFallback) tried = tried.slice(0, 1);
  // --fallback with an explicit scheme also tries the other scheme
  // (candidateUrls alone returns explicit URLs verbatim)
  if (isExplicit && args.fallback && tried.length === 1) {
    const alt = stripped.replace(/^https?:\/\//i, (m) => (m.toLowerCase() === 'https://' ? 'http://' : 'https://'));
    if (alt !== stripped) tried = [stripped, alt];
  }

  let lastErr = '';
  for (const targetUrl of tried) {
    // fast preflight: dead hosts fail here in ~4s, not after a 30s page timeout.
    // (TCP fail implies page-load fail, so this can't cause false negatives.)
    try {
      const u = new URL(targetUrl);
      const host = u.hostname.replace(/^\[|\]$/g, ''); // bracketed IPv6 literals
      const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443);
      if (!(await tcpReachable(host, port))) {
        lastErr = `TCP ${u.hostname}:${port} unreachable (preflight)`;
        continue;
      }
    } catch {
      lastErr = `bad URL: ${targetUrl}`;
      continue;
    }
    try {
      const r = await processSingleUrl(targetUrl, browser, args);
      return { input: rawInput, ...r };
    } catch (e) {
      lastErr = String(e?.message?.split('\n')[0] || e);
      if (args.verbose) info(`[RETRY] ${short(rawInput)} via ${short(targetUrl)} failed: ${lastErr}`);
      if ((isExplicit || isProtoRel) && !args.fallback) break;
    }
  }
  return { input: rawInput, ok: false, error: lastErr || 'unreachable', urls: new Set() };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  globalThis.__UA = args.userAgent;
  globalThis.__QUIET = args.quiet;

  const targets = await loadTargets(args);

  // output files — always a urls + js pair, never combined:
  //   explicit -o   -> that file (urls) + sibling -js file
  //   single target -> <domain>-urls.txt + <domain>-js.txt
  //   multi target  -> urls1.txt+js1.txt, urls2.txt+js2.txt, … (first free pair,
  //                    never overwrites, so the next scan gets fresh files)
  let outUrls, outJs;
  if (args.outputExplicit && args.output) {
    outUrls = args.output;
    outJs = jsSiblingFilename(args.output);
  } else if (targets.length > 1) {
    ({ urls: outUrls, js: outJs } = nextNumberedPair('.'));
  } else {
    ({ urls: outUrls, js: outJs } = deriveOutputFilenames(targets));
  }

  // never silently overwrite the input target list with results
  if (args.input) {
    try {
      if (fs.statSync(args.input).isFile()
          && (path.resolve(args.input) === path.resolve(outUrls)
              || path.resolve(args.input) === path.resolve(outJs))) {
        console.error(`Refusing to overwrite input file with output (choose another -o)`);
        process.exit(2);
      }
    } catch { /* input is a URL, not a file — no clash possible */ }
  }

  // in-scope sets derived from the entered targets
  const targetHosts = new Set(targets.map(targetHostname).filter(Boolean));
  const targetDomains = new Set([...targetHosts].map(registrableDomain).filter(Boolean));

  const inScope = (absUrl) => {
    if (args.scope === 'all') return true;
    const h = hostnameOfUrl(absUrl);
    if (!h) return false;
    if (args.scope === 'host') return targetHosts.has(h);
    return targetDomains.has(registrableDomain(h)); // 'domain'
  };

  const numWorkers = autoPageWorkers(targets.length);
  info(
    `[*] Targets: ${targets.length} | workers=${numWorkers} js-pool=${JS_POOL_SIZE} rate-limit=per-host+${JITTER_MS}ms-jitter | wait=${args.wait}s | timeout=${args.timeout}s | strict=${args.strict} | scope=${args.scope} | out=${outUrls} + ${outJs}`,
  );

  const urlResults = new Set();
  const jsResults = new Set();
  const droppedHosts = new Set(); // filtered third-party hosts, log summary only
  let browser;
  try {
    browser = await chromium.launch({ headless: args.headless });
  } catch (e) {
    console.error(`Failed to launch Chromium: ${e?.message || e}\nRun: npx playwright install chromium`);
    process.exit(3);
  }

  const t0 = Date.now();
  let interrupted = false;
  const writeList = (file, set) => {
    const dir = path.dirname(file);
    if (dir && dir !== '.' && dir !== '') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [...set].sort().join('\n') + (set.size ? '\n' : ''));
  };
  const saveAndExit = (code) => {
    try {
      writeList(outUrls, urlResults);
      writeList(outJs, jsResults);
    } catch (e) {
      console.error(`Failed to write output: ${e?.message || e}`);
      process.exit(4);
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[DONE] ${targets.length} targets in ${dt}s -> ${urlResults.size} urls (${outUrls}) + ${jsResults.size} js (${outJs})`);
    if (args.verbose && args.scope !== 'all' && droppedHosts.size > 0) {
      info(`[SCOPE] dropped third-party (${[...droppedHosts].sort().slice(0, 15).join(', ')}${droppedHosts.size > 15 ? ', …' : ''}) — ${droppedHosts.size} host(s). Use --scope all to keep.`);
    }
    process.exit(code);
  };
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n[!] Interrupted — saving partial results…');
    saveAndExit(130);
  });

  // worker pool (auto-sized; per-host throttle keeps it IP-ban safe)
  let next = 0;
  info(tableHeader());
  const workers = Array.from(
    { length: Math.min(numWorkers, targets.length) },
    async () => {
      while (true) {
        if (interrupted) return;
        const idx = next++;
        if (idx >= targets.length) return;
        const input = targets[idx];
        const r = await processTarget(input, browser, args);
        if (!r.ok) {
          if (globalThis.__QUIET) console.log(`[FAIL] ${short(input)} (${r.error})`);
          else console.log(failRow(input, r.error));
          continue;
        }
        let added = 0;
        let scoped = 0;
        const before = urlResults.size + jsResults.size;
        for (const u of r.urls) {
          if (!inScope(u)) {
            const h = hostnameOfUrl(u);
            if (h) droppedHosts.add(h);
            continue;
          }
          scoped++;
          if (isJsFile(u)) jsResults.add(u);
          else urlResults.add(u);
        }
        added = (urlResults.size + jsResults.size) - before;
        info(okRow(r.finalUrl, r.jsCount, r.rawCount, scoped, added));
      }
    },
  );
  await Promise.all(workers);

  await browser.close().catch(() => {});
  saveAndExit(0);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
