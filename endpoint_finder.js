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
 * Crawler-grade layers added on top of the bookmarklet logic:
 *   - DOM link graph (a/area/link/form/iframe/frame/source/embed/object,
 *     data-href|data-url|data-src) resolved like hakrawler/colly
 *   - relative + escaped JS paths ("api/x", "./x", "../x", "\/api\/x",
 *     "\u002fapi\u002f") resolved with gospider's FixUrl/DecodeChars rules
 *   - gospider LinkFinder regex for quoted relative/query/file.ext paths
 *   - robots.txt Allow/Disallow/Sitemap + sitemap.xml (index recursion)
 *   - opt-in depth crawl (--depth) of in-scope navigable links
 *   - ".min.js" -> ".js" sibling fetch for unminified paths
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
      const parsed = new URL(collapseDuplicateQuery(m[0]));
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
  // images (always noise for endpoint hunting)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.avif', '.tif', '.tiff', '.heic', '.heif', '.psd', '.ai', '.eps', '.cur',
  // video
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v',
  '.3gp', '.mpg', '.mpeg', '.ogv', '.m3u8', '.mpd', '.ts',
  // audio
  '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.wma', '.opus', '.mid', '.midi',
  // fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.fon', '.pfb', '.sfnt',
  // styles (no endpoints, pure UI noise)
  '.css', '.scss', '.sass', '.less', '.styl',
  // xml / feed noise (sitemaps, rss — not endpoints)
  '.xml', '.xsd', '.xsl', '.xslt', '.dtd', '.rss', '.atom',
  // NOTE: .pdf intentionally KEPT (often sensitive) + PII/sensitive
  // (.json/.csv/.xls/.xlsx/.doc/.docx/.txt/.sql/.db/.log/.bak/.env/.zip)
  // are NEVER added here.
]);

