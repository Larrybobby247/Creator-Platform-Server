import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, startApp } from './helpers.js';

let db, app, M, S, F, X, n = 0;
before(async () => { db = await startDb(); if (!db) return; M = await import('../src/models/User.js'); S = await import('../src/models/Social.js'); F = await import('../src/models/Finance.js'); X = await import('../src/models/Extra.js'); app = await startApp(); });
after(async () => { await app?.stop(); await db?.stop(); });
async function mk(extra = {}, points = 50) {
  const bcrypt = (await import('bcryptjs')).default; const name = `ft${++n}`;
  const u = await M.User.create({ username: name, email: `${name}@t.test`, passwordHash: await bcrypt.hash('password123', 4), emailVerified: true, ...extra }); await F.Wallet.create({ userId: u._id, availablePoints: points });
  const c = app.client(); const r = await c('POST', '/api/auth/login', { email: `${name}@t.test`, password: 'password123' }); assert.equal(r.status, 200); return { c, u };
}
const creator = (x = {}) => mk({ accountMode: 'CREATOR', creatorSince: new Date(), ...x });
const bal = async (u) => (await F.Wallet.findOne({ userId: u._id })).availablePoints;

test('anyone can post, but only creators can post exclusive/paid content', async (t) => {
  if (!db) return t.skip('install deps (npm i) to run'); const { c: user } = await mk(); const { c: cr } = await creator();
  assert.equal((await user('POST', '/api/media/posts', { content: 'hello #world' })).status, 201);
  let r = await user('POST', '/api/media/posts', { content: 'x', access: 'EXCLUSIVE', unlockPricePoints: 3 }); assert.equal(r.status, 403); assert.equal(r.json.code, 'CREATOR_ONLY');
  assert.equal((await user('POST', '/api/media/posts', { content: 'x', access: 'SUBSCRIBERS' })).status, 403);
  assert.equal((await user('POST', '/api/media/posts', { content: 'x', unlockPricePoints: 5 })).status, 403);
  assert.equal((await cr('POST', '/api/media/posts', { content: 'paid', access: 'EXCLUSIVE', unlockPricePoints: 3 })).status, 201);
});
test('any price is allowed; free plan is capped at 50 exclusive posts, Pro is unlimited', async (t) => {
  if (!db) return t.skip(); const { c: d, u } = await creator(); const { c: p, u: pu } = await creator({ creatorPlan: 'PRO' });
  assert.equal((await d('POST', '/api/media/posts', { content: 'x', access: 'EXCLUSIVE', unlockPricePoints: 500 })).status, 201);
  assert.equal((await d('PATCH', '/api/creators/settings', { subscriptionPricePoints: 50 })).status, 200);
  const { Post } = await import('../src/models/Social.js');
  await Post.insertMany(Array.from({ length: 49 }, () => ({ authorId: u._id, content: 'x', access: 'EXCLUSIVE', unlockPricePoints: 2, status: 'PUBLISHED' })));
  const r = await d('POST', '/api/media/posts', { content: 'x', access: 'EXCLUSIVE', unlockPricePoints: 2 }); assert.equal(r.status, 403); assert.equal(r.json.code, 'PLAN_LIMIT');
  await Post.insertMany(Array.from({ length: 60 }, () => ({ authorId: pu._id, content: 'x', access: 'EXCLUSIVE', unlockPricePoints: 2, status: 'PUBLISHED' })));
  assert.equal((await p('POST', '/api/media/posts', { content: 'x', access: 'EXCLUSIVE', unlockPricePoints: 2 })).status, 201);
});
test('pinning respects the plan limit and creators can pin exclusive posts', async (t) => {
  if (!db) return t.skip(); const { c, u } = await creator(); const mkp = (o) => S.Post.create({ authorId: u._id, status: 'PUBLISHED', content: 'p', ...o });
  const a = await mkp({}), b = await mkp({ access: 'EXCLUSIVE', unlockPricePoints: 2 });
  assert.equal((await c('POST', `/api/media/posts/${b.id}/pin`)).json.pinned, true); // exclusive is pinnable by creators
  const r = await c('POST', `/api/media/posts/${a.id}/pin`); assert.equal(r.status, 409); assert.equal(r.json.code, 'PIN_LIMIT');
  assert.equal((await c('POST', `/api/media/posts/${b.id}/pin`)).json.pinned, false); assert.equal((await c('POST', `/api/media/posts/${a.id}/pin`)).json.pinned, true);
  const feed = await c('GET', `/api/feed?author=${u.id}`); assert.equal(feed.json.posts[0]._id, a.id); assert.equal(feed.json.posts[0].pinned, true); // pinned leads the profile
});
test('editing and deleting: owners only; posts with buyers cannot be deleted', async (t) => {
  if (!db) return t.skip(); const { c, u } = await creator(); const { c: other } = await mk(); const buyer = await mk({}, 20);
  const p = await S.Post.create({ authorId: u._id, status: 'PUBLISHED', content: 'old', access: 'EXCLUSIVE', unlockPricePoints: 2 });
  assert.equal((await other('PATCH', `/api/media/posts/${p.id}`, { content: 'hacked' })).status, 404); assert.equal((await c('PATCH', `/api/media/posts/${p.id}`, { content: 'new' })).status, 200);
  await buyer.c('POST', `/api/media/posts/${p.id}/unlock`); const r = await c('DELETE', `/api/media/posts/${p.id}`); assert.equal(r.status, 409); assert.equal(r.json.code, 'HAS_BUYERS');
  const free = await S.Post.create({ authorId: u._id, status: 'PUBLISHED', content: 'free' }); assert.equal((await c('DELETE', `/api/media/posts/${free.id}`)).status, 200);
});
test('threaded comments: reply, like toggle, delete permissions', async (t) => {
  if (!db) return t.skip(); const { c: owner, u: ou } = await creator(); const { c: fan } = await mk(); const { c: stranger } = await mk(); const p = await S.Post.create({ authorId: ou._id, status: 'PUBLISHED', content: 'hi' });
  const top = (await fan('POST', `/api/posts/${p.id}/comments`, { text: 'first' })).json.comment; assert.equal(top.text, 'first');
  const rep = (await owner('POST', `/api/posts/${p.id}/comments`, { text: 'thanks!', parentId: top._id })).json.comment; assert.equal(rep.parentId, top._id);
  const lst = await fan('GET', `/api/posts/${p.id}/comments`); assert.equal(lst.json.comments[0].replyCount, 1);
  assert.equal((await fan('GET', `/api/posts/${p.id}/comments?parent=${top._id}`)).json.comments.length, 1);
  assert.equal((await owner('POST', `/api/comments/${top._id}/like`)).json.liked, true); assert.equal((await owner('POST', `/api/comments/${top._id}/like`)).json.liked, false);
  assert.equal((await stranger('DELETE', `/api/comments/${top._id}`)).status, 403); assert.equal((await owner('DELETE', `/api/comments/${top._id}`)).status, 200); // the post's author may remove comments
});
test('creator message policy: subscribers-only and pay-to-message', async (t) => {
  if (!db) return t.skip(); const sub = await creator({ dmPolicy: { mode: 'SUBSCRIBERS' } }); const fan = await mk(); const cr = await creator({ dmPolicy: { mode: 'PAID', pricePoints: 3 } });
  let r = await fan.c('POST', '/api/messages', { toUserId: sub.u.id, text: 'hi' }); assert.equal(r.status, 403); assert.equal(r.json.code, 'DM_SUBSCRIBERS_ONLY');
  await X.Subscription.create({ subscriberId: fan.u._id, creatorId: sub.u._id, status: 'ACTIVE', expiresAt: new Date(Date.now() + 864e5), pricePoints: 1 }); assert.equal((await fan.c('POST', '/api/messages', { toUserId: sub.u.id, text: 'hi' })).status, 201);
  r = await fan.c('POST', '/api/messages', { toUserId: cr.u.id, text: 'hello' }); assert.equal(r.status, 402); assert.equal(r.json.code, 'DM_PAYMENT_REQUIRED'); assert.equal(r.json.extra.price, 3);
  const before = await bal(fan.u); assert.equal((await fan.c('POST', '/api/messages/dm-access', { toUserId: cr.u.id })).status, 200); assert.equal(await bal(fan.u), before - 3);
  assert.equal((await fan.c('POST', '/api/messages/dm-access', { toUserId: cr.u.id })).json.already, true); assert.equal(await bal(fan.u), before - 3); // no double charge
  assert.equal((await fan.c('POST', '/api/messages', { toUserId: cr.u.id, text: 'hello' })).status, 201); assert.equal(await F.CreatorEarning.countDocuments({ creatorId: cr.u._id }), 1);
  const poor = await mk({}, 0); assert.equal((await poor.c('POST', '/api/messages/dm-access', { toUserId: cr.u.id })).status, 402);
});
test('regular users cannot set prices, special request settings or message policy', async (t) => {
  if (!db) return t.skip(); const { c } = await mk();
  assert.equal((await c('PATCH', '/api/me/dm', { mode: 'PAID', pricePoints: 2 })).status, 403); assert.equal((await c('PATCH', '/api/creators/request-settings', { enabled: true, minPricePoints: 5, turnaroundDays: 3 })).status, 403);
  assert.equal((await c('PATCH', '/api/creators/settings', { subscriptionPricePoints: 2 })).status, 403); assert.equal((await c('POST', '/api/communities', { name: 'Paid club', accessFeePoints: 3 })).status, 403);
});
test('special requests honour the creator\'s minimum price and on/off switch', async (t) => {
  if (!db) return t.skip(); const cr = await creator({ requestSettings: { enabled: true, minPricePoints: 5, turnaroundDays: 3 } }); const fan = await mk();
  let r = await fan.c('POST', '/api/requests', { creatorId: cr.u.id, description: 'a long enough description', offerPoints: 3 }); assert.equal(r.status, 400); assert.equal(r.json.code, 'BELOW_MINIMUM');
  assert.equal((await fan.c('POST', '/api/requests', { creatorId: cr.u.id, description: 'a long enough description', offerPoints: 5 })).status, 201);
  await M.User.updateOne({ _id: cr.u._id }, { 'requestSettings.enabled': false }); r = await fan.c('POST', '/api/requests', { creatorId: cr.u.id, description: 'a long enough description', offerPoints: 9 }); assert.equal(r.json.code, 'REQUESTS_OFF');
});
test('statuses: visible to followers, suggested to others, gone after 24h', async (t) => {
  if (!db) return t.skip(); const a = await mk(); const fol = await mk(); const other = await mk(); await X.Follow.create({ followerId: fol.u._id, followeeId: a.u._id });
  assert.equal((await a.c('POST', '/api/stories', { text: 'hello world' })).status, 201); // a text-only status
  assert.equal((await a.c('POST', '/api/stories', {})).status, 400); // needs a photo, a video or some text
  await X.Story.create({ authorId: a.u._id, type: 'TEXT', text: 'live', bg: 'violet', expiresAt: new Date(Date.now() + 36e5) }); await X.Story.create({ authorId: a.u._id, type: 'TEXT', text: 'old', expiresAt: new Date(Date.now() - 36e5) });
  const f = await fol.c('GET', '/api/stories'); assert.equal(f.json.groups[0].source, 'following'); assert.equal(f.json.groups[0].stories.length, 2); // 'hello world' + 'live' (the expired one is excluded)
  const o = await other.c('GET', '/api/stories'); assert.equal(o.json.groups.find((g) => g.user._id === a.u.id)?.source, 'suggested');
  await X.Block.create({ blockerId: a.u._id, blockedId: fol.u._id }); assert.equal((await fol.c('GET', `/api/stories/user/${a.u.id}`)).json.group, null);
});
test('username change: unique and rate-limited to once per 7 days', async (t) => {
  if (!db) return t.skip(); const a = await mk(); const b = await mk();
  assert.equal((await a.c('PATCH', '/api/me/username', { username: b.u.username })).status, 409); assert.equal((await a.c('PATCH', '/api/me/username', { username: 'fresh_name_1' })).status, 200);
  const r = await a.c('PATCH', '/api/me/username', { username: 'fresh_name_2' }); assert.equal(r.status, 429); assert.equal(r.json.code, 'USERNAME_COOLDOWN');
});
test('age must be 18+ (sign-up and profile)', async (t) => {
  if (!db) return t.skip(); const c = app.client(); assert.equal((await c('POST', '/api/auth/register', { username: 'kid_user', email: 'kid@t.test', password: 'password123', acceptTerms: true, age: 15 })).status, 400);
  const a = await mk(); assert.equal((await a.c('PATCH', '/api/me', { age: 17 })).status, 400); assert.equal((await a.c('PATCH', '/api/me', { age: 25, gender: 'FEMALE' })).status, 200);
});
test('points can be bought in any amount from 1 up to the configured maximum', async (t) => {
  if (!db) return t.skip(); const a = await mk({}, 0);
  assert.equal((await a.c('POST', '/api/points/purchase', { points: 0 })).status, 400); assert.equal((await a.c('POST', '/api/points/purchase', { points: 1.5 })).status, 400); assert.equal((await a.c('POST', '/api/points/purchase', { points: 10001 })).status, 400);
  const r = await a.c('POST', '/api/points/purchase', { points: 3 }); assert.equal(r.status, 200); assert.equal(r.json.naira, 300);
  assert.equal((await a.c('POST', `/api/points/purchase/${r.json.reference}/mock-pay`)).status, 200); assert.equal(await bal(a.u), 3);
});
test('restricted accounts cannot post, comment or message, but can still read', async (t) => {
  if (!db) return t.skip(); const a = await mk({ accountStatus: 'RESTRICTED' }); const b = await mk();
  for (const [m, p, body] of [['POST', '/api/media/posts', { content: 'x' }], ['POST', '/api/messages', { toUserId: b.u.id, text: 'x' }]]) { const r = await a.c(m, p, body); assert.equal(r.status, 403); assert.equal(r.json.code, 'ACCOUNT_RESTRICTED'); }
  assert.equal((await a.c('GET', '/api/feed')).status, 200);
});
test('message categories: custom labels filter conversations; Subscribers is creator-only', async (t) => {
  if (!db) return t.skip(); const a = await mk(); const b = await mk(); const conv = await S.Conversation.create({ participants: [a.u._id, b.u._id], accepted: true, lastMessageAt: new Date() });
  const lab = (await a.c('POST', '/api/messages/labels', { name: 'Work' })).json; assert.equal((await a.c('POST', '/api/messages/labels', { name: 'work' })).status, 409);
  assert.equal((await a.c('GET', `/api/messages/conversations?category=label:${lab._id}`)).json.items.length, 0); assert.equal((await a.c('POST', `/api/messages/${conv.id}/label`, { labelId: lab._id, on: true })).status, 200);
  assert.equal((await a.c('GET', `/api/messages/conversations?category=label:${lab._id}`)).json.items.length, 1); assert.equal((await b.c('GET', `/api/messages/conversations?category=label:${lab._id}`)).json.items.length, 0); // labels are private to their owner
  assert.deepEqual((await a.c('GET', '/api/messages/conversations?category=subscribers')).json.items, []);
});
test('hashtags become trending topics and searchable', async (t) => {
  if (!db) return t.skip(); const { c, u } = await mk(); await S.Post.create({ authorId: u._id, status: 'PUBLISHED', content: 'big night #afrobeats #lagos' });
  const tr = await c('GET', '/api/trending'); assert.ok(Array.isArray(tr.json.topics)); const s = await c('GET', '/api/search?q=afro'); assert.ok(s.json.topics.some((x) => x.tag === 'afrobeats'));
  assert.ok((await c('GET', '/api/feed?tag=afrobeats')).json.posts.length >= 1);
});
test('advanced analytics are Pro-only on the server', async (t) => {
  if (!db) return t.skip(); const d = await creator(); const p = await creator({ creatorPlan: 'PRO' }); const u = await mk();
  const r = await d.c('GET', '/api/insights/advanced'); assert.equal(r.status, 403); assert.equal(r.json.code, 'PRO_REQUIRED'); assert.equal((await p.c('GET', '/api/insights/advanced')).status, 200); assert.equal((await u.c('GET', '/api/insights/advanced')).status, 403);
  assert.equal((await u.c('GET', '/api/insights/posts')).status, 200); // basic post analytics exist for everyone
});
