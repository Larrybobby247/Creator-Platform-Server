import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
let svc; try { svc = await import('../src/services/media.js'); } catch { /* deps not installed */ }
test('signed media URLs verify, expire, and reject tampering', (t) => {
  if (!svc) return t.skip('install deps (npm i) to run');
  const u = new URL(svc.signUrl('asset1', 'user1', 300)); const q = Object.fromEntries(u.searchParams);
  assert.ok(svc.verifySig('asset1', q.uid, q.exp, q.sig)); assert.equal(svc.verifySig('asset2', q.uid, q.exp, q.sig), false); assert.equal(svc.verifySig('asset1', 'other', q.exp, q.sig), false);
  const old = new URL(svc.signUrl('asset1', 'user1', -5)); assert.equal(svc.verifySig('asset1', 'user1', old.searchParams.get('exp'), old.searchParams.get('sig')), false);
});