function cleanToken(tok) {
  let s = (tok ?? '').trim().replace(/^['"`,;]+|['"`,;]+$/g, '');
  // JSON/JS escaping leaves trailing backslashes on tokens: "#org\" / "#org\\\"
  s = s.replace(/\\+$/, '');
  if (!s || s.startsWith('#')) return null;
  return collapseDuplicateQuery(s);
}

/** "...x.js?dpl=A?dpl=A" -> "...x.js?dpl=A" (same query pasted twice). */
function collapseDuplicateQuery(s) {
  return s.replace(/(\?[^?#]+)\1$/, '$1');
}

/**
 * Canonical output form:
 *   - fragments dropped (a page#anchor is the same endpoint; #org JSON-LD ids
 *     are not endpoints at all)
 *   - trailing slash after a file extension dropped ("/chunk.js/" -> "/chunk.js")
 *   - "///" collapsed to "/"
 */
function canonicalUrl(absUrl) {
  try {
    const u = new URL(collapseDuplicateQuery(String(absUrl).trim()));
    if (u.hash) u.hash = '';
    u.pathname = u.pathname.replace(/(\/[^/]+\.[a-z0-9]{1,8})\/+$/i, '$1');
    if (u.pathname.length > 1 && /^\/+$/.test(u.pathname)) u.pathname = '/';
    return u.href;
  } catch {
    return String(absUrl).trim();
  }
}

// ---------------------------------------------------------------------------
// Pattern collapse: repeated endpoints that only differ by an id/hash.
//   /user/8f3c...-uuid      -> /user/{uuid}
//   /media/....c8f64370.jpg -> /media/....{hex}.jpg
//   /blog/12345             -> /blog/{num}
// Keeps the first URL per pattern so output stays readable without losing
// the endpoint shape.
// ---------------------------------------------------------------------------
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{8,}\b/gi; // only 8+ hex runs; chunk names with g-z survive
// whole numeric path segments only (/ticket/12345/view), so date slugs like
// /2023-03-30_report.php are not merged together
const NUM_RE = /(?<=\/)\d{4,}(?=[/?#]|$)/g;

function patternKey(absUrl) {
  const mask = (s) => s.replace(UUID_RE, '{uuid}').replace(HEX_RE, '{hex}').replace(NUM_RE, '{num}');
  try {
    const u = new URL(absUrl);
    let p = u.pathname.replace(/\/+$/, '');
    if (!p) p = '/';
    // never mask the host: hex-looking subdomains must stay distinct targets
    return `${u.protocol}//${u.host}${mask(p)}${mask(u.search)}`;
  } catch {
    return mask(absUrl);
  }
}

// ---------------------------------------------------------------------------
// JS noise: tag managers, analytics, consent widgets, a11y checkers, PWA
// boilerplate. These never contain app endpoints and are skipped entirely
// (also means we don't spend requests fetching them).
// ---------------------------------------------------------------------------
const NOISE_JS_NAME_RE = /^(?:gtm|gtag|ga|analytics|fbevents|hotjar|clarity|matomo|piwik|waichecker|cookiebot|onetrust|consent|polyfill|modernizr|service-worker|sw)(?:[.\-_]|$)/i;
const NOISE_JS_PATH_SUBSTR = [
  '/google-analytics/',
  '/google-tag-manager/',
  '/gtag/',
  '/gtm/',
  '/_vercel/insights/',
  '/wp-content/plugins/google-analytics',
];

function isNoiseJs(absUrl) {
  try {
    const p = new URL(absUrl).pathname.toLowerCase();
    if (NOISE_JS_PATH_SUBSTR.some((x) => p.includes(x))) return true;
    const base = p.split('/').pop() || '';
    return NOISE_JS_NAME_RE.test(base);
  } catch {
    return false;
  }
}

/**
 * Resolve a relative token (api/v1/x, ./x, ../x) against the file it was found
 * in. Adds an overlap merge so a token like "static/immutable/chunks/x.js"
 * found inside ".../static/immutable/chunks/abc.js" doesn't produce
 * ".../chunks/static/immutable/chunks/x.js".
 */
function resolveRelative(baseUrl, raw) {
  const s = cleanToken(raw);
  if (!s) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(s) || /^[?#]/.test(s) || s.startsWith('.')) {
    return resolveAny(baseUrl, s);
  }
  const abs = resolveAny(baseUrl, s);
  if (!abs) return null;
  try {
    const b = new URL(baseUrl);
    const segs = b.pathname.split('/').filter(Boolean);
    const dirSegs = b.pathname.endsWith('/') ? segs : segs.slice(0, -1);
    const tokSegs = s.split(/[?#]/)[0].split('/').filter(Boolean);
    const maxK = Math.min(dirSegs.length, tokSegs.length);
    for (let k = maxK; k >= 2; k--) {
      if (dirSegs.slice(dirSegs.length - k).join('/') === tokSegs.slice(0, k).join('/')) {
        const u = new URL(abs);
        u.pathname = `/${[...dirSegs, ...tokSegs.slice(k)].join('/')}`;
        return u.href;
      }
    }
  } catch { /* fall back to standard resolution */ }
  return abs;
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

/**
 * Resolve ANY candidate (bookmarklet path, gospider/hakrawler-style token,
 * DOM attribute) against the URL it was found on.
 * Ported from gospider's FixUrl (url.ResolveReference semantics):
 *   "/x", "./x", "../x", "api/x", "?q=1", "//host/x", "https://host/x"
 * all become absolute. Only http(s) survives.
 */
function resolveAny(basePageUrl, raw) {
  const s = cleanToken(raw);
  if (!s || s.length > 4096) return null;
  const low = s.toLowerCase();
  if (SKIP_SCHEMES.some((p) => low.startsWith(p))) return null;
  if (s.startsWith('#')) return null;
  try {
    if (s.startsWith('//')) {
      const scheme = new URL(basePageUrl).protocol || 'https:';
      const u = new URL(`${scheme}${s}`);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    }
    // reject non-http(s) schemes (ftp:, file:, chrome-extension: …) early
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return null;
    const abs = new URL(s, basePageUrl).href;
    const u = new URL(abs);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.host) return null;
    return abs;
  } catch {
    return null;
  }
}

/**
 * Decode the escapes that hide paths inside JS/JSON bodies.
 * Port of gospider's DecodeChars (targeted: no URL-unescape pass, which would
 * turn "+" into spaces and corrupt query strings):
 *   "\/api\/v1" -> "/api/v1"
 *   "\u002fapi\u002f" -> "/api/"
 *   "\x2fapi\x2f" -> "/api/"
 */
function decodeEscapes(text) {
  if (!text || !text.includes('\\')) return text;
  return text
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003[dD]/g, '=')
    .replace(/\\u003[fF]/g, '?')
    .replace(/\\u0023/g, '#')
    .replace(/\\x2[fF]/g, '/')
    .replace(/\\\//g, '/');
}

// MIME tokens the richer extractor would otherwise mistake for paths
// ("text/html", "application/json", … are quoted constants, not endpoints).
const MIME_TOKEN_RE = /^(?:text|application|image|audio|video|font|multipart|message|model|example)\/[a-z0-9.+-]+(?:\s*;.*)?$/i;

/**
 * gospider's LinkFinder regex, ported to JS. Catches what the bookmarklet
 * regex cannot: schemeless "//host/x", relative "./x", "../x", "api/v1/x",
 * query-bearing paths and file.ext endpoints inside quoted JS/JSON strings.
 */
// biome-ignore lint: intentional port of gospider/core/linkfinder.go
const LINKFINDER_RE = /(?:"|')(((?:[a-zA-Z]{1,10}:\/\/|\/\/)[^"'/]{1,}\.[a-zA-Z]{2,}[^"']{0,})|((?:\/|\.\.\/|\.\/)[^"'><,;| *()%$^/\\[\]]{1,}[^"'><,;|()\s]{1,})|([a-zA-Z0-9_\-/]{1,}\/[a-zA-Z0-9_\-/]{1,}\.(?:[a-zA-Z]{1,4}|action)(?:[?#][^"'\s]{0,}|))|([a-zA-Z0-9_\-/]{1,}\/[a-zA-Z0-9_\-/]{3,}(?:[?#][^"'\s]{0,}|))|([a-zA-Z0-9_\-]{1,}\.(?:php|asp|aspx|jsp|json|action|html|js|txt|xml)(?:[?#][^"'\s]{0,}|)))(?:"|')/g;

function extractLinkfinder(text) {
  const out = new Set();
  if (!text || text.length < 4) return out;
  const sample = text.length > 4_000_000 ? text.slice(0, 4_000_000) : text;
  LINKFINDER_RE.lastIndex = 0;
  let m;
  while ((m = LINKFINDER_RE.exec(sample)) !== null) {
    const tok = cleanToken(m[1]);
    if (tok && tok.length >= 3 && tok.length <= 2048 && !/\s/.test(tok) && !MIME_TOKEN_RE.test(tok)) {
      const hasScheme = /^(?:https?:)?\/\//i.test(tok);
      const startsPath = /^(?:\/|\.{1,2}\/)/.test(tok);
      const seg = tok.split(/[?#]/)[0];
      const last = seg.split('/').pop() || '';
      const hasExt = /\.[a-z0-9]{1,5}$/i.test(last);
      const slashes = (tok.match(/\//g) || []).length;
      // git-token noise guard: bare "and/or"/"n/a" is not an endpoint
      if (hasScheme || startsPath || hasExt || slashes >= 2) out.add(tok);
    }
    if (m[0].length === 0) LINKFINDER_RE.lastIndex++;
  }
  return out;
}

function isStaticNoise(absUrl) {
  try {
    const u = new URL(absUrl);
    // trailing slashes are extraction artifacts on files: "/app.js/" -> "/app.js"
    const p = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    for (const ext of STATIC_EXTS) {
      if (p.endsWith(ext)) return true;
    }
    const full = `${u.pathname}${u.search}`;
    // srcset / responsive-image tokens: "img.jpg 383w, /img2.jpg 766w"
    // (encoded spaces or literal commas joining multiple candidates)
    if (/%20|%09/i.test(full)) return true;
    let decoded = full;
    try { decoded = decodeURIComponent(full); } catch { /* malformed % */ }
    if (/\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|css)(?:[^a-z0-9]|$)/i.test(decoded)) return true;
    // image optimizer endpoints (/ _next/image?url=...webp) and thumbnails
    if (/\/wthumbnails\//i.test(p)) return true;
    // punctuation-only paths ("/&", "///") carry no endpoint
    if (p !== '/' && !/[a-z0-9]/i.test(p) && !u.search) return true;
  } catch { /* ignore */ }
  return false;
}

/** Normal logs (suppressed with -q/--quiet). FAIL + DONE always print. */
function info(...a) {
  if (!globalThis.__QUIET) console.log(...a);
}

/**
 * Aligned label/value block for the run banner and final summary.
 * One setting per line instead of a single wall of "a | b | c".
 * Multi-line values are indented under the same label column.
 */
function labelBlock(rows, indent = 2) {
  const w = Math.max(...rows.map(([k]) => String(k).length));
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const vals = String(v).split('\n');
    lines.push(`${pad}${String(k).padEnd(w)}  ${vals[0]}`);
    for (const more of vals.slice(1)) lines.push(`${pad}${' '.repeat(w)}  ${more}`);
  }
  return lines.join('\n');
}

/** "1 host" / "3 hosts" without a dependency. */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
    if (s.startsWith('[')) {
      // bracketed IPv6 literal, optional port/path: [::1]:8080/x
      const m = s.match(/^\[([^\]]+)\]/);
      if (m) return m[1].toLowerCase();
      return '';
    }
    return s.split('/')[0].split(':')[0].toLowerCase();
  } catch {
    return '';
  }
}

function sanitizeFilename(s) {
  // never let a bad host/target produce hidden or empty output names
  // (e.g. host "." -> "target-urls.txt", not ".-urls.txt")
  const out = (s || '').toLowerCase().replace(/[^a-z0-9.\-]+/g, '_').replace(/^[.\-]+/, '');
  return out || 'target';
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

/** Auto names never overwrite: <base>-urls.txt taken -> <base>-urls2.txt, -urls3.txt … (same for -js). */
function firstFreePair(urls, js) {
  if (!fs.existsSync(urls) && !fs.existsSync(js)) return { urls, js };
  const dot = urls.lastIndexOf('.');
  const base = dot > 0 ? urls.slice(0, dot) : urls;
  const ext = dot > 0 ? urls.slice(dot) : '.txt';
  const jdot = js.lastIndexOf('.');
  const jbase = jdot > 0 ? js.slice(0, jdot) : js;
  const jext = jdot > 0 ? js.slice(jdot) : '.txt';
  let n = 2;
  while (true) {
    const u = `${base}${n}${ext}`;
    const j = `${jbase}${n}${jext}`;
    if (!fs.existsSync(u) && !fs.existsSync(j)) return { urls: u, js: j };
    n++;
    if (n > 9999) return { urls: u, js: j };
  }
}

/** Explicit -o names the urls file; js goes to a sibling (foo.txt -> foo-js.txt). */
function jsSiblingFilename(outFile) {
  const dot = outFile.lastIndexOf('.');
  if (dot > 0) return `${outFile.slice(0, dot)}-js${outFile.slice(dot)}`;
  return `${outFile}-js.txt`;
}

/** Unpack root: endpoint-<domain|file>-output holding one subdir per unpacked .map.
 *  Never overwrites: taken -> -output2, -output3 … */
function deriveUnpackDir(outUrls, targets, outputExplicit) {
  const dir = path.dirname(outUrls);
  const baseDir = (!dir || dir === '' || dir === '.') ? '.' : dir;
  let name;
  if (outputExplicit) {
    const b = (path.basename(outUrls).replace(/\.[^.]+$/, '') || 'output');
    name = `endpoint-${sanitizeFilename(b)}-output`;
  } else if (targets.length > 1) {
    const m = path.basename(outUrls).match(/urls(\d+)\.txt/i);
    name = m ? `endpoint-scan${m[1]}-output` : 'endpoint-multi-output';
  } else {
    const hosts = [...new Set(targets.map(targetHostname).filter(Boolean))];
    const base = hosts.length === 1 ? sanitizeFilename(hosts[0]) : 'endpoints';
    name = `endpoint-${base}-output`;
  }
  let full = path.join(baseDir, name);
  if (!fs.existsSync(full)) return full;
  let n = 2;
  while (fs.existsSync(`${full}${n}`)) n++;
  return `${full}${n}`;
}

/** True if the URL points to a JS file (path ends .js, query/trailing slash ignored). */
function isJsFile(absUrl) {
  try {
    const p = new URL(absUrl).pathname.toLowerCase().replace(/\/+$/, '');
    return p.endsWith('.js') || p.endsWith('.mjs');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sourcemap auto-unpack (JS-only port of unwebpack_sourcemap.py)
// Tries <file.js>.map for every in-scope .js, unpacks sourcesContent.
// ---------------------------------------------------------------------------
const MAX_SOURCEMAP_BYTES = 8_000_000;

function mapCandidatesForJs(jsUrl, jsBody) {
  const out = [];
  const push = (u) => { if (u && !out.includes(u)) out.push(u); };
  // 1. sourceMappingURL comment (same as unwebpack _detect: last line)
  try {
    if (jsBody) {
      const lines = jsBody.trimEnd().split('\n');
      const last = (lines[lines.length - 1] || '').slice(-2000);
      const m = last.match(/\/\/#\s*sourceMappingURL=(.*)\s*$/);
      if (m) {
        const asset = (m[1] || '').trim();
        if (asset && !asset.startsWith('data:')) {
          try { push(new URL(asset, jsUrl).href); } catch { /* bad */ }
        }
      }
    }
  } catch { /* ignore */ }
  // 2. conventional <file.js>.map (query/hash stripped)
  try {
    const u = new URL(jsUrl);
    u.hash = '';
    u.search = '';
    if (u.pathname.toLowerCase().endsWith('.js')) {
      u.pathname = `${u.pathname}.map`;
      push(u.href);
    }
  } catch { /* ignore */ }
  return out.slice(0, 2);
}

function sanitizeFsName(name, st) {
  let s = (name ?? '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  s = s.split(path.sep).join('_').split('/').join('_').split('\\').join('_');
  let out = '';
  for (const ch of s) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || '-_.() '.includes(ch)) out += ch;
  }
  out = out.trim();
  if (!/[A-Za-z0-9]/.test(out)) out = `empty_${st.n++}`;
  if (out === '.' || out === '..') out = `empty_${st.n++}`;
  if (out.length > 120) out = out.slice(0, 120);
  return out;
}

function isUnderRoot(root, child) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function unpackSourcemapText(mapText, destRoot) {
  let obj;
  try { obj = JSON.parse(mapText); } catch { return 0; }
  if (!obj || !Array.isArray(obj.sources) || !Array.isArray(obj.sourcesContent)) return 0;
  const n = Math.min(obj.sources.length, obj.sourcesContent.length);
  if (n === 0) return 0;
  const root = path.resolve(destRoot);
  fs.mkdirSync(root, { recursive: true });
  const st = { n: 0 };
  let wrote = 0;
  for (let i = 0; i < n; i++) {
    const src = obj.sources[i];
    const content = obj.sourcesContent[i];
    if (typeof src !== 'string' || typeof content !== 'string') continue;
    let p = src.replace('webpack:///', '');
    if (p.split(' ')[0] === 'external') continue; // same as unwebpack
    let dir = '';
    let file = '';
    const slash = p.lastIndexOf('/');
    if (slash >= 0) { dir = p.slice(0, slash); file = p.slice(slash + 1); }
    else { dir = ''; file = p; }
    if (dir.startsWith('./')) dir = dir.slice(2);
    if (dir.startsWith('../')) dir = 'parent_dir/' + dir.slice(3);
    if (dir.startsWith('.')) dir = '';
    if (!file) file = `empty_${st.n++}`;
    const dirParts = dir.split('/').filter(Boolean).map((c) => sanitizeFsName(c, st));
    const safeFile = sanitizeFsName(file, st);
    const dest = path.resolve(root, ...dirParts, safeFile);
    if (!isUnderRoot(root, dest)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf8');
      wrote++;
    } catch { /* skip */ }
  }
  return wrote;
}

function subdirForJs(jsUrl, taken) {
  let base = 'js';
  try {
    const u = new URL(jsUrl);
    const host = sanitizeFilename(u.hostname) || 'host';
    const p = u.pathname.replace(/^\//, '').replace(/\.js$/i, '') || 'root';
    const flat = (sanitizeFilename(p).replace(/\./g, '_') || 'root').slice(0, 80);
    base = `${host}__${flat}`;
  } catch {
    base = (sanitizeFilename(jsUrl) || 'js').slice(0, 80);
  }
  if (base.length > 100) base = base.slice(0, 100);
  let name = base;
  let k = 2;
  while (taken.has(name)) name = `${base}-${k++}`;
  taken.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// Secrets scan (JS-only, tight high-precision regexes — no generic noise)
// Only fixed-format keys: long distinctive prefixes + exact lengths.
// Generic `api_key`/`password`/UUID patterns are DELIBERATELY excluded.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  ['aws_access_key', /((?:AKIA|ASIA)[0-9A-Z]{16})/g],
  ['aws_mws_token', /(amzn\.mws\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g],
  ['google_api_key', /(AIza[0-9A-Za-z_-]{35})/g],
  ['google_oauth', /(ya29\.[0-9A-Za-z_-]{20,})/g],
  ['firebase_fcm', /(AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140})/g],
  ['github_token', /((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36})/g],
  ['slack_token', /(xox[baprs]-[0-9A-Za-z-]{10,48})/g],
  ['slack_webhook', /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8}\/B[A-Z0-9]{8}\/[A-Za-z0-9]{24})/g],
  ['stripe_live', /(sk_live_[0-9a-zA-Z]{24})/g],
  ['stripe_restricted', /(rk_live_[0-9a-zA-Z]{24})/g],
  ['stripe_test', /(sk_test_[0-9a-zA-Z]{24})/g],
  ['square_secret', /(sq0csp-[0-9A-Za-z_-]{43})/g],
  ['square_token', /(sqOatp-[0-9A-Za-z_-]{22,})/g],
  ['square_access', /(EAAA[a-zA-Z0-9]{60})/g],
  ['braintree_token', /(access_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32})/g],
  ['facebook_token', /(EAACEdEose0cBA[0-9A-Za-z]{20,})/g],
  ['twilio_key', /(SK[0-9a-fA-F]{32})/g],
  ['twilio_sid', /((?:AC|AP)[0-9a-fA-F]{32})/g],
  ['mailgun_key', /(key-[0-9a-zA-Z]{32})/g],
  ['private_key', /(-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----)/g],
  ['jwt', /(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g],
];

/** Reject placeholder-looking matches: 8+ identical chars in a row (XXXX…, 0000…). */
function isPlaceholder(m) {
  return /([A-Za-z0-9])\1{7,}/.test(m);
}

/** Scan text with tight patterns. Returns [{name, matched}] deduped, placeholders dropped. */
function scanSecrets(text) {
  const out = [];
  const seen = new Set();
  if (!text || typeof text !== 'string') return out;
  const sample = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  for (const [name, rx] of SECRET_PATTERNS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(sample)) !== null) {
      const hit = m[1] || m[0];
      if (!hit || hit.length > 4000) continue;
      if (isPlaceholder(hit)) continue;
      const key = name + '\0' + hit;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, matched: hit });
      if (out.length > 200) return out;
      if (m[0].length === 0) rx.lastIndex++;
    }
  }
  return out;
}

/** Secrets sibling: <base>-urls.txt -> <base>-secrets.txt (first free, never overwrites). */
function secretsSiblingFilename(outUrls) {
  const dir = path.dirname(outUrls);
  const baseDir = (!dir || dir === '' || dir === '.') ? '.' : dir;
  const file = path.basename(outUrls);
  let name;
  if (/urls/i.test(file)) name = file.replace(/urls/i, 'secrets');
  else {
    const dot = file.lastIndexOf('.');
    name = dot > 0 ? `${file.slice(0, dot)}-secrets${file.slice(dot)}` : `${file}-secrets.txt`;
  }
  let full = path.join(baseDir, name);
  if (!fs.existsSync(full)) return full;
  const dot = name.lastIndexOf('.');
  const b = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '.txt';
  let n = 2;
  while (fs.existsSync(path.join(baseDir, `${b}${n}${ext}`))) n++;
  return path.join(baseDir, `${b}${n}${ext}`);
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { if (fs.statSync(p).size > 2_000_000) continue; } catch { continue; }
        out.push(p);
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Auto-tuned parallelism + per-host rate limiting (no user flags).
// Pages run on parallel workers; requests to the SAME host are spaced out
// with jitter so scans stay fast across hosts without tripping IP bans.
// ---------------------------------------------------------------------------
const PAGE_WORKERS_MAX = 10;  // parallel pages (auto: fewer for small lists)
const JS_POOL_SIZE = 12;      // parallel JS fetches (global, per-host throttled below)
const JS_DISCOVERY_EXTRA = 20; // extra fetches for round-2 discovered .js files
let PAGE_GAP_MS = 800;      // min gap between page loads on the SAME host (polite, was 300)
let JS_GAP_MS = 400;        // min gap between JS fetches on the SAME host (polite, was 100)
let JITTER_MS = 400;        // random extra delay (human-like spacing, was 120)
const PREFLIGHT_MS = 4000;    // TCP connect check: dead hosts fail in ~4s, not 30s
const MAP_POOL_SIZE = 2;      // sourcemap fetches: near-sequential per run (was JS_POOL_SIZE=12 -> ban)
let MAP_GAP_MS = 1500;      // min gap between .map fetches on the SAME host
const MAP_RETRIES = 3;        // retry hung/429/503 maps with backoff before giving up

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

/** Bounded parallel map (fixed pool, preserves order).
 *  Per-item failures are isolated (never reject the pool) so one bad
 *  input can't kill a 100-target run. */
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = 0;
  const n = Math.min(Math.max(1, size), items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        failed++;
        out[idx] = undefined;
      }
    }
  }));
  if (failed > 0 && globalThis.__VERBOSE) info(`[WARN] ${failed} pooled task(s) failed (isolated, run continues)`);
  return out;
}

const pageThrottle = new HostThrottle();
const jsThrottle = new HostThrottle();
const mapThrottle = new HostThrottle();
const jsCache = new Map(); // url -> Promise<string|null> (shared across targets)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchTextOnce(url, timeoutSec, maxBytes = 8_000_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': globalThis.__UA },
    });
    if (res.status === 429 || res.status === 503) {
      const ra = res.headers.get('retry-after');
      const waitSec = ra ? (parseInt(ra, 10) || 5) : 5;
      try { await res.text().catch(() => {}); } catch { /* drain */ }
      return { retry: true, waitMs: Math.min(waitSec * 1000, 30000), status: res.status };
    }
    if (res.status >= 400) return null;
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (/image\/|video\/|audio\/|font|\boctet-stream\b/.test(ctype)) {
      const low = url.toLowerCase().split('?')[0].split('#')[0];
      if (!low.endsWith('.js') && !low.endsWith('.map')) return null;
    }
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return { retry: true, waitMs: 1500, status: 0 }; // timeout/hang -> retryable
  } finally {
    clearTimeout(t);
  }
}

