import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, startApp } from './helpers.js';

let db, app, M, outbox;
before(async () => { db = await startDb(); if (!db) return; M = await import('../src/models/User.js'); outbox = (await import('../src/services/push.js')).testOutbox; app = await startApp(); });
after(async () => { await app?.stop(); await db?.stop(); });
const signup = (c, name) => c('POST', '/api/auth/register', { username: name, email: `${name}@t.test`, password: 'password123', acceptTerms: true });
const tokenFor = (name) => new URL(outbox.filter((m) => m.to === `${name}@t.test`).at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');

test('registration sends a link, creates no session, and login is refused until verified', async (t) => {
  if (!db) return t.skip('install deps (npm i) to run'); const c = app.client(); const r = await signup(c, 'ev1');
  assert.equal(r.status, 201); assert.equal(r.json.pendingVerification, true); assert.equal((await c('GET', '/api/auth/me')).status, 401);
  const l = await c('POST', '/api/auth/login', { email: 'ev1@t.test', password: 'password123' }); assert.equal(l.status, 403); assert.equal(l.json.code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await c('GET', '/api/auth/me')).status, 401);
});
test('wrong password still reads as invalid credentials (no account enumeration)', async (t) => {
  if (!db) return t.skip(); const c = app.client(); await signup(c, 'ev2'); const l = await c('POST', '/api/auth/login', { email: 'ev2@t.test', password: 'wrong-password' }); assert.equal(l.status, 401);
});
test('valid link verifies once, then login works; the link cannot be reused', async (t) => {
  if (!db) return t.skip(); const c = app.client(); await signup(c, 'ev3'); const token = tokenFor('ev3');
  assert.equal((await c('POST', '/api/auth/verify-email', { token })).status, 200);
  assert.equal((await c('POST', '/api/auth/login', { email: 'ev3@t.test', password: 'password123' })).status, 200); assert.equal((await c('GET', '/api/auth/me')).status, 200);
  assert.equal((await c('POST', '/api/auth/verify-email', { token })).status, 400);
});
test('expired and forged tokens are rejected', async (t) => {
  if (!db) return t.skip(); const c = app.client(); await signup(c, 'ev4'); const token = tokenFor('ev4');
  await M.User.updateOne({ username: 'ev4' }, { emailVerifyExpires: new Date(Date.now() - 1000) }); assert.equal((await c('POST', '/api/auth/verify-email', { token })).status, 400);
  assert.equal((await c('POST', '/api/auth/verify-email', { token: 'a'.repeat(64) })).status, 400);
  assert.equal((await M.User.findOne({ username: 'ev4' })).emailVerified, false);
});
test('resend: new link works, 60s cooldown, same answer for unknown emails', async (t) => {
  if (!db) return t.skip(); const c = app.client(); await signup(c, 'ev5'); const first = outbox.filter((m) => m.to === 'ev5@t.test').length;
  assert.equal((await c('POST', '/api/auth/resend-verification', { email: 'ev5@t.test' })).status, 200); assert.equal(outbox.filter((m) => m.to === 'ev5@t.test').length, first); // cooldown
  await M.User.updateOne({ username: 'ev5' }, { emailVerifySentAt: new Date(Date.now() - 61e3) });
  await c('POST', '/api/auth/resend-verification', { email: 'ev5@t.test' }); assert.equal(outbox.filter((m) => m.to === 'ev5@t.test').length, first + 1);
  assert.equal((await c('POST', '/api/auth/verify-email', { token: tokenFor('ev5') })).status, 200);
  assert.equal((await c('POST', '/api/auth/resend-verification', { email: 'nobody@t.test' })).status, 200);
});
test('an unverified account cannot use the API even with a validly signed token', async (t) => {
  if (!db) return t.skip(); const jwt = (await import('jsonwebtoken')).default; const u = await M.User.create({ username: 'ev6', email: 'ev6@t.test', passwordHash: 'x' });
  const c = app.client(); const r = await c('GET', '/api/auth/me', undefined, { cookie: `token=${jwt.sign({ sub: u.id }, process.env.JWT_SECRET)}` });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'EMAIL_NOT_VERIFIED');
});
