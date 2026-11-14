/**
 * Tests for webpack_chunks.js
 * Run: node --test webpack_chunks.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWebpackChunkUrls, applyPublicPath } from './webpack_chunks.js';

const urls = (src) => extractWebpackChunkUrls(src);

test('webpack 5 classic', () => {
  assert.deepEqual(
    urls('__webpack_require__.u = e => "static/js/" + e + "." + {0:"a1b2c3d4",1:"e5f6a7b8"}[e] + ".js";'),
    ['static/js/0.a1b2c3d4.js', 'static/js/1.e5f6a7b8.js'],
  );
});

test('single quotes', () => {
  assert.deepEqual(
    urls("r.u = e => 'js/' + e + '.' + {0:'aaaabbbb'}[e] + '.js';"),
    ['js/0.aaaabbbb.js'],
  );
});

test('prefix map + public path', () => {
  const src = 'r.u = e => "static/chunks/" + (({809:"4ad82c5e"})[e] || e)'
    + ' + "." + ({20:"35bb1bc2",809:"aa059996"})[e] + ".js";'
    + '__webpack_require__.p = "/_next/";';
  assert.deepEqual(urls(src), [
    '/_next/static/chunks/20.35bb1bc2.js',
    '/_next/static/chunks/4ad82c5e.aa059996.js',
  ]);
});

test('template literal', () => {
  assert.deepEqual(
    urls("r.u = e => `static/js/${e}.${({0:'aaaabbbb'})[e]}.js`;"),
    ['static/js/0.aaaabbbb.js'],
  );
});

test('block body', () => {
  assert.deepEqual(
    urls("r.u = (e) => { return 'js/' + e + '.' + {0:'deadbeef'}[e] + '.js'; };"),
    ['js/0.deadbeef.js'],
  );
});

test('function expression', () => {
  assert.deepEqual(
    urls('r.u = function(e) { return "js/" + e + "." + {0:"cafebabe"}[e] + ".js"; };'),
    ['js/0.cafebabe.js'],
  );
});

test('webpack 4 jsonpScriptSrc', () => {
  const src = 'function jsonpScriptSrc(e){return __webpack_require__.p+"static/js/"+(e+".")+'
    + '{"0":"abc12345"}[e]+".js"} __webpack_require__.p="/assets/";';
  assert.deepEqual(urls(src), ['/assets/static/js/0.abc12345.js']);
});

test('external map variable', () => {
  assert.deepEqual(
    urls('var t={0:"aaaabbbb",1:"ccccdddd"};r.u=e=>"js/"+t[e]+".js";'),
    ['js/aaaabbbb.js', 'js/ccccdddd.js'],
  );
});

test('function alias', () => {
  assert.deepEqual(
    urls('var build=function(e){return "js/"+e+"."+{0:"aaaabbbb"}[e]+".js"};r.u=build;'),
    ['js/0.aaaabbbb.js'],
  );
});

test('named chunks and comments', () => {
  const src = 'r.u = e => /* path */ "js/" + e + "." + {"vendors~main":"aaaabbbb"}[e] + ".js";';
  assert.deepEqual(urls(src), ['js/vendors~main.aaaabbbb.js']);
});

test('escapes', () => {
  assert.deepEqual(
    urls('r.u = e => "js\\/" + e + "." + {0:"aaaabbbb"}[e] + ".js";'),
    ['js/0.aaaabbbb.js'],
  );
});

test('ternary and nullish', () => {
  assert.deepEqual(
    urls("r.u = e => 'js/' + (null ?? (true ? e : 'x')) + '.' + {0:'aaaabbbb'}[e] + '.js';"),
    ['js/0.aaaabbbb.js'],
  );
});

test('numeric ordering', () => {
  assert.deepEqual(
    urls('r.u = e => "js/" + e + "." + {10:"bbbbbbbb",2:"aaaabbbb"}[e] + ".js";'),
    ['js/2.aaaabbbb.js', 'js/10.bbbbbbbb.js'],
  );
});

test('dedupe', () => {
  assert.deepEqual(
    urls('r.u = e => "app." + {0:"samehash",1:"samehash"}[e] + ".js";'),
    ['app.samehash.js'],
  );
});

test('no runtime / no map', () => {
  assert.deepEqual(urls('console.log("nothing")'), []);
  assert.deepEqual(urls('r.u = e => "js/" + e + ".js";'), []);
});

test('decoy .u before the real runtime', () => {
  const src = 'var s=".u = nope";var r={};r.p="/base/";'
    + 'r.u=e=>"js/"+e+"."+{0:"aaaabbbb"}[e]+".js";';
  assert.deepEqual(urls(src), ['/base/js/0.aaaabbbb.js']);
});

test('parseable decoy .u without a map before the real runtime', () => {
  const src = 'var a={};a.u=e=>"x/"+e+".js";var r={};r.p="/b/";'
    + 'r.u=e=>"js/"+e+"."+{0:"aaaabbbb"}[e]+".js";';
  assert.deepEqual(urls(src), ['/b/js/0.aaaabbbb.js']);
});

test('public path prefers the .u owner over earlier decoys', () => {
  const src = 'var q={};q.p="/wrong/";var r={};r.p="/right/";'
    + 'r.u=e=>"js/"+e+"."+{0:"aaaabbbb"}[e]+".js";';
  assert.deepEqual(urls(src), ['/right/js/0.aaaabbbb.js']);
});

test('public path helper', () => {
  assert.equal(applyPublicPath('js/a.js', 'https://cdn.x/'), 'https://cdn.x/js/a.js');
  assert.equal(applyPublicPath('/a.js', '/base/'), '/base/a.js');
  assert.equal(applyPublicPath('https://cdn.x/a.js', '/base/'), 'https://cdn.x/a.js');
});
