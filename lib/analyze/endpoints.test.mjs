import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSource, decodeHtmlEntities } from './normalize.js';
import {
  cleanEndpoint,
  classifyPath,
  useOf,
  scanLiterals,
  quotedValues,
  directPaths,
} from './endpoints.js';

/** Build a literalAt for a value quoted inside source. */
function atOf(source, literal) {
  const index = source.indexOf(literal);
  assert.ok(index >= 0, `literal not found: ${literal}`);
  return { source, open: index - 1, close: index + literal.length };
}

test('normalizeSource decodes JS escapes and HTML entities', () => {
  assert.equal(normalizeSource('\\u002fapi\\u002fusers'), '/api/users');
  assert.equal(normalizeSource('\\u002Fapi\\u002Fusers'), '/api/users');
  assert.equal(normalizeSource('\\x2fapi\\x2fusers'), '/api/users');
  assert.equal(normalizeSource('\\/api\\/users'), '/api/users');
  assert.equal(normalizeSource('a=1&amp;b=2'), 'a=1&b=2');
  assert.equal(normalizeSource('&#47;api&#x2f;users'), '/api/users');
});

test('decodeHtmlEntities leaves unknown entities alone', () => {
  assert.equal(decodeHtmlEntities('&unknown; &amp;'), '&unknown; &');
});

test('quotedValues finds all quote styles and skips unterminated ones', () => {
  const values = quotedValues(`a "/x" b '/y' c \`/z\` d "/unterminated`);
  assert.deepEqual(values.map((v) => v.value), ['/x', '/y', '/z']);
});

test('directPaths finds quoted root and dot-relative paths', () => {
  const values = directPaths(`x("/api/users") y('./chunks/a.js') z("../up")`);
  assert.deepEqual(values.map((v) => v.value), ['/api/users', './chunks/a.js', '../up']);
});

test('scanLiterals returns both views', () => {
  const scan = scanLiterals(`fetch("/api/users"); require("./src/app.js")`);
  assert.ok(scan.quoted.some((v) => v.value === '/api/users'));
  assert.ok(scan.direct.some((v) => v.value === '/api/users'));
});

test('cleanEndpoint accepts ordinary routes', () => {
  for (const value of ['/api/users/42', '/api/users/:id', '/api/users/{id}', '/v1/users', 'users/42']) {
    assert.equal(cleanEndpoint(value, null), value, value);
  }
});

test('cleanEndpoint accepts dot-relative paths with a route gate', () => {
  assert.equal(cleanEndpoint('./api/users', null), './api/users');
});

test('cleanEndpoint rejects template placeholders and non-routes', () => {
  for (const value of [
    '/api/users/${id}',
    '#fragment',
    'data:text/plain,x',
    '/static/app.css',
    '/a/b',
    'foo/bar',
    'application/json',
    'schema.json#/$defs/User',
    'googleapis.config/foo',
    '/client_streamz/area/metric',
  ]) {
    assert.equal(cleanEndpoint(value, null), null, value);
  }
});

test('cleanEndpoint rejects module specifiers and module maps', () => {
  assert.equal(cleanEndpoint('./src/app.js', null), null);
  assert.equal(cleanEndpoint('node_modules/pkg/index.js', null), null);
  assert.equal(cleanEndpoint('./src/app.js', atOf('require("./src/app.js")', './src/app.js')), null);
  assert.equal(cleanEndpoint('./src/app.js', atOf('{ "./src/app.js": function(){} }', './src/app.js')), null);
});

test('cleanEndpoint accepts a module-looking path when a request call names it', () => {
  assert.equal(
    cleanEndpoint('./chunks/app.js', atOf('fetch("./chunks/app.js")', './chunks/app.js')),
    './chunks/app.js',
  );
});

test('useOf reads calls, imports and url properties', () => {
  assert.equal(useOf(atOf('require("./src/app.js")', './src/app.js')), 'module');
  assert.equal(useOf(atOf('import x from "./src/app.js"', './src/app.js')), 'module');
  assert.equal(useOf(atOf('fetch("/api/users")', '/api/users')), 'request');
  assert.equal(useOf(atOf('axios.post("/api/users")', '/api/users')), 'request');
  assert.equal(useOf(atOf('{ url: "/api/users" }', '/api/users')), 'request');
  assert.equal(useOf(atOf('{ endpoint: "/api/users" }', '/api/users')), 'request');
});

test('classifyPath distinguishes module maps from requests', () => {
  assert.deepEqual(classifyPath('./src/app.js', null), { use: 'unknown', module: true });
  assert.deepEqual(
    classifyPath('./chunks/app.js', atOf('fetch("./chunks/app.js")', './chunks/app.js')),
    { use: 'request', module: false },
  );
  assert.deepEqual(classifyPath('/api/users', null), { use: 'unknown', module: false });
});

test('JSON Patch paths are not endpoints', () => {
  const source = '{ op: "add", path: "/items/0/name" }';
  assert.equal(cleanEndpoint('/items/0/name', atOf(source, '/items/0/name')), null);
});

test('JSON pointer examples are not endpoints', () => {
  const source = "The JSON pointer (e.g. '/items/0/name')";
  assert.equal(cleanEndpoint('/items/0/name', atOf(source, '/items/0/name')), null);
});
