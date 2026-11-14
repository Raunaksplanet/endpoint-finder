/**
 * webpack_chunks.js — safe extractor for webpack chunk URLs.
 *
 * Port of the hardened `unpack_webpack.py` logic to JavaScript. It parses the
 * small expression assigned to `__webpack_require__.u` (or the old
 * `jsonpScriptSrc`) with a restricted expression evaluator. It NEVER runs the
 * site's code: no eval, no new Function, no vm.
 *
 * Handles:
 *   - webpack 5 arrow / block-body / function expressions
 *   - webpack 4 jsonpScriptSrc
 *   - prefix maps: (({809:"4ad8"})[e] || e)
 *   - template literals: `static/js/${e}.${({0:"hash"})[e]}.js`
 *   - single/double quotes, escapes, comments
 *   - ||, ??, &&, ternary
 *   - inline maps, external map variables, function aliases
 *   - public path detection (r.p / __webpack_require__.p)
 *   - numeric, quoted and named chunk keys
 *   - de-duplication + numeric-aware ordering
 *
 * The caller resolves the returned (possibly relative) URLs against the page.
 */

const UNDEFINED = Symbol('undefined');

const ESCAPES = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
  '\\': '\\', "'": "'", '"': '"', '`': '`', '/': '/',
};

const TOKEN_RE = /(\s+)|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*)|(\?\?|\|\||&&|===|!==|==|!=|<=|>=|=>|\?\.|\.\.\.|[+\-*/%()\[\]{},:.;?<>=!&|])/g;

const ASSIGN_U_RE = /((?:__webpack_require__|[A-Za-z_$][\w$]*))\.u\s*=\s*/g;
const ASSIGN_CSS_RE = /((?:__webpack_require__|[A-Za-z_$][\w$]*))\.miniCssF\s*=\s*/g;
const JSONP_RE = /function\s+jsonpScriptSrc\s*\(([^)]*)\)\s*\{/g;
const MAP_PAIR_RE = /["']?([A-Za-z0-9_$.\-~]+)["']?\s*:\s*(["'])(.*?)\2/gs;
const HASH_RE = /^[A-Za-z0-9_\-~]{3,}$/;

function truthy(value) {
  if (value === UNDEFINED || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  return true;
}

function jsStr(value) {
  if (value === UNDEFINED) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return '[object Object]';
  return String(value);
}

function jsAdd(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  return jsStr(a) + jsStr(b);
}

function decodeJsString(raw) {
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    i++;
    if (i >= body.length) break;
    const e = body[i];
    if (e === 'x' && i + 2 < body.length) {
      const hex = body.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; continue; }
    }
    if (e === 'u') {
      if (body[i + 1] === '{') {
        const end = body.indexOf('}', i);
        if (end !== -1) {
          const hex = body.slice(i + 2, end);
          if (/^[0-9a-fA-F]+$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i = end; continue; }
        }
      } else if (i + 4 < body.length) {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; continue; }
      }
    }
    out += (ESCAPES[e] !== undefined ? ESCAPES[e] : e);
  }
  return out;
}

