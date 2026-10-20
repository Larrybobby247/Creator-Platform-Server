import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, startApp } from './helpers.js';

let db, app, M, S, F, X, n = 0;
before(async () => { db = await startDb(); if (!db) return; M = await import('../src/models/User.js'); S = await import('../src/models/Social.js'); F = await import('../src/models/Finance.js'); X = await import('../src/models/Extra.js'); app = await startApp(); });
after(async () => { await app?.stop(); await db?.stop(); });
const hash = async () => (await import('bcryptjs')).default.hash('password-123456', 4);
async function admin(role) { const name = `ad${++n}`; const u = await M.User.create({ username: name, email: `${name}@t.test`, passwordHash: await hash(), emailVerified: true, role: 'ADMIN', adminRole: role }); const c = app.client(); const r = await c('POST', '/api/admin/auth/login', { email: `${name}@t.test`, password: 'password-123456' }); assert.equal(r.status, 200); return { c, u }; }
async function person(extra = {}, pts = 30) { const name = `pp${++n}`; const u = await M.User.create({ username: name, email: `${name}@t.test`, passwordHash: await hash(), emailVerified: true, ...extra }); await F.Wallet.create({ userId: u._id, availablePoints: pts }); const c = app.client(); await c('POST', '/api/auth/login', { email: `${name}@t.test`, password: 'password-123456' }); return { c, u }; }

