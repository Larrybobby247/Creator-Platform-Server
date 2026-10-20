import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveDojahConfig } from '../src/services/dojahConfig.js';
import { validateBvn, evaluateBvnValidation, DojahError } from '../src/services/dojah.js';

const cfg = { baseUrl: 'https://sandbox.dojah.io', appId: 'APP', secret: 'SECRET', timeoutMs: 1000 };
const input = { bvn: '22222222222', firstName: 'John', lastName: 'Musa', dob: '1997-05-16' };
const resp = (status, body) => async () => new Response(JSON.stringify(body), { status });
const kindOf = async (fetchImpl) => { try { await validateBvn(cfg, input, fetchImpl); return 'OK'; } catch (e) { assert.ok(e instanceof DojahError); return e.kind; } };

test('config: sandbox in development uses the sandbox host and sandbox keys', () => {
  const c = resolveDojahConfig({ NODE_ENV: 'development', DOJAH_SANDBOX_APP_ID: 'a', DOJAH_SANDBOX_SECRET_KEY: 's' });
  assert.equal(c.ok, true); assert.equal(c.baseUrl, 'https://sandbox.dojah.io'); assert.equal(c.environment, 'sandbox'); assert.equal(c.appId, 'a');
});
test('config: production uses api.dojah.io and the live keys only', () => {
  const c = resolveDojahConfig({ NODE_ENV: 'production', DOJAH_APP_ID: 'live', DOJAH_SECRET_KEY: 'liveSecret', DOJAH_SANDBOX_APP_ID: 'x', DOJAH_SANDBOX_SECRET_KEY: 'y' });
  assert.equal(c.baseUrl, 'https://api.dojah.io'); assert.equal(c.appId, 'live'); assert.equal(c.secret, 'liveSecret');
});
test('config: missing production credentials => not ok (no fallback to sandbox keys)', () => {
  const c = resolveDojahConfig({ NODE_ENV: 'production', DOJAH_SANDBOX_APP_ID: 'x', DOJAH_SANDBOX_SECRET_KEY: 'y' });
  assert.equal(c.ok, false); assert.equal(c.reason, 'MISSING_CREDENTIALS');
  assert.equal(resolveDojahConfig({ NODE_ENV: 'production', DOJAH_APP_ID: 'only-id' }).ok, false);
});
test('config: sandbox can never be selected in production', () => {
  const c = resolveDojahConfig({ NODE_ENV: 'production', DOJAH_ENV: 'sandbox', DOJAH_SANDBOX_APP_ID: 'a', DOJAH_SANDBOX_SECRET_KEY: 's' });
  assert.equal(c.ok, false); assert.equal(c.reason, 'SANDBOX_NOT_ALLOWED_IN_PRODUCTION');
});
test('config: unknown environment name is rejected', () => assert.equal(resolveDojahConfig({ NODE_ENV: 'development', DOJAH_ENV: 'staging' }).ok, false));

test('request follows the Dojah docs: GET /api/v1/kyc/bvn, AppId header, raw secret in Authorization (no Bearer)', async () => {
  let seen; await validateBvn(cfg, input, async (url, opts) => { seen = { url: new URL(url), opts }; return new Response(JSON.stringify({ entity: {} }), { status: 200 }); });
  assert.equal(seen.url.origin, 'https://sandbox.dojah.io'); assert.equal(seen.url.pathname, '/api/v1/kyc/bvn');
  assert.equal(seen.url.searchParams.get('bvn'), '22222222222'); assert.equal(seen.url.searchParams.get('first_name'), 'John'); assert.equal(seen.url.searchParams.get('dob'), '1997-05-16');
  assert.equal(seen.opts.method, 'GET'); assert.equal(seen.opts.headers.AppId, 'APP'); assert.equal(seen.opts.headers.Authorization, 'SECRET');
});
test('provider errors map to the right kinds', async () => {
  assert.equal(await kindOf(resp(400, { error: 'BVN not found' })), 'NOT_FOUND');
  assert.equal(await kindOf(resp(400, { error: 'bad param' })), 'BAD_REQUEST');
  assert.equal(await kindOf(resp(404, {})), 'NOT_FOUND');
  assert.equal(await kindOf(resp(401, {})), 'UNAUTHORIZED');
  assert.equal(await kindOf(resp(402, {})), 'INSUFFICIENT_FUNDS');
  assert.equal(await kindOf(resp(424, {})), 'UPSTREAM_UNAVAILABLE');
  assert.equal(await kindOf(resp(503, {})), 'UPSTREAM_UNAVAILABLE');
  assert.equal(await kindOf(resp(429, {})), 'RATE_LIMITED');
  assert.equal(await kindOf(async () => new Response('<html>', { status: 200 })), 'BAD_RESPONSE');
});
test('provider timeout is reported as TIMEOUT (never as success)', async () => {
  const never = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(validateBvn({ ...cfg, timeoutMs: 30 }, input, never), (e) => e instanceof DojahError && e.kind === 'TIMEOUT');
});
test('network failure is NETWORK and the error carries no BVN, URL or secret', async () => {
  const leaky = async () => { throw new TypeError('fetch failed https://sandbox.dojah.io/api/v1/kyc/bvn?bvn=22222222222 SECRET'); };
  await assert.rejects(validateBvn(cfg, input, leaky), (e) => {
    assert.equal(e.kind, 'NETWORK');
    const dump = `${e.message} ${e.stack} ${JSON.stringify(e)}`; assert.ok(!dump.includes('22222222222') && !dump.includes('SECRET') && !dump.includes('sandbox.dojah.io/api'));
    return true; });
});

const good = { entity: { bvn: { value: '2*****89012', status: true }, first_name: { confidence_value: 100, status: true }, last_name: { confidence_value: 96, status: true } } };
test('evaluate: matching identity is verified', () => { const v = evaluateBvnValidation(good); assert.equal(v.verified, true); assert.deepEqual(v.scores, { firstName: 100, lastName: 96 }); });
test('evaluate: invalid BVN, name mismatch, low confidence, missing fields, malformed body are all NOT verified', () => {
  const clone = (f) => { const c = JSON.parse(JSON.stringify(good)); f(c.entity); return c; };
  assert.equal(evaluateBvnValidation(clone((e) => { e.bvn.status = false; })).verified, false);
  assert.equal(evaluateBvnValidation(clone((e) => { e.first_name.status = false; })).verified, false);
  assert.equal(evaluateBvnValidation(clone((e) => { e.last_name.confidence_value = 40; })).verified, false);
  assert.equal(evaluateBvnValidation(clone((e) => { delete e.last_name; })).verified, false);
  assert.equal(evaluateBvnValidation(clone((e) => { e.first_name.status = 'true'; })).verified, false); // strict booleans only
  assert.equal(evaluateBvnValidation(clone((e) => { e.dob = { status: false }; })).verified, false);
  for (const bad of [null, {}, { entity: null }, { entity: 'x' }, { error: 'x' }]) assert.equal(evaluateBvnValidation(bad).verified, false);
});
test('there is no mock verification code path left in the app', () => {
  for (const f of ['routes/verification.js', 'routes/studio.js', 'services/dojah.js', 'services/dojahConfig.js', 'services/verification.js', 'config/env.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'); assert.ok(!/provider:\s*'mock'|VERIFICATION_PROVIDER/.test(src), f);
  }
  assert.ok(!readdirSync(new URL('../src/routes', import.meta.url)).some((n) => /mock/i.test(n)));
});