/** Fetch with backoff: 429/503/timeout retried, 404/other-4xx fail fast (no ban hammering). */
async function fetchTextRetry(url, timeoutSec, maxBytes = 8_000_000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const out = await fetchTextOnce(url, timeoutSec, maxBytes);
    if (out !== null && typeof out === 'object' && out.retry) {
      if (attempt === retries) return null;
      const backoff = out.waitMs + Math.random() * JITTER_MS + attempt * 1500;
      if (globalThis.__VERBOSE) console.log(`[RETRY] ${url.slice(0, 80)} (${out.status || 'timeout'}) waiting ${(backoff / 1000).toFixed(1)}s (${attempt + 1}/${retries})`);
      await sleep(backoff);
      continue;
    }
    return out;
  }
  return null;
}

/** Throttled + globally cached JS fetch (same CDN file fetched once per run).
 *  Failures are NOT cached, so another target sharing the file retries it.
 *  Cache is LRU-capped so 100-target runs can't balloon memory. */
const MAX_CACHE_ENTRIES = 400;
function fetchText(url, timeoutSec, maxBytes = 8_000_000) {
  let p = jsCache.get(url);
  if (!p) {
    p = (async () => {
      await jsThrottle.acquire(hostnameOfUrl(url), JS_GAP_MS);
      const text = await fetchTextRetry(url, timeoutSec, maxBytes, 1);
      if (text === null) jsCache.delete(url);
      return text;
    })();
    jsCache.set(url, p);
    if (jsCache.size > MAX_CACHE_ENTRIES) {
      const oldest = jsCache.keys().next().value;
      jsCache.delete(oldest);
    }
  }
  return p;
}