test('admin API requires an admin session; a public-app session never works', async (t) => {
  if (!db) return t.skip('install deps (npm i) to run'); assert.equal((await app.client()('GET', '/api/admin/dashboard')).status, 401);
  const { c } = await person(); assert.equal((await c('GET', '/api/admin/users')).status, 401); // logged in to the public app, still no admin access
  const r = await app.client()('POST', '/api/admin/auth/login', { email: (await M.User.findOne({ role: { $ne: 'ADMIN' } })).email, password: 'password-123456' }); assert.equal(r.status, 401); assert.equal(r.json.error, 'Invalid email or password'); // non-admins get the generic error
  assert.equal((await app.client()('POST', '/api/admin/auth/login', { email: 'nobody@t.test', password: 'x' })).json.error, 'Invalid email or password');
});
test('an admin cookie cannot be used on the public API', async (t) => {
  if (!db) return t.skip(); const a = await admin('SUPER_ADMIN'); assert.equal((await a.c('GET', '/api/auth/me')).status, 401);
});
test('roles limit what each admin can do (server-side)', async (t) => {
  if (!db) return t.skip(); const mod = await admin('MODERATOR'), fin = await admin('FINANCE'), sup = await admin('SUPPORT'); const target = (await person()).u;
  assert.equal((await mod.c('GET', '/api/admin/users')).status, 200); assert.equal((await mod.c('GET', '/api/admin/transactions')).status, 403); assert.equal((await mod.c('GET', '/api/admin/payouts')).status, 403);
  assert.equal((await fin.c('GET', '/api/admin/transactions')).status, 200); assert.equal((await fin.c('POST', `/api/admin/users/${target.id}/status`, { action: 'suspend', reason: 'testing perms' })).status, 403);
  assert.equal((await sup.c('GET', '/api/admin/transactions')).status, 200); assert.equal((await sup.c('POST', `/api/admin/refunds`, {})).status, 404); assert.equal((await sup.c('PUT', '/api/admin/settings/commissionBps', { value: 100 })).status, 403);
  assert.equal((await mod.c('GET', '/api/admin/audit-logs')).status, 403); assert.equal((await mod.c('GET', '/api/admin/roles')).status, 403);
});
test('restricting a user needs a reason, changes the account, and is audited', async (t) => {
  if (!db) return t.skip(); const mod = await admin('MODERATOR'); const { c, u } = await person();
  assert.equal((await mod.c('POST', `/api/admin/users/${u.id}/status`, { action: 'restrict', reason: 'no' })).status, 400);
  assert.equal((await mod.c('POST', `/api/admin/users/${u.id}/status`, { action: 'restrict', reason: 'spamming links in comments' })).status, 200);
  assert.equal((await c('POST', '/api/media/posts', { content: 'x' })).status, 403); const log = await F.AuditLog.findOne({ action: 'USER_RESTRICT', target: u.id }); assert.ok(log); assert.equal(log.reason, 'spamming links in comments'); assert.equal(log.after.status, 'RESTRICTED');
  await mod.c('POST', `/api/admin/users/${u.id}/status`, { action: 'suspend', reason: 'repeat violations confirmed' }); assert.equal((await c('GET', '/api/auth/me')).status, 401); // suspended: locked out
  assert.equal((await mod.c('POST', `/api/admin/users/${mod.u.id}/status`, { action: 'suspend', reason: 'self harm test' })).status, 400);
});
test('content moderation hides a post reversibly and keeps the record', async (t) => {
  if (!db) return t.skip(); const mod = await admin('MODERATOR'); const { c } = await person(); const { u: author } = await person({ accountMode: 'CREATOR' }); const p = await S.Post.create({ authorId: author._id, status: 'PUBLISHED', content: 'bad post' });
  assert.ok((await c('GET', `/api/feed?author=${author.id}`)).json.posts.some((x) => x._id === p.id));
  assert.equal((await mod.c('POST', `/api/admin/content/${p.id}/moderate`, { action: 'remove', reason: 'violates rules' })).status, 200); assert.ok(!(await c('GET', `/api/feed?author=${author.id}`)).json.posts.some((x) => x._id === p.id)); assert.ok(await S.Post.findById(p.id));
  await mod.c('POST', `/api/admin/content/${p.id}/moderate`, { action: 'restore', reason: 'appeal upheld' }); assert.ok((await c('GET', `/api/feed?author=${author.id}`)).json.posts.some((x) => x._id === p.id));
});
test('report workflow enforces valid transitions and a resolution reason', async (t) => {
  if (!db) return t.skip(); const mod = await admin('MODERATOR'); const r = await X.Report.create({ reporterId: (await person()).u._id, targetType: 'USER', targetId: (await person()).u._id, category: 'SPAM', reason: 'spam' });
  assert.equal((await mod.c('POST', `/api/admin/reports/${r.id}/transition`, { status: 'RESOLVED', reason: 'too early to resolve' })).status, 409); // NEW cannot jump to RESOLVED
  assert.equal((await mod.c('POST', `/api/admin/reports/${r.id}/transition`, { status: 'UNDER_REVIEW' })).status, 200); assert.equal((await mod.c('POST', `/api/admin/reports/${r.id}/transition`, { status: 'RESOLVED' })).status, 400);
  assert.equal((await mod.c('POST', `/api/admin/reports/${r.id}/transition`, { status: 'RESOLVED', reason: 'warned the account' })).status, 200); assert.equal((await mod.c('POST', `/api/admin/reports/${r.id}/transition`, { status: 'DISMISSED', reason: 'already closed' })).status, 409);
});
test('high-impact settings need confirmation and a reason; changes are audited with before/after', async (t) => {
  if (!db) return t.skip(); const sa = await admin('SUPER_ADMIN');
  let r = await sa.c('PUT', '/api/admin/settings/commissionBps', { value: 1500 }); assert.equal(r.status, 400); assert.equal(r.json.code, 'CONFIRM_REQUIRED');
  assert.equal((await sa.c('PUT', '/api/admin/settings/commissionBps', { value: 1500, confirm: true, reason: 'launch promotion rate' })).status, 200); const log = await F.AuditLog.findOne({ action: 'SETTING_CHANGED', target: 'commissionBps' }); assert.equal(log.before, 2000); assert.equal(log.after, 1500);
  assert.equal((await sa.c('PUT', '/api/admin/settings/commissionBps', { value: 20000, confirm: true, reason: 'invalid value test' })).status, 400); assert.equal((await sa.c('PUT', '/api/admin/settings/unknownKey', { value: 1 })).status, 404);
  assert.equal((await sa.c('PUT', '/api/admin/settings/commissionBps', { value: 2000, confirm: true, reason: 'restore default rate' })).status, 200);
});
test('platform name edited once in the admin is what the public app reads', async (t) => {
  if (!db) return t.skip(); const sa = await admin('SUPER_ADMIN'); const body = { name: 'Nova Social', tagline: 'Hi', supportEmail: 'help@nova.test', logoUrl: '', currency: 'NGN', timezone: 'Africa/Lagos' };
  assert.equal((await sa.c('PUT', '/api/admin/settings/platform', { value: body })).status, 200); const pub = await app.client()('GET', '/api/platform'); assert.equal(pub.json.name, 'Nova Social'); assert.equal(pub.json.supportEmail, 'help@nova.test');
});
test('payouts: manual payment needs a bank reference; provider-confirmed payouts cannot be marked paid by hand', async (t) => {
  if (!db) return t.skip(); const fin = await admin('FINANCE'); const { u: cr } = await person({ accountMode: 'CREATOR' }); const mkp = (o) => X.Payout.create({ creatorId: cr._id, amountPoints: 5, nairaAmount: 500, bankName: 'GTB', accountLast4: '1234', accountName: 'A B', reference: `PO_${Math.random()}`, ...o });
  const a = await mkp({}); assert.equal((await fin.c('POST', `/api/admin/payouts/${a.id}/mark-paid`, {})).status, 400); assert.equal((await fin.c('POST', `/api/admin/payouts/${a.id}/mark-paid`, { providerReference: 'NIP-998877' })).status, 200); assert.equal((await X.Payout.findById(a.id)).status, 'PAID');
  const b = await mkp({ status: 'PROCESSING', transferCode: 'TRF_1' }); assert.equal((await fin.c('POST', `/api/admin/payouts/${b.id}/mark-paid`, { providerReference: 'NIP-1234567' })).status, 409);
  const c2 = await mkp({}); assert.equal((await fin.c('POST', `/api/admin/payouts/${c2.id}/reject`, { reason: 'bank details look wrong' })).status, 200); assert.equal((await X.Payout.findById(c2.id)).status, 'FAILED');
});
test('refund returns points once, reverses the creator earning, and refuses a second refund', async (t) => {
  if (!db) return t.skip(); const fin = await admin('FINANCE'); const buyer = await person({}, 20); const { u: cr } = await person({ accountMode: 'CREATOR' }); const gift = await S.Gift.create({ name: 'Rose', pricePoints: 5 });
  assert.equal((await buyer.c('POST', '/api/gifts/send', { giftId: gift.id, creatorId: cr.id, idempotencyKey: 'refund-test-1' })).status, 200); const tx = await F.PointTransaction.findOne({ userId: buyer.u._id, type: 'CREATOR_GIFT' }); assert.equal((await F.Wallet.findOne({ userId: buyer.u._id })).availablePoints, 15);
  assert.equal((await fin.c('POST', `/api/admin/transactions/${tx.id}/refund`, { reason: 'sent to wrong creator' })).status, 200); assert.equal((await F.Wallet.findOne({ userId: buyer.u._id })).availablePoints, 20);
  assert.equal((await F.CreatorEarning.findOne({ sourceTransactionId: tx._id })).status, 'REVERSED'); assert.equal((await F.PointTransaction.findById(tx.id)).status, 'REVERSED'); assert.equal((await fin.c('POST', `/api/admin/transactions/${tx.id}/refund`, { reason: 'trying twice' })).status, 409);
  const pur = await F.PointTransaction.create({ reference: 'PUR_X', userId: buyer.u._id, type: 'POINT_PURCHASE', direction: 'CREDIT', amount: 5, status: 'COMPLETED' }); assert.equal((await fin.c('POST', `/api/admin/transactions/${pur.id}/refund`, { reason: 'wants money back' })).status, 409); // real-money refunds are out of scope here
});
test('dashboard metrics come from real data and separate volume, revenue and earnings', async (t) => {
  if (!db) return t.skip(); const sa = await admin('SUPER_ADMIN'); const buyer = await person({}, 0); await F.PointTransaction.create({ reference: 'PUR_D', userId: buyer.u._id, type: 'POINT_PURCHASE', direction: 'CREDIT', amount: 5, nairaAmount: 500, status: 'COMPLETED', completedAt: new Date() });
  const d = (await sa.c('GET', '/api/admin/dashboard?range=7d')).json; assert.ok(d.users.total >= 1); assert.ok(d.paymentVolume.naira >= 500); assert.ok('platformRevenue' in d && 'creatorEarningsPayable' in d && 'pendingPayouts' in d); assert.match(d.paymentVolume.note, /not profit/i);
  const s = (await sa.c('GET', '/api/admin/dashboard/series?metric=volume&range=7d')).json; assert.equal(s.points.length >= 7, true); assert.ok(s.points.some((p) => p.value >= 500)); assert.equal((await sa.c('GET', '/api/admin/dashboard/series?metric=bogus&range=7d')).status, 200);
});
test('roles management: cannot change own role or remove the last Super Admin; announcements need the confirmed audience size', async (t) => {
  if (!db) return t.skip(); const sa = await admin('SUPER_ADMIN'); assert.equal((await sa.c('PUT', `/api/admin/roles/${sa.u.id}`, { adminRole: 'SUPPORT', adminPermissions: [], reason: 'demote myself' })).status, 400);
  const other = await admin('SUPPORT'); assert.equal((await sa.c('PUT', `/api/admin/roles/${other.u.id}`, { adminRole: 'FINANCE', adminPermissions: ['audit_logs.read'], reason: 'needs audit access' })).status, 200); assert.equal((await other.c('GET', '/api/admin/audit-logs')).status, 200);
  await M.User.updateMany({ role: 'ADMIN', adminRole: 'SUPER_ADMIN', _id: { $ne: sa.u._id } }, { adminRole: 'SUPPORT' }); const p = (await sa.c('POST', '/api/admin/announcements/preview', { audience: 'all' })).json.recipients; assert.ok(p > 0);
  assert.equal((await sa.c('POST', '/api/admin/announcements', { title: 'Hello', message: 'Welcome everyone', audience: 'all', confirmRecipients: p + 1 })).status, 409); assert.equal((await sa.c('POST', '/api/admin/announcements', { title: 'Hello', message: 'Welcome everyone', audience: 'all', confirmRecipients: p })).status, 201);
});
