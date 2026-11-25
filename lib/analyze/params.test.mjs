import test from 'node:test';
import assert from 'node:assert/strict';

import { extractParameters, extractObjectKeys } from './params.js';
import { extractGraphQLOperations } from './graphql.js';
import { extractFiles, extractEmails } from './artifacts.js';

test('extractParameters covers query, method, HTML, body and GraphQL variables', () => {
  const source = `
    fetch('/api/users?page=1&limit=20');
    const p = new URLSearchParams();
    p.append('sort', 'name');
    <input type="text" name="email">
    JSON.stringify({ username: 'a', remember_me: true, name, description });
    query User($userId: ID!) { user { id } }
  `;
  assert.deepEqual(extractParameters(source), [
    'description', 'email', 'limit', 'name', 'page', 'remember_me',
    'sort', 'userId', 'username',
  ]);
});

test('extractParameters reads route and query params from endpoints', () => {
  assert.deepEqual(
    extractParameters('', ['/api/users/:id?expand=posts', '/v1/{org}/projects']),
    ['expand', 'id', 'org'],
  );
});

test('extractObjectKeys handles shorthand but not nested or spread entries', () => {
  assert.deepEqual(
    [...extractObjectKeys(` username: 'a', name, description, ...rest, nested: { x: 1 } `)].sort(),
    ['description', 'name', 'nested', 'username'],
  );
});

test('extractParameters does not invent query params without a value', () => {
  assert.deepEqual(extractParameters('const x = "?page"; const y = "&limit=";'), ['limit']);
});

test('extractGraphQLOperations requires a name and a selection set', () => {
  const source = `
    query GetUser($id: ID!) { user { id } }
    mutation UpdateUser @auth { update { id } }
    subscription OnEvent { event { id } }
    const query = "parameters";
    query NoSelectionSet
    fragment UserFields on User { id }
  `;
  assert.deepEqual(extractGraphQLOperations(source), [
    'mutation UpdateUser',
    'query GetUser',
    'subscription OnEvent',
  ]);
});

test('extractFiles keeps files and skips absolute URLs', () => {
  assert.deepEqual(
    extractFiles([
      '/api/export/users.csv',
      './dist/app.js',
      'https://example.com/report.pdf',
      'foo/bar.json',
      '/api/users',
      'node_modules/pkg/index.js',
    ]),
    ['./dist/app.js', '/api/export/users.csv', 'foo/bar.json', 'node_modules/pkg/index.js'],
  );
});

test('extractEmails rejects placeholders, W3C namespaces and credentials', () => {
  const source = `
    dev@corp.com security@example.com user@w3.org x@test.com
    postgres://user@db.local mongodb://admin@db.local support@company.co.uk
  `;
  assert.deepEqual(extractEmails(source), ['dev@corp.com', 'support@company.co.uk']);
});
