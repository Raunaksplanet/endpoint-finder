import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeBody } from './index.js';

test('analyzeBody returns classified endpoints and artifacts', () => {
  const body = `
    fetch('/api/users/:id?expand=posts');
    require('./src/app.js');
    const schema = 'schema.json#/$defs/User';
    <input name="email">
    JSON.stringify({ name, email });
    query GetUser($userId: ID!) { user { id } }
  `;
  const result = analyzeBody(body);

  assert.deepEqual(result.endpoints, ['/api/users/:id?expand=posts']);
  assert.deepEqual(result.parameters, ['email', 'expand', 'id', 'name', 'userId']);
  assert.deepEqual(result.graphql, ['query GetUser']);
  assert.ok(result.files.includes('./src/app.js'));
  assert.ok(result.files.includes('schema.json#/$defs/User'));
  assert.deepEqual(result.emails, []);
});

test('analyzeBody can skip parameter discovery', () => {
  const result = analyzeBody(`fetch('/api/users?page=1')`, { includeParameters: false });
  assert.deepEqual(result.endpoints, ['/api/users?page=1']);
  assert.deepEqual(result.parameters, []);
});

test('analyzeBody ignores prose and module maps', () => {
  const result = analyzeBody(`
    // The JSON pointer (e.g. '/items/0/name') is documented below.
    { './src/app.js': function(){} }
    { op: "add", path: "/items/0/name" }
  `);
  assert.deepEqual(result.endpoints, []);
});
