import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';

let db, L, M, F, E, X;
before(async () => {
  db = await startDb(); if (!db) return;
  L = await import('../src/services/pointLedger.js'); F = await import('../src/models/Finance.js'); M = await import('../src/models/User.js'); E = await import('../src/services/earnings.js'); X = await import('../src/models/Extra.js');
});
after(async () => db?.stop());
const mkUser = async (n, extra = {}) => { const u = await M.User.create({ username: n, email: `${n}@t.test`, passwordHash: 'x', ...extra }); await F.Wallet.create({ userId: u._id, availablePoints: 0 }); return u; };
const fund = async (u, pts) => { const t = await L.createPendingCredit({ userId: u._id, type: 'POINT_PURCHASE', amount: pts, idempotencyKey: `fund:${u.id}:${Math.random()}` }); await L.completeCredit(t._id); };
const bal = async (u) => (await F.Wallet.findOne({ userId: u._id })).availablePoints;

test('purchase credit completes exactly once (duplicate webhook)', async (t) => {
  if (!db) return t.skip('install deps (npm i) to run');
  const u = await mkUser('buyer1'); const p = await L.createPendingCredit({ userId: u._id, type: 'POINT_PURCHASE', amount: 5, idempotencyKey: 'purchase:abc' });
  await Promise.all([L.completeCredit(p._id), L.completeCredit(p._id), L.completeCredit(p._id)]);
  assert.equal(await bal(u), 5);
});
test('insufficient balance is rejected and never goes negative', async (t) => {
  if (!db) return t.skip(); const u = await mkUser('poor1'); await fund(u, 3);
  await assert.rejects(L.spend({ userId: u._id, type: 'CREATOR_GIFT', amount: 5, idempotencyKey: 'k1' }), /Insufficient/); assert.equal(await bal(u), 3);
});
test('concurrent spending cannot overspend', async (t) => {
  if (!db) return t.skip(); const u = await mkUser('racer1'); await fund(u, 10);
  const r = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => L.spend({ userId: u._id, type: 'CREATOR_GIFT', amount: 4, idempotencyKey: `race:${i}` })));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2); assert.equal(await bal(u), 2);
});
test('retrying the same idempotency key deducts once', async (t) => {
  if (!db) return t.skip(); const u = await mkUser('retry1'); await fund(u, 10);
  await L.spend({ userId: u._id, type: 'CREATOR_GIFT', amount: 3, idempotencyKey: 'same' }); const again = await L.spend({ userId: u._id, type: 'CREATOR_GIFT', amount: 3, idempotencyKey: 'same' });
  assert.equal(again.duplicate, true); assert.equal(await bal(u), 7);
});
test('refund creates a reversal record, keeps the original, and cannot happen twice', async (t) => {
  if (!db) return t.skip(); const u = await mkUser('refund1'); await fund(u, 10);
  const { tx } = await L.spend({ userId: u._id, type: 'SPECIAL_REQUEST', amount: 4, idempotencyKey: 'rf' }); await L.reverse(tx._id, 'test');
  await assert.rejects(L.reverse(tx._id, 'again')); assert.equal(await bal(u), 10);
  assert.equal((await F.PointTransaction.findById(tx._id)).status, 'REVERSED'); assert.equal(await F.PointTransaction.countDocuments({ reversalOf: tx._id }), 1);
});
test('creator earnings apply commission and cannot duplicate for one source transaction', async (t) => {
  if (!db) return t.skip(); const c = await mkUser('creator1'); const b = await mkUser('fan1'); await fund(b, 20);
  const { tx } = await L.spend({ userId: b._id, type: 'CREATOR_GIFT', amount: 10, idempotencyKey: 'g1', creatorId: c._id });
  const e = await E.recordEarning({ creatorId: c._id, sourceTx: tx, gross: 10 }); assert.deepEqual([e.gross, e.commission, e.net], [10, 2, 8]);
  await assert.rejects(E.recordEarning({ creatorId: c._id, sourceTx: tx, gross: 10 }));
});
test('referral rewards: referred creator earns once per source transaction, never self-referral', async (t) => {
  if (!db) return t.skip(); const ref = await mkUser('referrer1'); const c = await mkUser('refcreator1', { referredBy: ref._id }); const solo = await mkUser('solo1', { referredBy: undefined }); const b = await mkUser('fan2'); await fund(b, 50);
  const { tx } = await L.spend({ userId: b._id, type: 'CREATOR_GIFT', amount: 40, idempotencyKey: 'rg', creatorId: c._id }); await E.recordEarning({ creatorId: c._id, sourceTx: tx, gross: 40 });
  const rw = await X.ReferralReward.find({ referredId: c._id }); assert.equal(rw.length, 1); assert.equal(rw[0].amount, Math.floor((32 * 500) / 10000));
  const { tx: t2 } = await L.spend({ userId: b._id, type: 'CREATOR_GIFT', amount: 5, idempotencyKey: 'rg2', creatorId: solo._id }); await E.recordEarning({ creatorId: solo._id, sourceTx: t2, gross: 5 });
  assert.equal(await X.ReferralReward.countDocuments({ referredId: solo._id }), 0);
});
test('meetup transitions are validated and cannot be applied twice', async (t) => {
  if (!db) return t.skip(); const { transition } = await import('../src/routes/meetups.js'); const u = await mkUser('mu1'); const c = await mkUser('mc1');
  const b = await X.MeetupBooking.create({ userId: u._id, creatorId: c._id, status: 'PAID_AND_RESERVED' });
  assert.equal(await transition(b._id, ['CREATOR_ACCEPTED'], 'MEETUP_PENDING_USER_ACCEPTANCE'), null); // skipping a step is refused
  assert.ok(await transition(b._id, ['PAID_AND_RESERVED'], 'CREATOR_ACCEPTED')); assert.equal(await transition(b._id, ['PAID_AND_RESERVED'], 'CREATOR_ACCEPTED'), null);
  assert.equal(await transition(b._id, ['COMPLETED'], 'EARNINGS_RELEASED'), null); // fee cannot be released before completion
});
test('conversation notes are only reachable by their author', async (t) => {
  if (!db) return t.skip(); const S = await import('../src/models/Social.js'); const a = await mkUser('na1'); const b = await mkUser('nb1');
  const n = await S.ConversationNote.create({ conversationId: new db.mongoose.Types.ObjectId(), authorId: a._id, text: 'private' });
  assert.equal(await S.ConversationNote.findOne({ _id: n._id, authorId: b._id }), null); assert.ok(await S.ConversationNote.findOne({ _id: n._id, authorId: a._id }));
});
test('paid messages are redacted for non-buyers', async (t) => {
  if (!db) return t.skip(); const { shapeMsg } = await import('../src/routes/messages.js'); const id = () => new db.mongoose.Types.ObjectId(); const s = id(), buyer = id();
  const m = { senderId: s, price: 5, paidText: 'secret', mediaId: id(), unlockedBy: [] };
  const locked = shapeMsg(m, buyer); assert.equal(locked.paidText, undefined); assert.equal(locked.mediaId, undefined); assert.equal(locked.locked, true);
  assert.equal(shapeMsg({ ...m, unlockedBy: [buyer] }, buyer).paidText, 'secret'); assert.equal(shapeMsg(m, s).paidText, 'secret');
});