function splitTemplate(raw) {
  const body = raw.slice(1, -1);
  const parts = [];
  let buf = '';
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('${', i)) {
      if (buf) { parts.push(buf); buf = ''; }
      let depth = 1;
      let j = i + 2;
      while (j < body.length && depth) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        j++;
      }
      parts.push({ expr: body.slice(i + 2, j - 1) });
      i = j;
    } else if (body[i] === '\\' && i + 1 < body.length) {
      buf += (ESCAPES[body[i + 1]] !== undefined ? ESCAPES[body[i + 1]] : body[i + 1]);
      i += 2;
    } else {
      buf += body[i++];
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function tokenize(source) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(source)) !== null) {
    if (m[0].length === 0) { TOKEN_RE.lastIndex++; continue; }
    if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) continue;
    let type = 'punct';
    if (m[4] !== undefined) type = 'template';
    else if (m[5] !== undefined) type = 'string';
    else if (m[6] !== undefined) type = 'number';
    else if (m[7] !== undefined) type = 'ident';
    tokens.push({ type, value: m[0] });
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class Parser {
  constructor(tokens, env) {
    this.tokens = tokens;
    this.pos = 0;
    this.env = env;
  }

  peek() { return this.tokens[this.pos]; }

  eat(value) {
    const token = this.tokens[this.pos];
    if (value !== undefined && token.value !== value) {
      throw new Error(`expected ${value}, got ${token.value}`);
    }
    this.pos++;
    return token;
  }

  parse() {
    const value = this.expression();
    if (this.peek().type !== 'eof') throw new Error('trailing token');
    return value;
  }

  expression() { return this.ternary(); }

  ternary() {
    const cond = this.orExpr();
    if (this.peek().value === '?') {
      this.eat('?');
      const yes = this.expression();
      this.eat(':');
      const no = this.expression();
      return truthy(cond) ? yes : no;
    }
    return cond;
  }

  orExpr() {
    let value = this.andExpr();
    while (this.peek().value === '||' || this.peek().value === '??') {
      const op = this.eat().value;
      const right = this.andExpr();
      if (op === '||') value = truthy(value) ? value : right;
      else value = (value === UNDEFINED || value === null) ? right : value;
    }
    return value;
  }

  andExpr() {
    let value = this.addExpr();
    while (this.peek().value === '&&') {
      this.eat('&&');
      const right = this.addExpr();
      value = truthy(value) ? right : value;
    }
    return value;
  }

  addExpr() {
    let value = this.unary();
    while (this.peek().value === '+') {
      this.eat('+');
      value = jsAdd(value, this.unary());
    }
    return value;
  }

  unary() {
    const op = this.peek().value;
    if (op === '!') { this.eat('!'); return !truthy(this.unary()); }
    if (op === '-') { this.eat('-'); const v = this.unary(); return typeof v === 'number' ? -v : v; }
    if (op === '+') { this.eat('+'); return this.unary(); }
    return this.postfix();
  }

  postfix() {
    let value = this.primary();
    while (true) {
      const token = this.peek().value;
      if (token === '.') {
        this.eat('.');
        const name = this.eat().value;
        if (value && typeof value === 'object') {
          value = Object.prototype.hasOwnProperty.call(value, name) ? value[name] : UNDEFINED;
        } else if (value === UNDEFINED && name === 'p') {
          value = this.env.__publicPath !== undefined ? this.env.__publicPath : '';
        } else {
          value = UNDEFINED;
        }
      } else if (token === '[') {
        this.eat('[');
        const index = this.expression();
        this.eat(']');
        if (value && typeof value === 'object') {
          const key = jsStr(index);
          value = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : UNDEFINED;
        } else {
          value = UNDEFINED;
        }
      } else if (token === '(') {
        // Chunk URL builders never call functions; refusing keeps the
        // evaluator inert instead of executing site code.
        throw new Error('function calls are not supported');
      } else {
        break;
      }
    }
    return value;
  }

  primary() {
    const token = this.peek();
    if (token.type === 'string') { this.eat(); return decodeJsString(token.value); }
    if (token.type === 'template') { this.eat(); return this.evalTemplate(token.value); }
    if (token.type === 'number') {
      this.eat();
      const text = token.value;
      if (/^0x/i.test(text)) return parseInt(text, 16);
      if (/[.eE]/.test(text)) return parseFloat(text);
      return parseInt(text, 10);
    }
    if (token.type === 'ident') {
      this.eat();
      if (token.value === 'undefined') return UNDEFINED;
      if (token.value === 'null') return null;
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      return Object.prototype.hasOwnProperty.call(this.env, token.value)
        ? this.env[token.value]
        : UNDEFINED;
    }
    if (token.value === '(') {
      this.eat('(');
      const value = this.expression();
      this.eat(')');
      return value;
    }
    if (token.value === '{') return this.objectLiteral();
    if (token.value === '[') return this.arrayLiteral();
    throw new Error(`unexpected token ${token.value}`);
  }

  objectLiteral() {
    this.eat('{');
    const result = Object.create(null);
    while (this.peek().value !== '}') {
      const keyToken = this.peek();
      let key;
      if (keyToken.type === 'string') { key = decodeJsString(keyToken.value); this.eat(); }
      else if (keyToken.type === 'number' || keyToken.type === 'ident') { key = keyToken.value; this.eat(); }
      else throw new Error('invalid object key');
      this.eat(':');
      result[String(key)] = this.expression();
      if (this.peek().value === ',') this.eat(',');
      else break;
    }
    this.eat('}');
    return result;
  }

  arrayLiteral() {
    this.eat('[');
    const result = [];
    while (this.peek().value !== ']') {
      result.push(this.expression());
      if (this.peek().value === ',') this.eat(',');
      else break;
    }
    this.eat(']');
    return result;
  }

  evalTemplate(raw) {
    let out = '';
    for (const part of splitTemplate(raw)) {
      if (typeof part === 'string') out += part;
      else out += jsStr(new Parser(tokenize(part.expr), this.env).parse());
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// source extraction helpers
// ---------------------------------------------------------------------------

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function balanced(src, start, open = '{', close = '}') {
  let depth = 0;
  let i = start;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
    i++;
  }
  throw new Error('unbalanced brackets');
}

function scanExpression(src, start) {
  let depth = 0;
  let i = start;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) {
      break;
    }
    i++;
  }
  return src.slice(start, i);
}

