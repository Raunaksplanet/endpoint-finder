/**
 * Endpoint classification — port of JSHound's analyzer cleanEndpoint /
 * classifyPath / literalAt.use / isNonRequestValue.
 *
 * The goal is not to find more strings; it is to decide which strings are
 * request targets. A bundler's module table is full of paths that look exactly
 * like routes, so the surrounding bytes decide:
 *
 *   require("./src/app.js")        -> module
 *   fetch("./src/app.js")          -> request
 *   { "./src/app.js": function() } -> module map
 *   url: "/api/users"              -> request
 *   { op: "add", path: "/items/0" }-> JSON Patch, not a route
 */

export const MAX_CANDIDATE_LENGTH = 2048;

const STATIC_ASSET = /\.(?:css|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|eot|map|mp4|webm|mp3|wav|ogg|flac|aac)(?:[?#].*)?$/i;
const ROUTE_SEGMENT = /^(?::?[A-Za-z0-9_.@%\-]+|\{[A-Za-z0-9_.\-]+\}|[A-Za-z0-9_.@%\-]+:[A-Za-z0-9_.\-]+)$/;
const JSON_PATCH_OPERATION = /(?:^|[,{\s])["']?op["']?\s*:\s*["'](?:add|remove|replace|move|copy|test)["']/;

const MODULE_CALLEES = ['require', 'import', 'resolve', 'context'];
const REQUEST_CALLEES = [
  'fetch', 'get', 'post', 'put', 'patch', 'delete', 'head', 'request',
  'open', 'ajax', 'getjson', 'sendbeacon', 'eventsource',
];
const MODULE_SOURCE_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.scss', '.sass', '.less', '.css',
];

const RELATIVE_ROUTE_PREFIXES = [
  'account/', 'accounts/', 'admin/', 'api/', 'auth/', 'callback/', 'config/',
  'credential/', 'credentials/', 'dashboard/', 'debug/', 'download/', 'graphql/',
  'internal/', 'login/', 'logout/', 'member/', 'members/', 'oauth/', 'org/',
  'orgs/', 'private/', 'project/', 'projects/', 'rest/', 'settings/', 'token/',
  'upload/', 'user/', 'users/', 'v1/', 'v2/', 'v3/', 'webhook/', 'webhooks/',
];

const ROUTE_KEYWORDS = new Set([
  'account', 'accounts', 'admin', 'api', 'auth', 'callback', 'config', 'create',
  'delete', 'download', 'export', 'graphql', 'import', 'internal', 'list',
  'login', 'logout', 'member', 'members', 'oauth', 'org', 'orgs', 'private',
  'profile', 'project', 'projects', 'rest', 'search', 'settings', 'sso',
  'token', 'update', 'upload', 'user', 'users', 'v1', 'v2', 'v3', 'webhook',
  'webhooks',
]);

const NON_REQUEST_NAMESPACES = ['/client_streamz/', 'googleapis.config/'];

const MIME_VALUES = new Set([
  'application/json', 'application/xml', 'application/x-www-form-urlencoded',
  'multipart/form-data', 'text/css', 'text/html', 'text/javascript', 'text/plain',
]);

const WEB_EXTENSIONS = [
  '.action', '.asp', '.aspx', '.cgi', '.do', '.html', '.js', '.json',
  '.jsp', '.php', '.txt', '.xml',
];

function trimSet(value, chars) {
  let a = 0;
  let b = value.length;
  while (a < b && chars.includes(value[a])) a++;
  while (b > a && chars.includes(value[b - 1])) b--;
  return value.slice(a, b);
}

function trimRightSet(value, chars) {
  let b = value.length;
  while (b > 0 && chars.includes(value[b - 1])) b--;
  return value.slice(0, b);
}

/**
 * Trim prose punctuation from the end, but keep a `}` that closes an earlier
 * `{`. JSHound trims `}` unconditionally, which drops the brace from a route
 * like `/api/users/{id}` and makes its own route-segment rule reject it.
 */
function trimTrailingPunctuation(value) {
  const chars = `\\,;)]}>`;
  let out = value;
  while (out.length > 0 && chars.includes(out[out.length - 1])) {
    if (out[out.length - 1] === '}') {
      const opens = (out.match(/\{/g) || []).length;
      const closes = (out.match(/\}/g) || []).length;
      if (opens >= closes) break;
    }
    out = out.slice(0, -1);
  }
  return out;
}

function trimLeftWs(value) {
  return value.replace(/^[ \t\r\n]+/, '');
}

function trimRightWs(value) {
  return value.replace(/[ \t\r\n]+$/, '');
}

function isCalleeByte(ch) {
  return ch === '_' || ch === '$' || ch === '.' ||
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z');
}

/** Trailing identifier, keeping dotted member access: `require.resolve` -> `resolve`. */
function identifierSuffix(value) {
  let start = value.length;
  while (start > 0 && isCalleeByte(value[start - 1])) start--;
  let word = value.slice(start);
  const dot = word.lastIndexOf('.');
  if (dot >= 0) word = word.slice(dot + 1);
  return word;
}

function identifierPrefix(value) {
  let end = 0;
  while (end < value.length && isCalleeByte(value[end]) && value[end] !== '.') end++;
  return value.slice(0, end);
}

/** Position of a quoted literal in the source. */
export function literalAt(source, lit) {
  return { source, open: lit.open, close: lit.close };
}

/**
 * Read how a literal is used from the bytes around it.
 * @returns {'unknown'|'module'|'request'}
 */
export function useOf(at) {
  if (!at || !at.source) return 'unknown';
  const { source, open, close } = at;

  const before = trimRightWs(source.slice(Math.max(0, open - 64), open));
  if (before.endsWith('(')) {
    const callee = identifierSuffix(before.slice(0, -1)).toLowerCase();
    if (MODULE_CALLEES.includes(callee)) return 'module';
    if (REQUEST_CALLEES.includes(callee)) return 'request';
  } else {
    const word = identifierSuffix(before);
    if (word === 'from' || word === 'import') return 'module';
    if (before.endsWith(':')) {
      const key = identifierSuffix(trimRightSet(before.slice(0, -1), `"'`)).toLowerCase();
      if (key === 'url' || key === 'uri' || key === 'endpoint') return 'request';
    }
  }

  let after = trimLeftWs(source.slice(
    Math.min(source.length, close + 1),
    Math.min(source.length, close + 160),
  ));
  if (!after.startsWith(':')) return 'unknown';

  // A ./ or ../ path used as an object key is a bundler module table.
  if (before.endsWith('{') || before.endsWith(',')) return 'module';

  after = trimLeftWs(after.slice(1));
  while (after.startsWith('/*')) {
    const end = after.indexOf('*/');
    if (end < 0) return 'unknown';
    after = trimLeftWs(after.slice(end + 2));
  }
  if (after.startsWith('(') || after.startsWith('function') || after.startsWith('async')) {
    return 'module';
  }
  const name = identifierPrefix(after);
  if (name && trimLeftWs(after.slice(name.length)).startsWith('=>')) return 'module';
  return 'unknown';
}

function hasNodeModulesSegment(value) {
  return value.startsWith('node_modules/') || value.includes('/node_modules/');
}

/**
 * @returns {{use: 'unknown'|'module'|'request', module: boolean}}
 */
export function classifyPath(value, at) {
  if (hasNodeModulesSegment(value)) return { use: 'unknown', module: true };
  if (!value.startsWith('./') && !value.startsWith('../')) {
    return { use: 'unknown', module: false };
  }
  const use = useOf(at);
  if (use === 'module') return { use, module: true };
  if (use !== 'request' && !/[?#]/.test(value)) {
    const lower = value.toLowerCase();
    if (MODULE_SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      return { use, module: true };
    }
  }
  return { use, module: false };
}

function isSchemaReference(value) {
  const hash = value.indexOf('#');
  if (hash < 0) return false;
  const file = value.slice(0, hash);
  const fragment = value.slice(hash + 1);
  if (!file || file.includes('/')) return false;
  const lower = file.toLowerCase();
  if (!lower.endsWith('.json') && !lower.endsWith('.yaml') && !lower.endsWith('.yml')) {
    return false;
  }
  return fragment.startsWith('/$defs/') ||
    fragment.startsWith('/definitions/') ||
    fragment.startsWith('/components/schemas/');
}

function inJSONPatchOperation(at) {
  if (!at || !at.source) return false;
  const { source, open, close } = at;
  const before = trimRightWs(source.slice(Math.max(0, open - 16), open));
  if (!before.endsWith(':')) return false;
  const key = identifierSuffix(trimRightSet(before.slice(0, -1), `"'`));
  if (key !== 'path') return false;

  const reach = 240;
  let start = -1;
  let depth = 0;
  for (let i = open - 1; i >= 0 && open - i <= reach; i--) {
    const c = source[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return false;

  let end = -1;
  depth = 0;
  for (let i = close + 1; i < source.length && i - close <= reach; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) { end = i; break; }
      depth--;
    }
  }
  return end > 0 && JSON_PATCH_OPERATION.test(source.slice(start, end));
}

function isJSONPointerExample(at) {
  if (!at || !at.source) return false;
  const { source, open } = at;
  const window = source.slice(Math.max(0, open - 160), open);
  const index = window.toLowerCase().lastIndexOf('json pointer');
  if (index < 0) return false;
  return !/["'`;{}\r\n]/.test(window.slice(index));
}

/** A value shaped like a path but known not to be a request target. */
export function isNonRequestValue(value, at) {
  if (NON_REQUEST_NAMESPACES.some((prefix) => value.startsWith(prefix))) return true;
  if (isSchemaReference(value)) return true;
  return inJSONPatchOperation(at) || isJSONPointerExample(at);
}

/**
 * Decide whether a quoted value is a request path.
 * @returns {string|null} the cleaned value, or null
 */
export function cleanEndpoint(candidate, at) {
  let value = trimSet(String(candidate ?? ''), `\\"'`);
  value = trimTrailingPunctuation(value);

  if (value.length < 3 || value.length > MAX_CANDIDATE_LENGTH) return null;
  if (/[ \t\r\n]/.test(value)) return null;
  if (value.startsWith('#') || value.startsWith('data:')) return null;
  if (value.includes('${')) return null;
  if (STATIC_ASSET.test(value)) return null;
  if (MIME_VALUES.has(value.toLowerCase())) return null;

  const rootRelative = value.startsWith('/') && !value.startsWith('//');
  const dotRelative = value.startsWith('./') || value.startsWith('../');
  const relative = !rootRelative && !dotRelative;
  if (relative && !value.includes('/')) return null;

  const { use, module } = classifyPath(value, at);
  if (module || isNonRequestValue(value, at)) return null;

  let structural = value.split('?')[0].split('#')[0];
  while (structural.startsWith('../')) structural = structural.slice(3);
  if (structural.startsWith('./')) structural = structural.slice(2);
  const parts = structural.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length === 0) return null;

  let allShort = true;
  for (const part of parts) {
    if (part.length >= 2) allShort = false;
    if (!ROUTE_SEGMENT.test(part)) return null;
  }
  if (allShort) return null;

  // Plain relative values, and unclassified ./ or ../ values, need a keyword
  // gate. A request call vouches for its own argument.
  if (relative || (dotRelative && use !== 'request')) {
    const gated = dotRelative ? structural.toLowerCase() : value.toLowerCase();
    const highPrefix = RELATIVE_ROUTE_PREFIXES.some((prefix) => gated.startsWith(prefix));
    let highSegment = false;
    let parameterized = false;
    for (const part of parts) {
      if (ROUTE_KEYWORDS.has(part.toLowerCase().replace(/^:/, ''))) highSegment = true;
      if (part.startsWith(':')) parameterized = true;
    }
    const last = parts[parts.length - 1].toLowerCase();
    const webExtension = WEB_EXTENSIONS.some((ext) => last.endsWith(ext));
    if (!highPrefix && !highSegment && !parameterized && !webExtension) return null;
  }

  return value;
}

/**
 * Scan quoted literals and direct quoted paths.
 *
 * `quoted` mirrors JSHound's quotedValues: every closed ' " or ` literal up to
 * MAX_CANDIDATE_LENGTH. `direct` mirrors directPaths: a quoted value starting
 * with /, ./ or ../ with at least two characters after the prefix.
 */
export function scanLiterals(source) {
  return { quoted: quotedValues(source), direct: directPaths(source) };
}

export function quotedValues(source) {
  const values = [];
  for (let cursor = 0; cursor < source.length;) {
    const quote = source[cursor];
    if (quote !== "'" && quote !== '"' && quote !== '`') { cursor++; continue; }

    const start = cursor + 1;
    let end = cursor + 1;
    let escaped = false;
    let closed = false;
    while (end < source.length) {
      const b = source[end];
      if (escaped) { escaped = false; end++; continue; }
      if (b === '\\') { escaped = true; end++; continue; }
      if (b === quote) { closed = true; break; }
      if (quote !== '`' && (b === '\r' || b === '\n')) break;
      end++;
    }

    if (closed) {
      if (end - start <= MAX_CANDIDATE_LENGTH) {
        values.push({ value: source.slice(start, end), open: cursor, close: end });
      }
      cursor = end + 1;
    } else {
      cursor = start;
    }
  }
  return values;
}

export function directPaths(source) {
  const values = [];
  const maxDirect = MAX_CANDIDATE_LENGTH;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c !== '"' && c !== "'") continue;

    const quoteAt = i + 1;
    let contentStart;
    if (source.startsWith('/', quoteAt)) contentStart = quoteAt + 1;
    else if (source.startsWith('./', quoteAt)) contentStart = quoteAt + 2;
    else if (source.startsWith('../', quoteAt)) contentStart = quoteAt + 3;
    else continue;

    let end = contentStart;
    let count = 0;
    while (end < source.length && count <= maxDirect) {
      const b = source[end];
      if (b === '"' || b === "'" || b === '<' || b === '>' || b === '\\' ||
          b === ' ' || b === '\t' || b === '\n' || b === '\f' || b === '\r') {
        break;
      }
      end++;
      count++;
    }
    if (count >= 2 && count <= maxDirect && end < source.length &&
        (source[end] === '"' || source[end] === "'")) {
      values.push({ value: source.slice(quoteAt, end), open: i, close: end });
      i = end;
    }
  }
  return values;
}
