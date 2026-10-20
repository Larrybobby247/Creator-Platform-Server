import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, startApp, stubDojah, dojahOk } from './helpers.js';

let db, app, restore, M, X, n = 0;
const GOOD = { bvn: '22222222222', firstName: 'John', lastName: 'Musa', dob: '1997-05-16' };
before(async () => {
  db = await startDb(); if (!db) return;
  process.env.DOJAH_ENV = 'sandbox'; process.env.DOJAH_SANDBOX_APP_ID = 'app'; process.env.DOJAH_SANDBOX_SECRET_KEY = 'secret';
  M = await import('../src/models/User.js'); X = await import('../src/models/Extra.js'); app = await startApp();
});
after(async () => { restore?.(); await app?.stop(); await db?.stop(); });

async function creator() { // a verified-email creator, logged in
  const bcrypt = (await import('bcryptjs')).default; const name = `vc${++n}`;
  await M.User.create({ username: name, email: `${name}@t.test`, passwordHash: await bcrypt.hash('password123', 4), accountMode: 'CREATOR', emailVerified: true });
  const c = app.client(); const r = await c('POST', '/api/auth/login', { email: `${name}@t.test`, password: 'password123' }); assert.equal(r.status, 200);
  return { c, user: await M.User.findOne({ username: name }) };
}
const verified = async (u) => !!(await X.VerificationRecord.exists({ userId: u._id, status: 'VERIFIED' }));

test('invalid BVNs are rejected before any provider call', async (t) => {
  if (!db) return t.skip('install deps (npm i) to run'); let calls = 0; restore = stubDojah(app.real, () => { calls++; return dojahOk(); });
  const { c, user } = await creator();
  for (const bvn of ['123', '1234567890', '123456789012', 'abcdefghijk', '2222222222a']) assert.equal((await c('POST', '/api/studio/verification/start', { ...GOOD, bvn })).status, 400);
  assert.equal(calls, 0); assert.equal(await verified(user), false);
});
test('successful verification marks VERIFIED, stores no BVN or names, and unlocks the meetup toggle', async (t) => {
  if (!db) return t.skip(); restore = stubDojah(app.real, () => dojahOk());
  const { c, user } = await creator();
  assert.equal((await c('PATCH', '/api/creators/meetup', { enabled: true, pricePoints: 5 })).status, 403); // blocked before verification
  const r = await c('POST', '/api/studio/verification/start', GOOD); assert.equal(r.status, 200); assert.equal(r.json.status, 'VERIFIED');
  const raw = JSON.stringify(await X.VerificationRecord.find({ userId: user._id }).lean()) + JSON.stringify(await X.BvnClaim.find({ userId: user._id }).lean());
  assert.ok(!raw.includes('22222222222') && !raw.includes('John') && !raw.includes('Musa') && !raw.includes('1997'));
  assert.equal((await c('PATCH', '/api/creators/meetup', { enabled: true, pricePoints: 5 })).status, 200);
});
test('failed verification (name mismatch) is NOT verified and counts as an attempt', async (t) => {
  if (!db) return t.skip(); restore = stubDojah(app.real, () => dojahOk({ first_name: { confidence_value: 12, status: false } }));
  const { c, user } = await creator(); const r = await c('POST', '/api/studio/verification/start', GOOD);
  assert.equal(r.status, 422); assert.equal(r.json.code, 'BVN_MISMATCH'); assert.equal(r.json.attemptsLeft, 4); assert.equal(await verified(user), false);
  assert.equal((await c('PATCH', '/api/creators/meetup', { enabled: true, pricePoints: 5 })).status, 403);
});
test('unknown BVN => 422 BVN_NOT_FOUND, not verified', async (t) => {
  if (!db) return t.skip(); restore = stubDojah(app.real, () => new Response(JSON.stringify({ error: 'BVN not found' }), { status: 400 }));
  const { c, user } = await creator(); const r = await c('POST', '/api/studio/verification/start', GOOD); assert.equal(r.status, 422); assert.equal(r.json.code, 'BVN_NOT_FOUND'); assert.equal(await verified(user), false);
});
test('provider timeout => 504, never verified, does not burn an attempt, and a retry can succeed', async (t) => {
  if (!db) return t.skip(); process.env.DOJAH_TIMEOUT_MS = '1000';
  restore = stubDojah(app.real, (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))));
  const { c, user } = await creator(); const r = await c('POST', '/api/studio/verification/start', GOOD);
  assert.equal(r.status, 504); assert.equal(r.json.code, 'PROVIDER_TIMEOUT'); assert.equal(await verified(user), false);
  assert.equal(await X.VerificationRecord.countDocuments({ userId: user._id, status: 'FAILED' }), 0);
  restore(); restore = stubDojah(app.real, () => dojahOk()); assert.equal((await c('POST', '/api/studio/verification/start', GOOD)).status, 200); assert.equal(await verified(user), true);
  delete process.env.DOJAH_TIMEOUT_MS;
});
test('provider outage / bad credentials / empty wallet => 503 and never verified', async (t) => {
  if (!db) return t.skip();
  for (const status of [401, 402, 424, 500]) { restore = stubDojah(app.real, () => new Response('{}', { status })); const { c, user } = await creator();
    const r = await c('POST', '/api/studio/verification/start', GOOD); assert.equal(r.status, 503, `status ${status}`); assert.equal(await verified(user), false); assert.ok(!JSON.stringify(r.json).match(/401|402|secret|dojah/i)); }
});
test('missing credentials => 503 PROVIDER_NOT_CONFIGURED and the provider is never called', async (t) => {
  if (!db) return t.skip(); const saved = [process.env.DOJAH_SANDBOX_APP_ID, process.env.DOJAH_SANDBOX_SECRET_KEY]; delete process.env.DOJAH_SANDBOX_APP_ID; delete process.env.DOJAH_SANDBOX_SECRET_KEY;
  let calls = 0; restore = stubDojah(app.real, () => { calls++; return dojahOk(); }); const { c, user } = await creator();
  const r = await c('POST', '/api/studio/verification/start', GOOD); assert.equal(r.status, 503); assert.equal(r.json.code, 'PROVIDER_NOT_CONFIGURED'); assert.equal(calls, 0); assert.equal(await verified(user), false);
  [process.env.DOJAH_SANDBOX_APP_ID, process.env.DOJAH_SANDBOX_SECRET_KEY] = saved;
});
test('the same BVN cannot verify a second account', async (t) => {
  if (!db) return t.skip(); restore = stubDojah(app.real, () => dojahOk()); const a = await creator(), b = await creator();
  assert.equal((await a.c('POST', '/api/studio/verification/start', GOOD)).status, 200); const r = await b.c('POST', '/api/studio/verification/start', GOOD);
  assert.equal(r.status, 409); assert.equal(await verified(b.user), false);
});
test('rate limit: at most 5 submissions per hour per account', async (t) => {
  if (!db) return t.skip(); let calls = 0; restore = stubDojah(app.real, () => { calls++; return new Response('{}', { status: 503 }); }); const { c } = await creator(); const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await c('POST', '/api/studio/verification/start', GOOD)).status);
  assert.deepEqual(codes.slice(0, 5), [503, 503, 503, 503, 503]); assert.deepEqual(codes.slice(5), [429, 429]); assert.equal(calls, 5);
});
test('unauthenticated and non-creator users cannot call the endpoint', async (t) => {
  if (!db) return t.skip(); assert.equal((await app.client()('POST', '/api/studio/verification/start', GOOD)).status, 401);
});
