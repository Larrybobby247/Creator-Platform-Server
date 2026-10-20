import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { Post, GiftTransaction } from '../../models/Social.js';
import { PointTransaction, CreatorEarning } from '../../models/Finance.js';
import { Payout, PointPackage, Subscription, ReferralReward, Promotion, WebhookLog } from '../../models/Extra.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { requirePermission as need } from '../../services/rbac.js';
import { audit } from '../../services/audit.js';
import { paged, rx, isId, dateRange } from '../../services/adminList.js';
import { reverse } from '../../services/pointLedger.js';
import { getSetting } from '../../services/settings.js';
import { notify } from '../../services/notify.js';
import { credit_ } from '../../jobs/helpers.js';
import { earningsSummary } from '../studio.js';
import { env } from '../../config/env.js';
import * as provider from '../../services/paymentProvider.js';

const r = Router();
const reason = z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500);
const uid = async (q) => (q ? (isId(q) ? [q] : (await User.find({ $or: [{ username: rx(q) }, { email: rx(q) }] }).limit(30).select('_id').lean()).map((u) => u._id)) : null);

// ================= transactions (read-only ledger) =================
r.get('/transactions', need('transactions.read'), asyncHandler(async (req, res) => {
  const f = {}; const { type, status, user, creator, q } = req.query; if (type) f.type = String(type); if (status) f.status = String(status); Object.assign(f, dateRange(req));
  if (user) f.userId = { $in: await uid(String(user)) }; if (creator) f.creatorId = { $in: await uid(String(creator)) };
  if (q) f.$or = [{ reference: rx(String(q)) }, { idempotencyKey: rx(String(q)) }, ...(isId(String(q)) ? [{ _id: q }] : [])];
  const out = await paged(PointTransaction, f, req, { sortable: ['createdAt', 'amount', 'status'], select: 'reference userId creatorId type direction amount nairaAmount nairaPerPointAtTime status createdAt completedAt idempotencyKey', populate: [['userId', 'username'], ['creatorId', 'username']] });
  const fees = await CreatorEarning.find({ sourceTransactionId: { $in: out.items.map((t) => t._id) } }).select('sourceTransactionId commission net').lean(); const F = Object.fromEntries(fees.map((x) => [String(x.sourceTransactionId), x]));
  out.items = out.items.map(({ idempotencyKey, ...t }) => ({ ...t, currency: 'NGN', provider: t.type === 'POINT_PURCHASE' ? env.paymentProvider : 'in-app', externalRef: t.type === 'POINT_PURCHASE' ? String(idempotencyKey || '').replace('purchase:', '') : undefined,
    grossNaira: t.nairaAmount ?? t.amount * (t.nairaPerPointAtTime || 100), feePoints: F[String(t._id)]?.commission, netPoints: F[String(t._id)]?.net })); res.json(out);
}));
r.get('/transactions/:id', need('transactions.read'), asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(400, 'Bad id');
  const t = await PointTransaction.findById(req.params.id).populate('userId creatorId', 'username displayName').lean(); if (!t) throw new ApiError(404, 'Not found');
  const ref = String(t.idempotencyKey || '').startsWith('purchase:') ? t.idempotencyKey.slice(9) : null;
  const [reversals, earning, gift, post, hooks] = await Promise.all([PointTransaction.find({ reversalOf: t._id }).select('reference amount status createdAt meta').lean(), CreatorEarning.findOne({ sourceTransactionId: t._id }).lean(), GiftTransaction.findOne({ transactionId: t._id }).lean(),
    t.type === 'EXCLUSIVE_CONTENT_UNLOCK' && t.relatedId ? Post.findById(t.relatedId).select('content access').lean() : null, ref ? WebhookLog.find({ reference: ref }).sort('createdAt').lean() : []]);
  const { meta, idempotencyKey, ...tx } = t;
  const timeline = [{ at: t.createdAt, event: 'Created' }, ...(t.completedAt ? [{ at: t.completedAt, event: `Completed (${t.status === 'REVERSED' ? 'later reversed' : 'final'})` }] : []), ...reversals.map((x) => ({ at: x.createdAt, event: `Reversal ${x.reference}` })), ...hooks.map((h) => ({ at: h.createdAt, event: `Webhook ${h.event}: ${h.ok ? 'processed' : 'FAILED'}` }))].sort((a, b) => new Date(a.at) - new Date(b.at));
  res.json({ transaction: { ...tx, currency: 'NGN', provider: t.type === 'POINT_PURCHASE' ? env.paymentProvider : 'in-app', externalRef: ref }, reversals, earning, gift, post, webhooks: hooks, timeline,
    reconciliation: t.type !== 'POINT_PURCHASE' ? 'N/A (in-app)' : t.status !== 'COMPLETED' ? t.status : env.paymentProvider === 'mock' ? 'UNVERIFIED (test provider)' : hooks.some((h) => h.ok) ? 'MATCHED (webhook processed)' : 'VERIFIED BY SERVER (no webhook logged)' });
}));