function stripReturn(body) {
  let out = body.trim();
  const m = out.match(/(?:^|[;{}])\s*return\s+/);
  if (m) out = out.slice(m.index + m[0].length);
  out = out.trim();
  while (out.endsWith(';')) out = out.slice(0, -1).trim();
  return out;
}

function extractFunction(src, pos) {
  const i = skipWs(src, pos);
  if (src.startsWith('function', i)) {
    const paren = src.indexOf('(', i);
    const close = src.indexOf(')', paren);
    const params = src.slice(paren + 1, close);
    const param = (params.split(',')[0] || '').trim() || 'e';
    const brace = src.indexOf('{', close);
    return { expr: stripReturn(balanced(src, brace)), param };
  }

  const segment = src.slice(i, i + 256);
  const m = segment.match(/^\(?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)?\s*=>/);
  if (!m) throw new Error('not a chunk function');
  const param = m[1];
  let bodyStart = i + m[0].length;
  while (bodyStart < src.length && /\s/.test(src[bodyStart])) bodyStart++;
  if (src[bodyStart] === '{') {
    return { expr: stripReturn(balanced(src, bodyStart)), param };
  }
  return { expr: stripReturn(scanExpression(src, bodyStart)), param };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasNameAt(src, pos) {
  const tail = src.slice(pos, pos + 160);
  const nameMatch = tail.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:[;,}]|$)/);
  return nameMatch ? nameMatch[1] : null;
}