/** Polite .map fetch: own throttle (1.5s/host), own pool, retries with backoff. NOT cached. */
async function fetchMapText(url, timeoutSec, maxBytes = MAX_SOURCEMAP_BYTES) {
  await mapThrottle.acquire(hostnameOfUrl(url), MAP_GAP_MS);
  const text = await fetchTextRetry(url, timeoutSec, maxBytes, MAP_RETRIES);
  await sleep(300 + Math.random() * 400); // breathe after each map so WAF never sees a burst
  return text;
}

// ---------------------------------------------------------------------------
// robots.txt + sitemap.xml harvesting (logic ported from gospider:
// core/robots.go and core/sitemap.go). Cheap same-origin discovery that
// browsers/regex-only scanners never see.
// ---------------------------------------------------------------------------
const siteThrottle = new HostThrottle();

async function fetchSiteFile(url, timeoutSec, maxBytes = 4_000_000) {
  await siteThrottle.acquire(hostnameOfUrl(url), PAGE_GAP_MS);
  return fetchTextRetry(url, timeoutSec, maxBytes, 1);
}

/** robots.txt -> Allow/Disallow paths + Sitemap: declarations. */
async function fetchRobots(origin, timeoutSec) {
  const urls = new Set();
  const sitemaps = [];
  let text = null;
  try { text = await fetchSiteFile(`${origin}/robots.txt`, timeoutSec, 1_000_000); } catch { text = null; }
  if (!text) return { urls, sitemaps };
  for (const line of text.split(/\r?\n/)) {
    const sm = line.match(/^\s*Sitemap\s*:\s*(\S+)/i);
    if (sm) {
      if (/^https?:\/\//i.test(sm[1])) sitemaps.push(sm[1]);
      continue;
    }
    const m = line.match(/^\s*(Allow|Disallow)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    let p = m[2].trim();
    if (!p) continue;
    if (p === '/') { urls.add(`${origin}/`); continue; }
    if (p.includes('*') || p.includes('$')) p = p.split(/[*$]/)[0]; // wildcard rule -> literal prefix
    if (!p || p === '/') continue;
    if (p.startsWith('/')) urls.add(`${origin}${p}`);
    else if (/^https?:\/\//i.test(p)) urls.add(p);
  }
  return { urls, sitemaps };
}

const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap1.xml', '/sitemap.txt'];

/** sitemap.xml (+ indexes, + robots-declared sitemaps) -> page URLs. */
async function fetchSitemap(origin, timeoutSec, seeds = [], maxFetches = 6, maxUrls = 2000) {
  const out = new Set();
  const queue = [...seeds, ...SITEMAP_PATHS.map((p) => `${origin}${p}`)];
  const seen = new Set();
  let fetches = 0;
  while (queue.length > 0 && fetches < maxFetches && out.size < maxUrls) {
    const u = queue.shift();
    if (!u || seen.has(u) || /\.gz(?:$|\?)/i.test(u)) continue; // gz needs zlib; skip politely
    seen.add(u);
    fetches++;
    let text = null;
    try { text = await fetchSiteFile(u, timeoutSec, 4_000_000); } catch { text = null; }
    if (!text) continue;
    if (!/<loc[\s>]/i.test(text)) {
      // plain-text sitemap: one absolute URL per line
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (/^https?:\/\/\S+$/i.test(s)) out.add(s);
        if (out.size >= maxUrls) break;
      }
      continue;
    }
    for (const m of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const loc = m[1].replace(/&amp;/g, '&').trim();
      if (!/^https?:\/\//i.test(loc)) continue;
      if (/sitemap/i.test(loc) && /\.xml(?:$|\?)/i.test(loc)) {
        if (queue.length < 50) queue.push(loc); // sitemap index -> recurse (capped)
        continue;
      }
      out.add(loc);
      if (out.size >= maxUrls) break;
    }
  }
  return out;
}

function originOf(raw) {
  try {
    const first = candidateUrls(raw)[0];
    return first ? new URL(first).origin : null;
  } catch {
    return null;
  }
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
    depth: 1,        // 1 = seed page only (default); 2+ = follow in-scope links
    maxPages: 25,    // hard cap on extra pages crawled per target
    robots: true,    // robots.txt Allow/Disallow/Sitemap harvesting
    sitemap: true,   // sitemap.xml harvesting (incl. sitemap indexes)
    collapse: true,  // collapse uuid/hex/numeric-id URL patterns to one entry
    jsFilter: true,  // drop gtm/analytics/a11y/PWA-boilerplate JS entirely
    headless: true,
    noFallback: false,
    fallback: false,
    strict: false,
    noInline: false,
    excludeStatic: false,
    sourcemap: true,
    maxMaps: 25,
    secrets: true,
    fast: false,
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
      case '--depth': {
        const n = parseInt(need(t), 10);
        args.depth = Number.isNaN(n) ? 1 : Math.min(5, Math.max(0, n)); // 0 = unlimited (bounded by --max-pages)
        i++; break;
      }
      case '--max-pages': args.maxPages = Math.min(500, Math.max(1, parseInt(need(t), 10) || 25)); i++; break;
      case '--no-robots': args.robots = false; i++; break;
      case '--no-sitemap': args.sitemap = false; i++; break;
      case '--no-collapse': args.collapse = false; i++; break;
      case '--no-js-filter': args.jsFilter = false; i++; break;
      case '--headless': args.headless = true; i++; break;
      case '--no-headless': args.headless = false; i++; break;
      case '--no-fallback': args.noFallback = true; i++; break;
      case '--fallback': args.fallback = true; i++; break;
      case '--strict': args.strict = true; i++; break;
      case '--no-inline': args.noInline = true; i++; break;
      case '--exclude-static': args.excludeStatic = true; i++; break;
      case '--no-sourcemap': args.sourcemap = false; i++; break;
      case '--max-maps': args.maxMaps = Math.min(500, Math.max(0, parseInt(need(t), 10) || 0)); i++; break;
      case '--no-secrets': args.secrets = false; i++; break;
      case '--fast': args.fast = true; i++; break;
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
                           Single target default: <domain>-urls.txt + <domain>-js.txt
                           (taken -> -urls2/-js2, -urls3/-js3 … never overwrites);
                           multi-target default: urls1.txt+js1.txt, urls2.txt+js2.txt…
                           (first free pair, never overwrites)
  --timeout <s>            per-page goto timeout (default: 30)
  --js-timeout <s>         per-JS fetch timeout (default: 15)
  --wait <s>               fixed wait after load, mirrors bookmarklet setTimeout(3000) (default: 3)
  --max-scripts <n>        max JS files per page (default: 100)
  --depth <n>              crawl depth: 1 = seed pages only (default),
                           2+ = follow in-scope a/area/iframe/frame links,
                           0 = unlimited (hard-capped by --max-pages)
  --max-pages <n>          max extra pages crawled per target with --depth
                           (default: 25, max 500)
  --no-robots              skip robots.txt Allow/Disallow/Sitemap harvesting
  --no-sitemap             skip sitemap.xml harvesting (incl. sitemap indexes)
  --no-collapse            keep every uuid/hex/numeric-id URL variant
                           (default: collapse to one per pattern)
  --no-js-filter           keep noise JS (gtm, analytics, consent, waiChecker, sw)
                           (default: dropped before fetching)
  --headless / --no-headless
  --no-fallback            bare hosts: try https only (default tries https then http)
  --fallback               explicit https URL failing also tries http variant
  --strict                 exact bookmarklet quote handling (misses single-quoted paths)
  --no-inline              skip inline <script> bodies
  --exclude-static         (always on, kept for compat) multimedia/style/font/xml filtered, pdf+PII kept
  --no-sourcemap           disable .js.map auto-unpack (default: enabled, JS-only)
  --max-maps <n>           max .map files to try per run (default: 25, max 500, 0=unlimited->capped 500)
  --no-secrets             disable tight secrets scan (default: enabled, JS-only)
  --fast                   old aggressive timing (12-wide maps, 100ms gaps). Default is polite
                         (2-wide maps, 1.5s/host gap, 429/503 backoff) to avoid WAF bans
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
  const scriptSrcs = new Set();
  const discoveredJs = new Set(); // absolute .js URLs found in text (2nd bookmarklet)
  const inlineSecrets = []; // tight secret hits inside inline <script> bodies (fetched JS is scanned later)
  const networkJs = new Set();
  const dropped = { media: 0, js: 0 }; // filter counters for the run summary
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
    // addScript drops noise JS (gtm/analytics/consent/a11y) before it is
    // queued, so we never spend a request on files with no endpoints.
    const addScript = (u) => {
      if (!u) return;
      let c;
      try { c = canonicalUrl(new URL(u, finalUrl).href); } catch { return; }
      if (scriptSrcs.has(c)) return;
      if (isStaticNoise(c)) { dropped.media++; return; }
      if (args.jsFilter && isNoiseJs(c)) { dropped.js++; return; }
      scriptSrcs.add(c);
      discoveredJs.add(c);
    };
    for (const u of await collectTagSrcs()) addScript(u);
    for (const u of networkJs) addScript(u);
    const earlyList = sameFirst(scriptSrcs).slice(0, args.maxScripts);
    const fetched = new Set(earlyList);
    const bgProducts = mapPool(earlyList, JS_POOL_SIZE, async (u) => ({ u, text: await fetchText(u, args.jsTimeout) }));

    try {
      await page.waitForLoadState('networkidle', { timeout: 2500 });
    } catch { /* slow SPA / beacon-heavy pages — fixed wait below still applies */ }
    if (args.wait > 0) await new Promise((r) => setTimeout(r, args.wait * 1000));
    try {
      const cur = page.url() || finalUrl;
      if (cur && !cur.startsWith('about:')) finalUrl = cur;
    } catch { /* keep finalUrl */ }

    // LATE pass: scripts injected during load + full page content
    for (const u of await collectTagSrcs()) addScript(u);
    for (const u of networkJs) addScript(u);

    // ---- extraction core (base-aware: relative paths resolve against the
    // document/script they were found in — gospider's FixUrl semantics) ----
    const absolute = new Set();
    const crawlLinks = new Set();
    const rawSeen = new Set();

    const addCand = (raw, base) => {
      const s = cleanToken(raw);
      if (!s) return;
      // absolute paths ("/x", "//host/x") are browser-resolved against the
      // page (bookmarklet semantics); relative tokens are resolved against
      // the file they appear in (gospider semantics, e.g. "./chunks/x.js"),
      // with an overlap merge so ".../chunks/x.js" tokens don't double paths.
      const absPath = s.startsWith('/');
      const abs = absPath ? resolveAny(finalUrl, s) : resolveRelative(base || finalUrl, s);
      if (!abs) return;
      const c = canonicalUrl(abs);
      if (absolute.has(c)) return;
      if (isStaticNoise(c)) { dropped.media++; return; }
      if (isJsFile(c)) {
        if (args.jsFilter && isNoiseJs(c)) { dropped.js++; return; }
        scriptSrcs.add(c);
        discoveredJs.add(c);
      }
      absolute.add(c);
    };

    const harvest = (text, base) => {
      if (!text) return;
      // 1. bookmarklet regex (exact original mechanism)
      for (const p of extractPaths(text, args.strict)) {
        if (!p) continue;
        rawSeen.add(p);
        addCand(p, base);
      }
      // 2. escaped paths: "\/api\/x", "\u002fapi\u002f" (gospider DecodeChars)
      const dec = decodeEscapes(text);
      if (dec !== text) {
        for (const p of extractPaths(dec, args.strict)) {
          if (!p) continue;
          rawSeen.add(p);
          addCand(p, base);
        }
      }
      // 3. gospider LinkFinder: relative ./ ../ api/v1/x, query paths, file.ext
      for (const t of extractLinkfinder(text)) {
        rawSeen.add(t);
        addCand(t, base); // NOTE: endpoints only — never crawl seeds
      }
      // 4. absolute .js URLs (2nd bookmarklet)
      for (const u of extractJsUrls(text)) addScript(u);
    };

    // DOM link graph == hakrawler's a[href]/script[src]/form[action] handlers,
    // plus iframes/frames/preloads/uploads/embeds the regex can't see.
    // `follow` marks navigable documents (a/area/iframe/frame) for --depth;
    // form actions, manifests and data-* URLs are endpoints, not crawl seeds.
    const collectDomLinks = async () => {
      const out = [];
      try {
        const vals = await page.$$eval(
          'a[href], area[href], link[href], form[action], iframe[src], frame[src], source[src], video[src], audio[src], embed[src], object[data], input[formaction], button[formaction], [data-href], [data-url], [data-src]',
          (els) => els.slice(0, 5000).map((e) => {
            const follow = /^(A|AREA|IFRAME|FRAME)$/.test(e.tagName);
            for (const a of ['href', 'src', 'action', 'data', 'formaction', 'data-href', 'data-url', 'data-src']) {
              const v = e.getAttribute(a);
              if (v && v.trim()) return { v: v.trim(), follow };
            }
            return null;
          }),
        );
        for (const item of vals || []) {
          if (!item || !item.v || item.v.startsWith('#')) continue;
          if (shouldSkipScriptSrc(item.v)) continue;
          out.push(item);
        }
      } catch { /* no DOM yet */ }
      return out;
    };

    const ingestDomLinks = async () => {
      for (const { v, follow } of await collectDomLinks()) {
        const abs = resolveAny(finalUrl, v);
        if (!abs) continue;
        const c = canonicalUrl(abs);
        if (absolute.has(c)) continue;
        if (isStaticNoise(c)) { dropped.media++; continue; }
        if (isJsFile(c)) {
          if (args.jsFilter && isNoiseJs(c)) { dropped.js++; continue; }
          scriptSrcs.add(c);
          discoveredJs.add(c);
        } else if (follow) {
          crawlLinks.add(c);
        }
        absolute.add(c);
      }
    };
    await ingestDomLinks();

    // page HTML == document.documentElement.outerHTML
    try {
      harvest(await page.content(), finalUrl);
    } catch { /* ignore */ }

    if (!args.noInline) {
      try {
        const inlines = await page.$$eval('script:not([src])', (els) =>
          els.map((e) => e.textContent || ''),
        );
        for (const body of inlines || []) {
          if (!body) continue;
          harvest(body, finalUrl);
          // inline bodies are never fetched, so scan them here (small, sync, capped)
          if (args.secrets && body.length <= 500_000) {
            let hits;
            try { hits = scanSecrets(body); } catch { hits = []; }
            if (hits.length > 0) inlineSecrets.push({ header: `${finalUrl} (inline)`, hits });
            if (inlineSecrets.length >= 50) break;
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
    const restProducts = mapPool(restList, JS_POOL_SIZE, async (u) => ({ u, text: await fetchText(u, args.jsTimeout) }));

    const allBodies = [...(await bgProducts), ...(await restProducts)];
    for (const p of allBodies) {
      if (!p || !p.text) continue;
      harvest(p.text, p.u); // relative paths resolve against the JS file, not the page
    }

    // round 2: absolute .js URLs discovered inside round-1 bodies —
    // files the page references but never loads (2nd bookmarklet's trick)
    const round2 = [];
    for (const p of allBodies) {
      if (!p || !p.text) continue;
      for (const u0 of extractJsUrls(p.text)) {
        const u = canonicalUrl(u0);
        if (isStaticNoise(u)) { dropped.media++; continue; }
        if (args.jsFilter && isNoiseJs(u)) { dropped.js++; continue; }
        discoveredJs.add(u);
        if (!fetched.has(u)) {
          fetched.add(u);
          round2.push(u);
        }
      }
      // linkfinder also surfaces .js files in relative/escaped form
      for (const t of extractLinkfinder(p.text)) {
        const abs = resolveRelative(p.u, t);
        if (!abs) continue;
        const c = canonicalUrl(abs);
        if (!isJsFile(c) || fetched.has(c)) continue;
        if (isStaticNoise(c)) { dropped.media++; continue; }
        if (args.jsFilter && isNoiseJs(c)) { dropped.js++; continue; }
        fetched.add(c);
        round2.push(c);
      }
    }
    const jsList2 = sameFirst(round2).slice(0, JS_DISCOVERY_EXTRA);
    const products2 = await mapPool(jsList2, JS_POOL_SIZE, async (u) => ({ u, text: await fetchText(u, args.jsTimeout) }));
    for (const p of products2) {
      if (!p || !p.text) continue;
      harvest(p.text, p.u);
    }

    // gospider trick: ".min.js" usually ships next to a readable ".js";
    // fetch the unminified sibling for paths the minified build hides.
    const minVariants = [];
    for (const u of [...fetched]) {
      if (!/\.min\.js(?:[?#]|$)/i.test(u)) continue;
      const v = u.replace(/\.min\.js/i, '.js');
      if (fetched.has(v) || isStaticNoise(v)) continue;
      if (args.jsFilter && isNoiseJs(v)) continue;
      fetched.add(v);
      minVariants.push(v);
      if (minVariants.length >= 10) break;
    }
    if (minVariants.length > 0) {
      const minProducts = await mapPool(minVariants, JS_POOL_SIZE, async (u) => ({ u, text: await fetchText(u, args.jsTimeout) }));
      for (const p of minProducts) {
        if (!p || !p.text) continue;
        discoveredJs.add(p.u);
        harvest(p.text, p.u);
      }
    }

    // late-injected DOM: bot sensors/beacons write links after load —
    // re-read the page once (~free) so they aren't missed.
    try {
      harvest(await page.content(), finalUrl);
      await ingestDomLinks();
    } catch { /* ignore */ }

    // discovered absolute .js files are endpoints too (scope-filtered downstream)
    for (const u0 of discoveredJs) {
      const u = canonicalUrl(u0);
      if (isStaticNoise(u)) { dropped.media++; continue; } // same always-on filter (defense in depth)
      if (args.jsFilter && isJsFile(u) && isNoiseJs(u)) { dropped.js++; continue; }
      absolute.add(u);
    }

    return {
      ok: true,
      finalUrl,
      jsCount: fetched.size,
      rawCount: rawSeen.size,
      urls: absolute,
      links: crawlLinks,
      inlineSecrets,
      dropped,
    };
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    try { await context.close(); } catch { /* ignore */ }
  }
}

/**
 * Depth-limited crawl of in-scope links found on the seed page.
 * Ported from hakrawler's colly MaxDepth loop / gospider's depth flag.
 * Opt-in via --depth 2+. Sequential per target on purpose: the per-host
 * throttle already spaces requests, and this avoids a burst on one site.
 */
async function crawlDeeper(rawInput, seed, browser, args) {
  const merged = {
    input: rawInput,
    ok: true,
    finalUrl: seed.finalUrl,
    jsCount: seed.jsCount,
    rawCount: seed.rawCount,
    urls: new Set(seed.urls),
    inlineSecrets: [...(seed.inlineSecrets || [])],
    dropped: { media: seed.dropped?.media || 0, js: seed.dropped?.js || 0 },
    pages: 1,
  };
  const maxDepth = args.depth === 0 ? Infinity : args.depth;
  const visited = new Set([dedupeKey(seed.finalUrl)]);
  const seedDomain = registrableDomain(hostnameOfUrl(seed.finalUrl));
  const sortNext = (list) => [...list].sort((a, b) => {
    const ad = registrableDomain(hostnameOfUrl(a)) === seedDomain ? 0 : 1;
    const bd = registrableDomain(hostnameOfUrl(b)) === seedDomain ? 0 : 1;
    return ad - bd || (a < b ? -1 : a > b ? 1 : 0);
  });
  let queue = sortNext(seed.links || []).map((u) => ({ u, d: 2 }));
  let pages = 1;

  while (queue.length > 0 && pages < args.maxPages) {
    if (globalThis.__INTERRUPTED) break;
    const { u, d } = queue.shift();
    const key = dedupeKey(u);
    if (visited.has(key)) continue;
    visited.add(key);
    if (isStaticNoise(u) || isJsFile(u)) continue;
    if (typeof args.inScope === 'function' && !args.inScope(u)) continue;

    let r;
    try {
      r = await processSingleUrl(u, browser, args);
    } catch {
      if (args.verbose) info(`[WARN] crawl failed ${short(u, 80)}`);
      continue;
    }
    if (!r.ok) continue;
    pages++;
    merged.rawCount += r.rawCount;
    merged.jsCount += r.jsCount;
    merged.dropped.media += r.dropped?.media || 0;
    merged.dropped.js += r.dropped?.js || 0;
    for (const x of r.urls) merged.urls.add(x);
    for (const s of r.inlineSecrets || []) merged.inlineSecrets.push(s);

    if (d < maxDepth) {
      for (const l of sortNext(r.links || [])) {
        if (!visited.has(dedupeKey(l))) queue.push({ u: l, d: d + 1 });
      }
      // bound memory on link-heavy sites (nearest links kept)
      if (queue.length > args.maxPages * 10) queue = queue.slice(0, args.maxPages * 10);
    }
  }
  merged.pages = pages;
  if (args.verbose && pages > 1) {
    info(`[CRAWL] ${short(seed.finalUrl, 70)}: ${pages} pages, ${merged.urls.size} urls`);
  }
  return merged;
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
      if (r.ok && (args.depth === 0 || args.depth > 1) && r.links && r.links.size > 0) {
        return await crawlDeeper(rawInput, r, browser, args);
      }
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
  globalThis.__VERBOSE = args.verbose;
  if (args.fast) {
    PAGE_GAP_MS = 300; JS_GAP_MS = 100; JITTER_MS = 120; MAP_GAP_MS = 100;
    info(`[*] --fast: aggressive timing restored (12-wide maps, 100ms gaps)`);
  }

  const targets = await loadTargets(args);

  // output files — always a urls + js pair, never combined, never overwrites
  // (explicit -o is the only overwriting case, because you named it):
  //   explicit -o   -> that file (urls) + sibling -js file
  //   single target -> <domain>-urls.txt + <domain>-js.txt, then -urls2/-js2, -urls3/-js3 …
  //   multi target  -> urls1.txt+js1.txt, urls2.txt+js2.txt, … (first free pair)
  let outUrls, outJs;
  if (args.outputExplicit && args.output) {
    outUrls = args.output;
    outJs = jsSiblingFilename(args.output);
  } else if (targets.length > 1) {
    ({ urls: outUrls, js: outJs } = nextNumberedPair('.'));
  } else {
    const base = deriveOutputFilenames(targets);
    ({ urls: outUrls, js: outJs } = firstFreePair(base.urls, base.js));
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
  args.inScope = inScope; // shared with the depth crawler (processTarget)

  const numWorkers = autoPageWorkers(targets.length);
  const unpackDir = deriveUnpackDir(outUrls, targets, args.outputExplicit);
  const mapPoolSize = args.fast ? JS_POOL_SIZE : MAP_POOL_SIZE;
  const mode = args.fast ? 'fast' : 'polite';
  const depthValue = args.depth === 1
    ? '1 (seed pages only)'
    : `${args.depth === 0 ? '∞' : args.depth} (max ${args.maxPages} pages)`;
  info(`[*] Targets: ${targets.length}`);
  info(labelBlock([
    ['mode', `${mode} · ${plural(numWorkers, 'worker')} · js-pool ${JS_POOL_SIZE} · map-pool ${mapPoolSize}`],
    ['rate limit', `per-host + ${JITTER_MS}ms jitter`],
    ['wait', `${args.wait}s`],
    ['timeout', `${args.timeout}s`],
    ['depth', depthValue],
    ['robots', args.robots ? 'on' : 'off'],
    ['sitemap', args.sitemap ? 'on' : 'off'],
    ['strict', args.strict ? 'on' : 'off'],
    ['scope', args.scope],
    ['filters', `collapse ${args.collapse ? 'on' : 'off'} · js-noise ${args.jsFilter ? 'filtered' : 'kept'}`],
    ['output', `${outUrls}\n${outJs}`],
    ['sourcemaps', args.sourcemap ? `on (max ${args.maxMaps === 0 ? 500 : args.maxMaps}) -> ${unpackDir}/` : 'off'],
    ['secrets', args.secrets ? 'on' : 'off'],
  ]));
  info('');

  const urlResults = new Set();
  const jsResults = new Set();
  const urlPatterns = new Set(); // patternKey -> already have this shape
  const jsPatterns = new Set();
  const filterStats = { media: 0, js: 0, dup: 0 };
  const inlineSecretsAll = [];
  const droppedHosts = new Set(); // filtered third-party hosts, log summary only

  /**
   * Single insertion point for results: canonicalize, drop media/noise JS,
   * then collapse uuid/hex/numeric-id patterns to one URL per shape.
   */
  const pushResult = (rawUrl) => {
    const u = canonicalUrl(rawUrl);
    if (isStaticNoise(u)) { filterStats.media++; return false; }
    const js = isJsFile(u);
    if (js && args.jsFilter && isNoiseJs(u)) { filterStats.js++; return false; }
    if (args.collapse) {
      const k = patternKey(u);
      const seen = js ? jsPatterns : urlPatterns;
      if (seen.has(k)) { filterStats.dup++; return false; }
      seen.add(k);
    }
    const set = js ? jsResults : urlResults;
    if (set.has(u)) return false;
    set.add(u);
    return true;
  };
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
  const saveAndExit = (code, extras = []) => {
    try {
      writeList(outUrls, urlResults);
      writeList(outJs, jsResults);
    } catch (e) {
      console.error(`Failed to write output: ${e?.message || e}`);
      process.exit(4);
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const extraList = (Array.isArray(extras) ? extras : [extras]).filter(Boolean);
    const rows = [
      ['urls', `${urlResults.size}\n${outUrls}`],
      ['js', `${jsResults.size}\n${outJs}`],
    ];
    if (extraList.length > 0) rows.push(['extra', extraList.join('\n')]);
    console.log(`\n[DONE] ${plural(targets.length, 'target')} in ${dt}s\n${labelBlock(rows, 2)}`);
    if (args.verbose && args.scope !== 'all' && droppedHosts.size > 0) {
      info(`[SCOPE] dropped third-party (${[...droppedHosts].sort().slice(0, 15).join(', ')}${droppedHosts.size > 15 ? ', …' : ''}) — ${plural(droppedHosts.size, 'host')}. Use --scope all to keep.`);
    }
    process.exit(code);
  };
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    globalThis.__INTERRUPTED = true;
    console.log('\n[!] Interrupted — saving partial results…');
    saveAndExit(130);
  });

  // worker pool (auto-sized; per-host throttle keeps it IP-ban safe)
  // progress is checkpointed to disk every 10 targets so long runs survive crashes.
  let next = 0;
  let doneCount = 0;
  let saveChain = Promise.resolve();
  const checkpoint = () => {
    doneCount++;
    if (targets.length < 10) return; // progress lines only matter on big lists
    if (doneCount % 10 === 0 || doneCount === targets.length) {
      const n = doneCount;
      saveChain = saveChain.then(() => {
        try {
          writeList(outUrls, urlResults);
          writeList(outJs, jsResults);
        } catch { /* final save retries */ }
      }).catch(() => {});
      info(`[*] Progress: ${n}/${targets.length} targets (${urlResults.size} urls, ${jsResults.size} js)`);
    }
  };
  info(tableHeader());
  const workers = Array.from(
    { length: Math.min(numWorkers, targets.length) },
    async () => {
      while (true) {
        if (interrupted) return;
        const idx = next++;
        if (idx >= targets.length) return;
        const input = targets[idx];
        let r;
        try {
          r = await processTarget(input, browser, args);
        } catch (e) {
          // isolated: a throwing target must never kill the run
          const msg = String(e?.message?.split('\n')[0] || e);
          if (globalThis.__QUIET) console.log(`[FAIL] ${short(input)} (${msg})`);
          else console.log(failRow(input, msg));
          checkpoint();
          continue;
        }
        if (!r.ok) {
          if (globalThis.__QUIET) console.log(`[FAIL] ${short(input)} (${r.error})`);
          else console.log(failRow(input, r.error));
          checkpoint();
          continue;
        }
        let added = 0;
        let scoped = 0;
        const before = urlResults.size + jsResults.size;
        for (const raw of r.urls) {
          const u = canonicalUrl(raw);
          if (!u) continue;
          if (!inScope(u)) {
            const h = hostnameOfUrl(u);
            if (h) droppedHosts.add(h);
            continue;
          }
          scoped++;
          pushResult(u);
        }
        if (r.dropped) {
          filterStats.media += r.dropped.media || 0;
          filterStats.js += r.dropped.js || 0;
        }
        if (Array.isArray(r.inlineSecrets)) {
          for (const s of r.inlineSecrets) {
            if (s && typeof s.header === 'string' && Array.isArray(s.hits) && s.hits.length > 0) {
              inlineSecretsAll.push(s);
            }
          }
        }
        added = (urlResults.size + jsResults.size) - before;
        info(okRow(r.finalUrl, r.jsCount, r.rawCount, scoped, added));
        checkpoint();
      }
    },
  );
  await Promise.all(workers);
  await saveChain.catch(() => {});

  // robots.txt + sitemap.xml harvesting (logic ported from gospider).
  // Same-origin and polite: one robots.txt + up to 6 sitemap files per origin,
  // throttled per host, results go through the same scope/static filters.
  const siteExtra = [];
  if ((args.robots || args.sitemap) && !interrupted) {
    const origins = [...new Set(targets.map(originOf).filter(Boolean))];
    let robAdded = 0;
    let mapAdded = 0;
    let robotsOk = 0;
    let sitemapsOk = 0;
    const addScoped = (u) => {
      if (!u || !inScope(u)) return false;
      return pushResult(u);
    };
    info(`[*] robots/sitemap: checking ${origins.length} origin(s)`);
    await mapPool(origins, 4, async (origin) => {
      if (interrupted) return;
      let sitemapSeeds = [];
      if (args.robots) {
        const r = await fetchRobots(origin, args.timeout);
        const before = robAdded;
        for (const u of r.urls) if (addScoped(u)) robAdded++;
        if (robAdded > before) robotsOk++;
        sitemapSeeds = r.sitemaps;
      }
      if (args.sitemap) {
        const found = await fetchSitemap(origin, args.timeout, sitemapSeeds);
        const before = mapAdded;
        for (const u of found) if (addScoped(u)) mapAdded++;
        if (mapAdded > before) sitemapsOk++;
      }
    });
    if (robAdded || mapAdded) {
      saveChain = saveChain.then(() => {
        try { writeList(outUrls, urlResults); writeList(outJs, jsResults); } catch { /* final save retries */ }
      }).catch(() => {});
      siteExtra.push(`robots ${robAdded} (${plural(robotsOk, 'host')}) · sitemap ${mapAdded} (${plural(sitemapsOk, 'host')})`);
    }
  }

  // sourcemap auto-unpack: every in-scope .js -> .js.map (JS-only, like unwebpack)
  // polite by default: 2-wide, 1.5s/host gap, 429/503 backoff. --fast restores 12-wide.
  const mapExtra = [];
  let mapsOk = 0;
  let filesOk = 0;
  const jsToSub = new Map();
  if (args.sourcemap && !interrupted && jsResults.size > 0) {
    const cap = args.maxMaps === 0 ? 500 : args.maxMaps;
    const jsList = [...jsResults].sort().slice(0, cap);
    info(`[*] Sourcemaps (${mode}): trying ${jsList.length} .js.map -> ${unpackDir}/`);
    const taken = new Set();
    const foundMaps = [];
    await mapPool(jsList, mapPoolSize, async (jsUrl) => {
      if (interrupted) return;
      let jsBody = null;
      try { jsBody = await fetchText(jsUrl, args.jsTimeout); } catch { jsBody = null; }
      const cands = mapCandidatesForJs(jsUrl, jsBody);
      for (const mapUrl of cands) {
        if (interrupted) return;
        let txt = null;
        try {
          txt = args.fast
            ? await fetchText(mapUrl, args.jsTimeout, MAX_SOURCEMAP_BYTES)
            : await fetchMapText(mapUrl, args.jsTimeout);
        } catch { txt = null; }
        if (!txt) continue;
        const sub = subdirForJs(jsUrl, taken);
        const dest = path.join(unpackDir, sub);
        const n = unpackSourcemapText(txt, dest);
        if (n > 0) {
          mapsOk++;
          filesOk += n;
          foundMaps.push(mapUrl);
          jsToSub.set(jsUrl, sub);
          info(`[MAP] ${short(jsUrl, 70)} -> ${short(mapUrl, 70)} (${n} files in ${sub}/)`);
          break; // one good map per js is enough
        }
      }
    });
    for (const m of foundMaps) {
      if (!isStaticNoise(m) && inScope(m)) pushResult(m);
    }
    if (foundMaps.length > 0) {
      try { writeList(outUrls, urlResults); } catch { /* saveAndExit retries */ }
    }
    if (mapsOk === 0) {
      info(`[*] Sourcemaps: no valid .map with sourcesContent found`);
    } else {
      mapExtra.push(`sourcemaps ${mapsOk} maps / ${filesOk} files -> ${unpackDir}/`);
    }
  }

  // secrets scan (tight, JS-only): fetched JS bodies + unpacked sources -> single file
  // format: <url-or-file> + hits, blocks separated by 2 blank lines + ==== bar. Empty sources skipped.
  const secretsExtra = [];
  let outSecrets = secretsSiblingFilename(outUrls);
  if (args.secrets && !interrupted) {
    const BAR = '='.repeat(80);
    const blocks = [];
    const seenSrc = new Set();
    // 1. fetched JS bodies (cached, no extra traffic) — pooled, not sequential:
    // a sequential loop here costs 400ms+ per body on same-host lists.
    const jsListAll = [...jsResults].sort();
    info(`[*] Secrets (tight): scanning ${jsListAll.length} js bodies${mapsOk > 0 ? ' + unpacked sources' : ''}`);
    const jsBlocks = await mapPool(jsListAll, JS_POOL_SIZE, async (jsUrl) => {
      if (interrupted) return null;
      let body = null;
      try { body = await fetchText(jsUrl, args.jsTimeout); } catch { body = null; }
      if (!body) return null;
      let hits;
      try { hits = scanSecrets(body); } catch { return null; }
      if (hits.length === 0) return null;
      return { header: jsUrl, hits };
    });
    for (const b of jsBlocks) {
      if (!b || seenSrc.has(b.header)) continue;
      seenSrc.add(b.header);
      blocks.push(`${b.header}\n${b.hits.map((h) => `  ${h.name} -> ${h.matched}`).join('\n')}`);
    }
    // 1b. inline <script> hits collected in workers (never fetched, scanned in-page)
    for (const b of inlineSecretsAll) {
      if (!b || seenSrc.has(b.header)) continue;
      seenSrc.add(b.header);
      blocks.push(`${b.header}\n${b.hits.map((h) => `  ${h.name} -> ${h.matched}`).join('\n')}`);
    }
    blocks.sort(); // deterministic output regardless of worker/pool completion order
    // 2. unpacked sources (local walk, in-scope code + vendor — tight regexes only)
    try {
      if (fs.existsSync(unpackDir)) {
        const subToJs = new Map([...jsToSub.entries()].map(([u, s]) => [s, u]));
        for (const f of walkFiles(unpackDir)) {
          if (interrupted) break;
          let text;
          try {
            const buf = fs.readFileSync(f);
            if (buf.includes(0)) continue; // binary
            text = buf.toString('utf8');
          } catch { continue; }
          if (!text) continue;
          const hits = scanSecrets(text);
          if (hits.length === 0) continue;
          const rel = path.relative(path.dirname(unpackDir), f);
          const sub = rel.split(path.sep)[1] || '';
          const from = subToJs.get(sub);
          const header = from ? `${rel}  (from ${from})` : rel;
          if (seenSrc.has(header)) continue;
          seenSrc.add(header);
          blocks.push(`${header}\n${hits.map((h) => `  ${h.name} -> ${h.matched}`).join('\n')}`);
        }
      }
    } catch { /* walk errors ignored */ }
    const nHits = blocks.reduce((a, b) => a + (b.split('\n').length - 1), 0);
    if (blocks.length > 0) {
      const SEP = `\n\n${BAR}\n\n`;
      try {
        const sdir = path.dirname(outSecrets);
        if (sdir && sdir !== '.' && sdir !== '') fs.mkdirSync(sdir, { recursive: true });
        fs.writeFileSync(outSecrets, blocks.join(SEP) + '\n');
      } catch (e) {
        console.error(`Failed to write secrets: ${e?.message || e}`);
      }
      info(`[*] Secrets: ${blocks.length} sources, ${nHits} hits -> ${outSecrets}`);
      secretsExtra.push(`secrets ${nHits} hits -> ${outSecrets}`);
    } else {
      info(`[*] Secrets: clean (0 hits, no file written)`);
    }
    mapExtra.push(...secretsExtra);
  }

  await browser.close().catch(() => {});
  const filterExtra = [];
  const dropped = filterStats.media + filterStats.js + filterStats.dup;
  if (dropped > 0) {
    filterExtra.push(`filtered ${filterStats.media} media · ${filterStats.js} noise js · ${filterStats.dup} duplicate patterns`);
  }
  saveAndExit(0, [...siteExtra, ...mapExtra, ...filterExtra]);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