// ================= refunds =================
const REFUNDABLE = ['CREATOR_GIFT', 'EXCLUSIVE_CONTENT_UNLOCK', 'CREATOR_SUBSCRIPTION', 'PAID_MESSAGE', 'COMMUNITY_ACCESS', 'PRO_PLAN', 'PROMOTION_PURCHASE', 'SPECIAL_REQUEST'];
r.get('/refunds', need('transactions.read'), asyncHandler(async (req, res) => {
  const out = await paged(PointTransaction, { type: 'REVERSAL', ...dateRange(req) }, req, { sortable: ['createdAt', 'amount'], select: 'reference userId amount status reversalOf createdAt completedAt meta', populate: [['userId', 'username'], ['reversalOf', 'reference type amount createdAt']] });
  out.items = out.items.map(({ meta, ...x }) => ({ ...x, reason: meta?.reason })); res.json(out);
}));
// Refund a completed in-app purchase back to the buyer's points. Money paid to buy points cannot be refunded here (needs the payment provider's refund API, not integrated).
r.post('/transactions/:id/refund', need('refunds.manage'), asyncHandler(async (req, res) => {
  const { reason: why } = z.object({ reason }).parse(req.body);
  const t = await PointTransaction.findById(req.params.id); if (!t) throw new ApiError(404, 'Not found');
  if (t.direction !== 'DEBIT' || t.status !== 'COMPLETED' || !REFUNDABLE.includes(t.type)) throw new ApiError(409, 'This transaction type or state cannot be refunded here. Point purchases need a provider refund; meetups use the dispute workflow.');
  const e = await CreatorEarning.findOne({ sourceTransactionId: t._id });
  if (e) { // the creator was credited: only refund if that money has not been withdrawn or locked
    if (e.status !== 'AVAILABLE') throw new ApiError(409, 'The creator earning for this purchase is no longer available (already paid out or held). Resolve with the creator first.');
    const { availableToWithdraw } = await earningsSummary(t.creatorId); if (availableToWithdraw < e.net) throw new ApiError(409, 'The creator has already requested or received this money, so it cannot be clawed back automatically.');
    await CreatorEarning.updateOne({ _id: e._id, status: 'AVAILABLE' }, { status: 'REVERSED' }); await ReferralReward.updateMany({ sourceTransactionId: t._id, status: 'PENDING' }, { status: 'REJECTED', reviewReason: 'source refunded' });
  }
  const rev = await reverse(t._id, why);
  if (t.type === 'CREATOR_GIFT') await GiftTransaction.updateOne({ transactionId: t._id }, { status: 'REFUNDED' });
  if (t.type === 'PROMOTION_PURCHASE') await Promotion.updateMany({ paymentTxId: t._id, status: { $in: ['ACTIVE', 'PAUSED'] } }, { status: 'REFUNDED' });
  if (t.type === 'CREATOR_SUBSCRIPTION') await Subscription.updateMany({ subscriberId: t.userId, creatorId: t.creatorId }, { status: 'EXPIRED', expiresAt: new Date() });
  await audit(req, 'TRANSACTION_REFUNDED', t.id, { reason: why, after: { reversal: rev.reference, points: t.amount } }); await notify(t.userId, 'PAYMENT', `${t.amount} points were refunded to your wallet`, '/wallet'); res.json({ ok: true, reversal: rev.reference });
}));

