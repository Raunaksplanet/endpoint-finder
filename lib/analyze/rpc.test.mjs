import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRPC } from './rpc.js';

test('extractRPC reads Twirp and gRPC-Web paths', () => {
  const result = extractRPC(`
    fetch('/twirp/pkg.v1.UserService/Get');
    fetch('/$rpc/pkg.v1.UserService/List');
    fetch('/pkg.v1.UserService/Create');
  `);
  assert.deepEqual(result.methods, [
    'pkg.v1.UserService.Create',
    'pkg.v1.UserService.Get',
    'pkg.v1.UserService.List',
  ]);
  assert.ok(result.paths.includes('/twirp/pkg.v1.UserService/Get'));
});

test('extractRPC reads quoted service/method pairs', () => {
  assert.deepEqual(
    extractRPC(`const m = "pkg.v1.UserService/Get";`).methods,
    ['pkg.v1.UserService.Get'],
  );
});

test('extractRPC reads Connect-ES descriptors', () => {
  const result = extractRPC(`
    const desc = {
      typeName: "pkg.v1.UserService",
      methods: {
        Get: { name: "Get", kind: MethodKind.Unary },
        List: { name: "List", kind: MethodKind.Unary },
      },
    };
  `);
  assert.deepEqual(result.methods, [
    'pkg.v1.UserService.Get',
    'pkg.v1.UserService.List',
  ]);
});

test('extractRPC reads JSON-RPC methods', () => {
  assert.deepEqual(
    extractRPC(`{ jsonrpc: "2.0", method: "user.get", params: {} }`).methods,
    ['user.get'],
  );
});

test('extractRPC reads dotted names only with a service-like receiver', () => {
  const result = extractRPC(`
    const a = "UserService.getUser";
    const b = "pkg.v1.AdminApi.Delete";
    const c = "Math.max";
    const d = "api.example.com";
    const e = "React.Component";
  `);
  assert.deepEqual(result.methods, [
    'UserService.getUser',
    'pkg.v1.AdminApi.Delete',
  ]);
});

test('extractRPC does not treat ordinary routes as RPC', () => {
  assert.deepEqual(extractRPC(`fetch('/api/v1/users/42')`).methods, []);
});