function extractAliasFunction(src, pos) {
  const name = aliasNameAt(src, pos);
  if (!name) throw new Error('not an alias');
  const patterns = [
    new RegExp(`(?:var|let|const)\\s+${escapeRe(name)}\\s*=\\s*`),
    new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*=\\s*`),
  ];
  for (const pattern of patterns) {
    const decl = src.match(pattern);
    if (decl) {
      try {
        return extractFunction(src, decl.index + decl[0].length);
      } catch { /* next pattern */ }
    }
  }
  throw new Error(`unresolved alias ${name}`);
}

function extractAssignedFunction(src, pos) {
  try {
    return extractFunction(src, pos);
  } catch (error) {
    try {
      return extractAliasFunction(src, pos);
    } catch {
      throw error;
    }
  }
}

function eachMatch(re, src, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const result = fn(m);
    if (result !== undefined) return result;
  }
  return undefined;
}

function extractChunkFunctions(src, css = false) {
  const out = [];
  // Two-pass strategy keeps decoy-heavy bundles fast:
  //   1. cheap direct check for `= function` / `= e =>` (bounded to 500)
  //   2. at most 5 alias lookups (`= someName;`), which scan the whole source
  // Thousands of `x.u = nope;` decoys therefore cost almost nothing.
  const aliasCandidates = [];
  const assignmentRe = css ? ASSIGN_CSS_RE : ASSIGN_U_RE;
  eachMatch(assignmentRe, src, (m) => {
    const pos = m.index + m[0].length;
    const start = skipWs(src, pos);
    const direct = src.startsWith('function', start)
      || /^\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>/.test(src.slice(start, start + 256));
    if (direct) {
      // Cheap check: scan every match (a real runtime can sit behind many
      // decoys), but bound how many candidates we keep.
      if (out.length < 200) {
        try { out.push({ ...extractFunction(src, pos), owner: m[1] }); } catch { /* malformed */ }
      }
    } else if (out.length === 0 && aliasCandidates.length < 5 && aliasNameAt(src, pos)) {
      aliasCandidates.push({ pos, owner: m[1] });
    }
    return undefined;
  });

  // Alias resolution scans the whole source, so only do it when no direct
  // function was found (max 5 attempts).
  if (out.length === 0) {
    for (const candidate of aliasCandidates) {
      try {
        out.push({ ...extractAliasFunction(src, candidate.pos), owner: candidate.owner });
      } catch { /* unresolved alias */ }
    }
  }

  if (!css) {
    let jsonpAttempts = 0;
    eachMatch(JSONP_RE, src, (m) => {
      if (jsonpAttempts >= 5) return true;
      jsonpAttempts++;
      const param = (m[1].split(',')[0] || '').trim() || 'e';
      const brace = src.indexOf('{', m.index);
      try {
        out.push({ expr: stripReturn(balanced(src, brace)), param, owner: '__webpack_require__' });
      } catch { /* malformed */ }
      return undefined;
    });
  }
  return out;
}

function extractChunkFunction(src, css = false) {
  const all = extractChunkFunctions(src, css);
  if (!all.length) {
    throw new Error(css ? 'no .miniCssF chunk function' : 'no .u chunk function');
  }
  return all[0];
}

function parseMapBody(body) {
  const result = Object.create(null);
  MAP_PAIR_RE.lastIndex = 0;
  let m;
  while ((m = MAP_PAIR_RE.exec(body)) !== null) {
    result[m[1]] = m[3];
    if (m[0].length === 0) MAP_PAIR_RE.lastIndex++;
  }
  return result;
}

function looksLikeChunkMap(obj) {
  const values = Object.values(obj);
  if (values.length === 0) return false;
  const good = values.filter((v) => HASH_RE.test(v)).length;
  return good >= Math.max(1, Math.floor(values.length * 0.5));
}

function collectInlineMaps(expr, param) {
  const maps = [];
  const pattern = new RegExp(
    `\\{([^{}]*)\\}\\s*\\)?\\s*\\[\\s*${escapeRe(param)}\\s*\\]`,
    'g',
  );
  for (const m of expr.matchAll(pattern)) {
    const obj = parseMapBody(m[1]);
    if (looksLikeChunkMap(obj)) maps.push(obj);
  }
  if (maps.length === 0) {
    for (const m of expr.matchAll(/\{([^{}]*)\}/g)) {
      const obj = parseMapBody(m[1]);
      if (looksLikeChunkMap(obj)) maps.push(obj);
    }
  }
  return maps;
}

function collectExternalMaps(src, expr, env) {
  const maps = [];
  const names = new Set();
  for (const m of expr.matchAll(/([A-Za-z_$][\w$]*)\s*\[\s*[A-Za-z_$][\w$]*\s*\]/g)) {
    names.add(m[1]);
  }
  names.delete('__webpack_require__');
  for (const name of names) {
    let declRe;
    try {
      declRe = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*=\\s*\\{`, 'g');
    } catch {
      continue;
    }
    eachMatch(declRe, src, (decl) => {
      const brace = src.indexOf('{', decl.index + decl[0].length - 1);
      try {
        const obj = parseMapBody(balanced(src, brace));
        if (looksLikeChunkMap(obj)) {
          env[name] = obj;
          maps.push(obj);
          return true;
        }
      } catch { /* malformed map */ }
      return undefined;
    });
  }
  return maps;
}