// ================= point packages =================
const pkgBody = z.object({ name: z.string().trim().min(2).max(40), points: z.number().int().min(1).max(100000), bonusPoints: z.number().int().min(0).max(100000).default(0), active: z.boolean().default(true), order: z.number().int().min(0).max(1000).default(0) });
r.get('/packages', need('packages.manage'), asyncHandler(async (_q, res) => { const rate = await getSetting('nairaPerPoint'); const items = await PointPackage.find().sort({ order: 1, points: 1 }).lean(); res.json({ nairaPerPoint: rate, items: items.map((p) => ({ ...p, priceNaira: p.points * rate })) }); }));
r.post('/packages', need('packages.manage'), asyncHandler(async (req, res) => { const b = pkgBody.parse(req.body); const p = await PointPackage.create(b); await audit(req, 'PACKAGE_CREATED', p.id, { after: b }); res.status(201).json(p); }));
r.patch('/packages/:id', need('packages.manage'), asyncHandler(async (req, res) => { const b = pkgBody.partial().parse(req.body); const p = await PointPackage.findById(req.params.id); if (!p) throw new ApiError(404, 'Not found'); const before = p.toObject(); Object.assign(p, b); await p.save(); await audit(req, 'PACKAGE_UPDATED', p.id, { before: { name: before.name, points: before.points, bonusPoints: before.bonusPoints, active: before.active }, after: b }); res.json(p); })); // existing purchases keep their recorded values
r.delete('/packages/:id', need('packages.manage'), asyncHandler(async (req, res) => { const p = await PointPackage.findByIdAndDelete(req.params.id); if (!p) throw new ApiError(404, 'Not found'); await audit(req, 'PACKAGE_DELETED', p.id, { before: { name: p.name, points: p.points } }); res.json({ ok: true }); }));

// ================= payouts =================
r.get('/payouts', need('payouts.read'), asyncHandler(async (req, res) => {
  const f = {}; if (req.query.status) f.status = String(req.query.status); if (req.query.creator) f.creatorId = { $in: await uid(String(req.query.creator)) }; Object.assign(f, dateRange(req));
  const [out, sums, period] = await Promise.all([paged(Payout, f, req, { sortable: ['createdAt', 'nairaAmount', 'status'], select: 'creatorId amountPoints nairaAmount bankName accountLast4 status reference transferCode providerReference failReason createdAt updatedAt', populate: [['creatorId', 'username displayName']] }),
    Payout.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, naira: { $sum: '$nairaAmount' } } }]), Payout.aggregate([{ $match: { ...dateRange(req, 'updatedAt'), status: 'PAID' } }, { $group: { _id: null, naira: { $sum: '$nairaAmount' } } }])]);
  res.json({ ...out, summary: Object.fromEntries(sums.map((s) => [s._id, { count: s.n, naira: s.naira }])), paidInPeriodNaira: period[0]?.naira || 0 });
}));
r.get('/payouts/:id', need('payouts.read'), asyncHandler(async (req, res) => {
  const p = await Payout.findById(req.params.id).populate('creatorId', 'username displayName email').lean(); if (!p) throw new ApiError(404, 'Not found');
  const [summary, history] = await Promise.all([earningsSummary(p.creatorId._id), Payout.find({ creatorId: p.creatorId._id, _id: { $ne: p._id } }).sort('-createdAt').limit(10).select('nairaAmount status createdAt reference').lean()]);
  res.json({ payout: { ...p, accountMasked: `${p.bankName} ••••${p.accountLast4}`, automated: !!p.recipientCode }, creatorEarnings: summary, history }); // full account numbers are never stored
}));
r.post('/payouts/:id/send', need('payouts.review'), asyncHandler(async (req, res) => {
  const p = await Payout.findById(req.params.id); if (!p || p.status !== 'PENDING') throw new ApiError(409, 'Only pending payouts can be sent');
  if (env.paymentProvider !== 'paystack' || !p.recipientCode) throw new ApiError(400, 'No automated transfer is available for this payout. Pay manually, then record the bank reference.');
  const c = await Payout.findOneAndUpdate({ _id: p._id, status: 'PENDING' }, { status: 'PROCESSING' }, { new: true }); if (!c) throw new ApiError(409, 'Already processing');
  try { const t = await provider.transfer({ amountKobo: p.nairaAmount * 100, recipient: p.recipientCode, reference: p.reference, reason: 'Creator payout' }); c.transferCode = t.transfer_code; await c.save(); }
  catch (e) { c.status = 'PENDING'; await c.save(); throw e; }
  await audit(req, 'PAYOUT_TRANSFER_STARTED', p.id, { after: { naira: p.nairaAmount } }); res.json({ ok: true, note: 'Final status arrives from the provider webhook.' });
}));
// Manual payouts: only after the transfer really happened, with the bank's reference. Automatic transfers are completed by the provider webhook only.
r.post('/payouts/:id/mark-paid', need('payouts.review'), asyncHandler(async (req, res) => {
  const b = z.object({ providerReference: z.string().trim().min(4).max(80) }).parse(req.body); const p0 = await Payout.findById(req.params.id); if (!p0) throw new ApiError(404, 'Not found');
  if (p0.transferCode) throw new ApiError(409, 'This payout is awaiting confirmation from the payment provider. It cannot be marked paid manually.');
  const p = await Payout.findOneAndUpdate({ _id: p0._id, status: { $in: ['PENDING', 'PROCESSING'] } }, { status: 'PAID', providerReference: b.providerReference }, { new: true }); if (!p) throw new ApiError(409, 'Invalid state');
  await audit(req, 'PAYOUT_MARKED_PAID', p.id, { meta: { providerReference: b.providerReference, naira: p.nairaAmount } }); await notify(p.creatorId, 'PAYOUT', `Your withdrawal of ₦${p.nairaAmount.toLocaleString()} has been paid`, '/studio'); res.json({ ok: true });
}));
r.post('/payouts/:id/reject', need('payouts.review'), asyncHandler(async (req, res) => {
  const b = z.object({ reason }).parse(req.body); const p = await Payout.findOneAndUpdate({ _id: req.params.id, status: 'PENDING', transferCode: { $exists: false } }, { status: 'FAILED', failReason: b.reason, reviewReason: b.reason }, { new: true }); if (!p) throw new ApiError(409, 'Only pending, un-sent payouts can be rejected');
  await audit(req, 'PAYOUT_REJECTED', p.id, { reason: b.reason }); await notify(p.creatorId, 'PAYOUT', `Your withdrawal was not approved: ${b.reason}`, '/studio'); res.json({ ok: true });
}));

