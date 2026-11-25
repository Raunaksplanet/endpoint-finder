/**
 * RPC recognizers — a compact JS port of JSHound's four evidence-gated passes.
 *
 * Covered:
 *   - Twirp / gRPC-Web paths:  /twirp/pkg.Service/Method, /$rpc/pkg.Service/Method
 *   - Connect-ES descriptors:  typeName: "pkg.Service" + methods: { name: "Get" }
 *   - JSON-RPC:                { jsonrpc: "2.0", method: "user.get" }
 *   - Dotted names:            "UserService.getUser" (service-like receiver only)
 *
 * Not covered: service-stub registration (`this.get = register(this, "getFoo")`)
 * and wire-id pairing; those need the helper body and are left for a later pass.
 */

const PLATFORM_GLOBALS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
  'Promise', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'Reflect', 'Proxy', 'Intl', 'console', 'window', 'document', 'globalThis',
  'process', 'Buffer', 'fs', 'path', 'util', 'crypto', 'http', 'https', 'net',
  'os', 'child_process', 'React', 'Vue', 'Angular', 'jQuery', 'axios', 'lodash',
]);

const SERVICE_LIKE = /(?:Service|Api|API|Rpc|RPC)$/;
const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PATH_RPC = /(?:\/(?:\$rpc|twirp)\/|\/)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\/([A-Z]\w*)/g;
const QUOTED_RPC = /["'`]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\/([A-Z]\w*)["'`]/g;
const TYPE_NAME = /typeName\s*:\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)["']/g;
const METHODS_BLOCK = /methods\s*:\s*\{/g;
const METHOD_NAME_FIELD = /name\s*:\s*["']([A-Za-z_]\w*)["']/g;
const JSON_RPC = /jsonrpc\s*:\s*["']2\.0["'][\s\S]{0,500}?method\s*:\s*["']([^"']+)["']/g;
const DOTTED = /["'`]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)["'`]/g;

function isServiceLike(service) {
  if (!service || PLATFORM_GLOBALS.has(service)) return false;
  if (SERVICE_LIKE.test(service)) return true;
  return service.split('.').length >= 3; // pkg.v1.Service
}

function balancedBlock(source, openBrace) {
  let depth = 0;
  let quote = null;
  for (let i = openBrace; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  return '';
}

/**
 * @param {string} source
 * @returns {{methods: string[], paths: string[]}}
 */
export function extractRPC(source) {
  if (!source || source.length < 8) return { methods: [], paths: [] };
  const methods = new Set();
  const paths = new Set();

  // 1. Path-style RPC.
  for (const match of source.matchAll(PATH_RPC)) {
    const [, service, method] = match;
    if (!isServiceLike(service)) continue;
    methods.add(`${service}.${method}`);
    paths.add(match[0]);
  }
  for (const match of source.matchAll(QUOTED_RPC)) {
    const [, service, method] = match;
    if (!isServiceLike(service)) continue;
    methods.add(`${service}.${method}`);
  }

  // 2. Connect-ES descriptors: pair a typeName with the methods block after it.
  for (const match of source.matchAll(TYPE_NAME)) {
    const service = match[1];
    if (!isServiceLike(service)) continue;
    METHODS_BLOCK.lastIndex = match.index + match[0].length;
    const block = METHODS_BLOCK.exec(source);
    if (!block || block.index - match.index > 4000) continue;
    const body = balancedBlock(source, block.index + block[0].length - 1);
    if (!body) continue;
    for (const name of body.matchAll(METHOD_NAME_FIELD)) {
      methods.add(`${service}.${name[1]}`);
    }
  }

  // 3. JSON-RPC.
  for (const match of source.matchAll(JSON_RPC)) {
    const method = match[1];
    if (METHOD_NAME.test(method) || /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(method)) {
      methods.add(method);
    }
  }

  // 4. Dotted names, only with a service-like receiver.
  for (const match of source.matchAll(DOTTED)) {
    const value = match[1];
    const dot = value.lastIndexOf('.');
    if (dot <= 0) continue;
    const service = value.slice(0, dot);
    const method = value.slice(dot + 1);
    if (!isServiceLike(service) || !METHOD_NAME.test(method)) continue;
    methods.add(`${service}.${method}`);
  }

  return { methods: [...methods].sort(), paths: [...paths].sort() };
}
