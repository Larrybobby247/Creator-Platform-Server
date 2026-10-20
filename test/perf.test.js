import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, startApp } from './helpers.js';

let db, app, M, S, F; let n = 0;
before(async () => { db = await startDb(); if (!db) return; M = await import('../src/models/User.js'); S = await import('../src/models/Social.js'); F = await import('../src/models/Finance.js'); app = await startApp(); });
after(async () => { await app?.stop(); await db?.stop(); });
async function login(extra = {}) {
  const bcrypt = (await import('bcryptjs')).default; const name = `pf${++n}`;
  const u = await M.User.create({ username: name, email: `${name}@t.test`, passwordHash: await bcrypt.hash('password123', 4), emailVerified: true, ...extra }); await F.Wallet.create({ userId: u._id, availablePoints: 50 });
  const c = app.client(); await c('POST', '/api/auth/login', { email: `${name}@t.test`, password: 'password123' }); return { c, u };
}

test('feed pagination: cursor walks every post exactly once and ends with a null cursor', async (t) => {
  if (!db) return t.skip('install deps (npm i) to run'); const { c } = await login({ accountMode: 'CREATOR' }); const author = await M.User.create({ username: 'pfa', email: 'pfa@t.test', passwordHash: 'x', accountMode: 'CREATOR', emailVerified: true });
  await S.Post.insertMany(Array.from({ length: 45 }, (_, i) => ({ authorId: author._id, content: `p${i}`, status: 'PUBLISHED', createdAt: new Date(Date.now() - i * 1000) })));
  const seen = []; let cursor = ''; let pages = 0;
  do { const r = await c('GET', `/api/feed?tab=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); assert.equal(r.status, 200); seen.push(...r.json.posts.map((p) => p._id)); cursor = r.json.nextCursor; pages++; } while (cursor && pages < 10);
  assert.equal(seen.length, 45); assert.equal(new Set(seen).size, 45); assert.equal(pages, 3);
});
test('feed never leaks exclusive content to non-buyers and reveals it after unlock (batched access check)', async (t) => {
  if (!db) return t.skip(); const { c } = await login(); const author = await M.User.create({ username: 'pfb', email: 'pfb@t.test', passwordHash: 'x', accountMode: 'CREATOR', emailVerified: true });
  const post = await S.Post.create({ authorId: author._id, content: 'teaser-secret', exclusiveText: 'SECRET-BODY', access: 'EXCLUSIVE', unlockPricePoints: 2, status: 'PUBLISHED' });
  let r = await c('GET', `/api/feed?author=${author.id}`); const locked = r.json.posts.find((p) => p._id === post.id);
  assert.equal(locked.locked, true); assert.ok(!JSON.stringify(locked).includes('SECRET-BODY') && !JSON.stringify(locked).includes('teaser-secret'));
  assert.equal((await c('POST', `/api/media/posts/${post.id}/unlock`)).status, 200);
  r = await c('GET', `/api/feed?author=${author.id}`); const open = r.json.posts.find((p) => p._id === post.id); assert.equal(open.locked, false); assert.equal(open.exclusiveText, 'SECRET-BODY');
});
test('one user\'s cached-able responses are marked private/no-store; only the gift catalogue is publicly cacheable', async (t) => {
  if (!db) return t.skip(); const { c } = await login(); const base = app.base;
  for (const path of ['/api/points/wallet', '/api/feed', '/api/counts']) { const res = await app.real(base + path, { headers: { cookie: c.cookie() } }); assert.match(res.headers.get('cache-control'), /no-store/); assert.match(res.headers.get('vary') || '', /cookie/i); }
  const g = await app.real(base + '/api/gifts/catalogue'); assert.match(g.headers.get('cache-control'), /public/);
});
test('counts endpoint returns both badges in one response; responses carry Server-Timing', async (t) => {
  if (!db) return t.skip(); const { c } = await login(); const r = await c('GET', '/api/counts'); assert.equal(r.status, 200); assert.equal(typeof r.json.messages, 'number'); assert.equal(typeof r.json.notifications, 'number');
  const res = await app.real(app.base + '/api/health'); assert.match(res.headers.get('server-timing') || '', /total;dur=/);
});
test('chat history is paged: newest 40 first, older on request, and marking read does not need the history', async (t) => {
  if (!db) return t.skip(); const a = await login(), b = await login(); const conv = await S.Conversation.create({ participants: [a.u._id, b.u._id], accepted: true });
  await S.Message.insertMany(Array.from({ length: 55 }, (_, i) => ({ conversationId: conv._id, senderId: b.u._id, text: `m${i}`, createdAt: new Date(Date.now() - (55 - i) * 1000) })));
  const first = await a.c('GET', `/api/messages/${conv.id}`); assert.equal(first.json.messages.length, 40); assert.equal(first.json.hasMore, true); assert.equal(first.json.messages.at(-1).text, 'm54');
  const older = await a.c('GET', `/api/messages/${conv.id}?before=${encodeURIComponent(first.json.messages[0].createdAt)}`); assert.equal(older.json.messages.length, 15); assert.equal(older.json.hasMore, false);
  assert.equal((await a.c('POST', `/api/messages/${conv.id}/read`)).status, 200);
});