// ================= subscriptions =================
r.get('/subscriptions', need('subscriptions.read'), asyncHandler(async (req, res) => {
  const f = {}; const s = req.query.status; if (s === 'active') { f.status = 'ACTIVE'; f.expiresAt = { $gt: new Date() }; } else if (s === 'expired') f.$or = [{ status: 'EXPIRED' }, { expiresAt: { $lte: new Date() } }];
  if (req.query.creator) f.creatorId = { $in: await uid(String(req.query.creator)) }; if (req.query.subscriber) f.subscriberId = { $in: await uid(String(req.query.subscriber)) };
  res.json(await paged(Subscription, f, req, { sortable: ['createdAt', 'expiresAt'], select: 'subscriberId creatorId status pricePoints expiresAt createdAt', populate: [['subscriberId', 'username'], ['creatorId', 'username']] }));
}));
r.get('/subscriptions/pro', need('subscriptions.read'), asyncHandler(async (req, res) => {
  const f = { accountMode: 'CREATOR', $or: [{ creatorPlan: 'PRO' }, { proExpiresAt: { $ne: null } }] }; if (req.query.status === 'active') { f.creatorPlan = 'PRO'; delete f.$or; } if (req.query.status === 'expired') { f.creatorPlan = 'DEFAULT'; f.proExpiresAt = { $ne: null }; delete f.$or; }
  res.json(await paged(User, f, req, { sortable: ['proExpiresAt', 'createdAt'], defaultSort: '-proExpiresAt', select: 'username displayName creatorPlan proExpiresAt createdAt' }));
}));