function extractPublicPath(src, expr, owner) {
  // Prefer the exact variable used in the chunk function (r.p, n.p, …) or the
  // owner of `.u` when a bundle contains several unrelated `.p = "…"` values.
  const names = new Set();
  for (const m of expr.matchAll(/([A-Za-z_$][\w$]*)\.p\b/g)) names.add(m[1]);
  if (owner && owner !== '__webpack_require__') names.add(owner);
  for (const name of names) {
    const re = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\.p\\s*=\\s*(["'])(.*?)\\1`, 's');
    const m = src.match(re);
    if (m) return m[2];
  }
  const direct = src.match(/__webpack_require__\.p\s*=\s*(["'])(.*?)\1/s);
  if (direct) return direct[2];
  const any = src.match(/(?<![\w$.])[A-Za-z_$][\w$]*\.p\s*=\s*(["'])(.*?)\1/s);
  return any ? any[2] : '';
}

export function applyPublicPath(path, publicPath) {
  if (/^(?:[a-zA-Z][\w+.-]*:)?\/\//.test(path)) return path;
  if (!publicPath) return path;
  if (publicPath.endsWith('/') && path.startsWith('/')) return publicPath + path.slice(1);
  if (!publicPath.endsWith('/') && !path.startsWith('/')) return `${publicPath}/${path}`;
  return publicPath + path;
}

function sortKey(id) {
  return /^\d+$/.test(id) ? [0, Number(id)] : [1, id];
}

function compareIds(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] < kb[1]) return -1;
  if (ka[1] > kb[1]) return 1;
  return 0;
}

/**
 * Extract webpack chunk paths from a JS runtime body.
 *
 * @param {string} src  JS source (runtime or any bundle)
 * @returns {string[]}  chunk paths/URLs in the order webpack emits them
 */
function evaluateCandidate(src, fn) {
  const { expr, param, owner } = fn;
  if (!expr || expr.length > 500_000) return [];

  const publicPath = extractPublicPath(src, expr, owner);
  const env = { __publicPath: publicPath };
  const maps = [
    ...collectInlineMaps(expr, param),
    ...collectExternalMaps(src, expr, env),
  ];
  const ids = new Set();
  for (const map of maps) {
    for (const key of Object.keys(map)) ids.add(key);
  }
  if (ids.size === 0) return [];

  const ordered = [...ids].sort(compareIds);
  const tokens = tokenize(expr);
  const usesPublic = /\.p\b/.test(expr);
  const out = new Set();

  for (const id of ordered) {
    env[param] = id;
    let value;
    try {
      value = new Parser(tokens, env).parse();
    } catch {
      continue;
    }
    if (typeof value !== 'string' || !value) continue;
    const url = usesPublic ? value : applyPublicPath(value, publicPath);
    if (out.has(url)) continue;
    out.add(url);
    if (out.size >= 1000) break;
  }
  return [...out];
}

export function extractWebpackChunkUrls(src) {
  if (typeof src !== 'string' || src.length < 16) return [];
  if (!src.includes('.u') && !src.includes('jsonpScriptSrc') && !src.includes('miniCssF')) {
    return [];
  }

  // Try every parseable candidate: decoy .u functions can appear before the
  // real runtime, and a parseable function may still have no chunk map.
  for (const fn of extractChunkFunctions(src, false).slice(0, 100)) {
    const result = evaluateCandidate(src, fn);
    if (result.length > 0) return result;
  }
  return [];
}

export const __test = {
  tokenize,
  decodeJsString,
  Parser,
  extractChunkFunction,
};