// ================= referrals =================
r.get('/referrals', need('referrals.read'), asyncHandler(async (req, res) => {
  const f = {}; if (req.query.status) f.status = String(req.query.status); if (req.query.flagged === 'true') f.flagged = true;
  const [out, totals, referred, referredCreators] = await Promise.all([paged(ReferralReward, f, req, { sortable: ['createdAt', 'amount'], select: 'referrerId referredId netBasis bps amount status flagged reviewReason approveAfter createdAt', populate: [['referrerId', 'username'], ['referredId', 'username createdAt']] }),
    ReferralReward.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, points: { $sum: '$amount' } } }]), User.countDocuments({ referredBy: { $ne: null } }), User.countDocuments({ referredBy: { $ne: null }, accountMode: 'CREATOR' })]);
  const flagged = await ReferralReward.countDocuments({ flagged: true });
  res.json({ ...out, overview: { registrations: referred, referredCreators, flagged, byStatus: Object.fromEntries(totals.map((t) => [t._id, { count: t.n, points: t.points }])) }, settings: { rewardBps: await getSetting('referralBps'), periodDays: await getSetting('referralDays'), holdDays: await getSetting('referralHoldDays'), basis: 'Reward = percentage of the referred creator\'s NET earnings (after platform commission), never gross sales.' } });
}));
r.post('/referrals/:id/decision', need('referrals.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['approve', 'reject', 'flag']), reason }).parse(req.body); const rw = await ReferralReward.findById(req.params.id); if (!rw) throw new ApiError(404, 'Not found');
  if (b.action === 'flag') { rw.flagged = true; rw.reviewReason = b.reason; await rw.save(); await audit(req, 'REFERRAL_FLAGGED', rw.id, { reason: b.reason }); return res.json({ ok: true }); }
  const src = await PointTransaction.findById(rw.sourceTransactionId); if (b.action === 'approve' && src && src.status !== 'COMPLETED') throw new ApiError(409, 'The underlying sale was refunded, so the reward cannot be approved');
  const upd = await ReferralReward.findOneAndUpdate({ _id: rw._id, status: 'PENDING' }, { status: b.action === 'approve' ? 'APPROVED' : 'REJECTED', reviewReason: b.reason, flagged: b.action === 'reject' ? true : rw.flagged }, { new: true }); if (!upd) throw new ApiError(409, 'Already decided');
  if (b.action === 'approve') { await credit_(upd); await notify(upd.referrerId, 'REFERRAL', `Referral reward: +${upd.amount} pts`, '/referrals'); }
  await audit(req, `REFERRAL_${b.action.toUpperCase()}D`, rw.id, { reason: b.reason, after: { points: rw.amount } }); res.json({ ok: true });
}));

// ================= promotions =================
r.get('/promotions', need('promotions.read'), asyncHandler(async (req, res) => {
  const f = {}; if (req.query.status) f.status = String(req.query.status); if (req.query.type) f.targetType = String(req.query.type); if (req.query.owner) f.ownerId = { $in: await uid(String(req.query.owner)) };
  const out = await paged(Promotion, f, req, { sortable: ['createdAt', 'expiresAt', 'pricePoints'], select: 'ownerId targetType targetId duration pricePoints status startsAt expiresAt impressions clicks createdAt', populate: [['ownerId', 'username']] });
  out.items = out.items.map((p) => ({ ...p, ctr: p.impressions ? Math.round((p.clicks / p.impressions) * 1000) / 10 : null })); res.json(out); // CTR is measured; no reach estimates
}));
r.post('/promotions/:id/action', need('promotions.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['pause', 'resume', 'stop', 'reject']), reason }).parse(req.body); const p = await Promotion.findById(req.params.id); if (!p) throw new ApiError(404, 'Not found'); const before = p.status;
  const allowed = { pause: ['ACTIVE'], resume: ['PAUSED'], stop: ['ACTIVE', 'PAUSED'], reject: ['ACTIVE', 'PAUSED'] }; if (!allowed[b.action].includes(p.status)) throw new ApiError(409, `Cannot ${b.action} a ${p.status.toLowerCase()} campaign`);
  p.status = { pause: 'PAUSED', resume: 'ACTIVE', stop: 'CANCELLED', reject: 'REJECTED' }[b.action]; await p.save();
  if (b.action === 'reject' && p.paymentTxId) await reverse(p.paymentTxId, `promotion rejected: ${b.reason}`).catch(() => {}); // refunded in full
  await audit(req, `PROMOTION_${b.action.toUpperCase()}`, p.id, { reason: b.reason, before: { status: before }, after: { status: p.status } }); await notify(p.ownerId, 'PROMOTION', `Your promotion was ${p.status.toLowerCase()}${b.action === 'reject' ? ' and refunded' : ''}.`, '/insights'); res.json({ ok: true });
}));
export default r;
