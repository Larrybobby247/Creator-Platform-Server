import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Post, Conversation } from '../models/Social.js';
import { PointTransaction } from '../models/Finance.js';
import { Subscription, Community, CommunityMember, SpecialRequest, Rating, Promotion, Notification, MeetupBooking } from '../models/Extra.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireCreator } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assertCanInteract } from '../utils/restrict.js';
import { spend, reverse } from '../services/pointLedger.js';
import { recordEarning } from '../services/earnings.js';
import { getSetting } from '../services/settings.js';
import { notify } from '../services/notify.js';

const r = Router();
r.use(authenticate);
const oidOk = (s) => /^[0-9a-f]{24}$/i.test(s);

// One small request for both header badges (replaces two separate calls on every page load).
r.get('/counts', asyncHandler(async (req, res) => {
  const [convs, notifications] = await Promise.all([
    Conversation.find({ participants: req.user._id, archivedBy: { $ne: req.user._id } }).select('unread').lean(),
    Notification.countDocuments({ recipientId: req.user._id, read: false }),
  ]);
  res.json({ messages: convs.reduce((n, c) => n + Number(c.unread?.[req.user.id] || 0), 0), notifications });
}));
// ---- notifications
r.get('/notifications', asyncHandler(async (req, res) => res.json({ items: await Notification.find({ recipientId: req.user._id }).sort('-createdAt').limit(50).select('-__v').lean(), unread: await Notification.countDocuments({ recipientId: req.user._id, read: false }) })));
r.post('/notifications/read-all', asyncHandler(async (req, res) => { await Notification.updateMany({ recipientId: req.user._id, read: false }, { read: true }); res.json({ ok: true }); }));
r.post('/notifications/:id/read', asyncHandler(async (req, res) => { await Notification.updateOne({ _id: req.params.id, recipientId: req.user._id }, { read: true }); res.json({ ok: true }); }));

// ---- subscriptions (30 days, paid in points)
r.post('/subscriptions/:creatorId', asyncHandler(async (req, res) => {
  const c = await User.findOne({ _id: req.params.creatorId, accountMode: 'CREATOR' });
  if (!c || c.id === req.user.id || !c.subscriptionPricePoints) throw new ApiError(400, 'Subscription not available');
  const key = `sub:${req.user.id}:${c.id}:${new Date().toISOString().slice(0, 7)}`; // one charge per creator per month
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'CREATOR_SUBSCRIPTION', amount: c.subscriptionPricePoints, idempotencyKey: key, creatorId: c._id });
  if (duplicate) return res.json({ ok: true, duplicate: true });
  const cur = await Subscription.findOne({ subscriberId: req.user._id, creatorId: c._id });
  const base = cur && cur.expiresAt > new Date() ? cur.expiresAt : new Date();
  await Subscription.findOneAndUpdate({ subscriberId: req.user._id, creatorId: c._id }, { status: 'ACTIVE', expiresAt: new Date(base.getTime() + 30 * 864e5), pricePoints: c.subscriptionPricePoints }, { upsert: true });
  await recordEarning({ creatorId: c._id, sourceTx: tx, gross: c.subscriptionPricePoints, label: 'subscriber' });
  await notify(c._id, 'SUBSCRIBER', `${req.user.username} subscribed`, '/studio');
  res.json({ ok: true });
}));
r.get('/subscriptions/me', asyncHandler(async (req, res) => res.json({ items: await Subscription.find({ subscriberId: req.user._id }).populate('creatorId', 'username displayName avatarUrl').lean() })));

// ---- communities
r.get('/communities', asyncHandler(async (req, res) => {
  const mine = new Set((await CommunityMember.find({ userId: req.user._id })).map((m) => String(m.communityId)));
  const promoted = new Set((await Promotion.find({ targetType: 'COMMUNITY', status: 'ACTIVE', expiresAt: { $gt: new Date() } })).map((p) => String(p.targetId)));
  const items = await Community.find({ status: { $ne: 'RESTRICTED' }, $or: [{ visibility: 'PUBLIC' }, { _id: { $in: [...mine] } }] }).populate('ownerId', 'username').limit(40);
  res.json({ items: items.map((c) => ({ ...c.toObject(), joined: mine.has(c.id), sponsored: promoted.has(c.id) })).sort((a, b) => Number(b.sponsored) - Number(a.sponsored)) });
}));
r.post('/communities', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().min(3).max(40), description: z.string().max(400).optional(), visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'), accessFeePoints: z.number().int().min(0).default(0), rules: z.string().max(800).optional() }).parse(req.body);
  if (b.accessFeePoints > 0 && req.user.accountMode !== 'CREATOR') throw new ApiError(403, 'Only creators can charge for communities');
  const c = await Community.create({ ...b, ownerId: req.user._id }).catch((e) => { if (e.code === 11000) throw new ApiError(409, 'Name taken'); throw e; });
  await CommunityMember.create({ communityId: c._id, userId: req.user._id });
  res.status(201).json(c);
}));
r.post('/communities/:id/join', asyncHandler(async (req, res) => {
  const c = await Community.findById(req.params.id); if (!c) throw new ApiError(404, 'Not found');
  if (c.visibility === 'PRIVATE') throw new ApiError(403, 'Invite only');
  if (await CommunityMember.exists({ communityId: c._id, userId: req.user._id })) return res.json({ ok: true });
  if (c.accessFeePoints > 0) {
    const { tx, duplicate } = await spend({ userId: req.user._id, type: 'COMMUNITY_ACCESS', amount: c.accessFeePoints, idempotencyKey: `comm:${req.user.id}:${c.id}`, creatorId: c.ownerId, relatedId: c._id });
    if (!duplicate) await recordEarning({ creatorId: c.ownerId, sourceTx: tx, gross: c.accessFeePoints, label: 'community join' });
  }
  await CommunityMember.updateOne({ communityId: c._id, userId: req.user._id }, {}, { upsert: true }); await Community.updateOne({ _id: c._id }, { $inc: { memberCount: 1 } });
  res.json({ ok: true });
}));

// ---- special requests (paid up-front, refunded on reject, earned on user confirmation)
r.post('/requests', asyncHandler(async (req, res) => {
  const b = z.object({ creatorId: z.string(), description: z.string().min(10).max(1000), offerPoints: z.number().int().min(1) }).parse(req.body);
  const c = await User.findOne({ _id: b.creatorId, accountMode: 'CREATOR' }); if (!c || c.id === req.user.id) throw new ApiError(400, 'Invalid creator');
  assertCanInteract(req.user); const rs = c.requestSettings || {};
  if (rs.enabled === false) throw new ApiError(403, 'This creator is not accepting special requests right now.', 'REQUESTS_OFF');
  if (b.offerPoints < (rs.minPricePoints || 1)) throw new ApiError(400, `This creator's minimum is ${rs.minPricePoints} points.`, 'BELOW_MINIMUM');
  const sr = await SpecialRequest.create({ userId: req.user._id, creatorId: c._id, description: b.description, offerPoints: b.offerPoints });
  try { const { tx } = await spend({ userId: req.user._id, type: 'SPECIAL_REQUEST', amount: b.offerPoints, idempotencyKey: `req:${sr.id}`, creatorId: c._id, relatedId: sr._id }); sr.paymentTxId = tx._id; await sr.save(); }
  catch (e) { await sr.deleteOne(); throw e; }
  await notify(c._id, 'REQUEST', `New special request from ${req.user.username} (${b.offerPoints} pts)`, '/studio');
  res.status(201).json(sr);
}));
r.get('/requests', asyncHandler(async (req, res) => {
  const role = req.query.as === 'creator' ? 'creatorId' : 'userId';
  res.json({ items: await SpecialRequest.find({ [role]: req.user._id }).sort('-createdAt').limit(50).populate('userId creatorId', 'username displayName') });
}));
const moveReq = async (id, filter, from, to) => SpecialRequest.findOneAndUpdate({ _id: id, ...filter, status: { $in: from } }, { status: to }, { new: true });
r.post('/requests/:id/:action', asyncHandler(async (req, res) => {
  const { id, action } = req.params; const me = req.user._id; let sr;
  if (action === 'accept') sr = await moveReq(id, { creatorId: me }, ['PENDING'], 'ACCEPTED');
  else if (action === 'reject') { sr = await moveReq(id, { creatorId: me }, ['PENDING', 'ACCEPTED'], 'REJECTED'); if (sr) await reverse(sr.paymentTxId, 'request rejected'); }
  else if (action === 'cancel') { sr = await moveReq(id, { userId: me }, ['PENDING'], 'CANCELLED'); if (sr) await reverse(sr.paymentTxId, 'request cancelled'); }
  else if (action === 'deliver') { sr = await moveReq(id, { creatorId: me }, ['ACCEPTED'], 'DELIVERED'); }
  else if (action === 'complete') { sr = await moveReq(id, { userId: me }, ['DELIVERED'], 'COMPLETED');
    if (sr) await recordEarning({ creatorId: sr.creatorId, sourceTx: await PointTransaction.findById(sr.paymentTxId), gross: sr.offerPoints, label: 'special request' }); }
  else throw new ApiError(404, 'Unknown action');
  if (!sr) throw new ApiError(409, 'Invalid state transition');
  await notify(String(sr.userId) === String(me) ? sr.creatorId : sr.userId, 'REQUEST', `Request ${sr.status.toLowerCase()}`, '/requests');
  res.json(sr);
}));

// ---- ratings: only after a COMPLETED special request or meetup, once per qualifying transaction
r.post('/creators/:id/ratings', asyncHandler(async (req, res) => {
  const b = z.object({ qualifyingId: z.string(), stars: z.number().int().min(1).max(5), text: z.string().max(1000).optional() }).parse(req.body);
  const sr = await SpecialRequest.findOne({ _id: b.qualifyingId, userId: req.user._id, creatorId: req.params.id, status: 'COMPLETED' });
  const mb = sr ? null : await MeetupBooking.findOne({ _id: b.qualifyingId, userId: req.user._id, creatorId: req.params.id, status: { $in: ['COMPLETED', 'EARNINGS_RELEASED'] } });
  if (!sr && !mb) throw new ApiError(403, 'You can only rate after a completed service');
  const rt = await Rating.create({ creatorId: req.params.id, reviewerId: req.user._id, qualifyingId: b.qualifyingId, qualifyingKind: sr ? 'REQUEST' : 'MEETUP', stars: b.stars, text: b.text }).catch((e) => { if (e.code === 11000) throw new ApiError(409, 'Already rated'); throw e; });
  res.status(201).json(rt);
}));
r.get('/creators/:id/ratings', asyncHandler(async (req, res) => {
  if (!oidOk(req.params.id)) throw new ApiError(400, 'Bad id');
  const list = await Rating.find({ creatorId: req.params.id, status: 'VISIBLE' }).sort('-createdAt').limit(50).populate('reviewerId', 'username avatarUrl');
  const dist = [1, 2, 3, 4, 5].map((s) => list.filter((x) => x.stars === s).length);
  res.json({ items: list.map((x) => ({ ...x.toObject(), verified: true })), distribution: dist, count: list.length, avg: list.length ? Math.round((list.reduce((n, x) => n + x.stars, 0) / list.length) * 10) / 10 : null });
}));
r.post('/ratings/:id/report', asyncHandler(async (req, res) => { await Rating.updateOne({ _id: req.params.id, creatorId: req.user._id }, { status: 'REPORTED' }); res.json({ ok: true }); }));
// Eligible, un-rated services for the current user (drives the "Rate" button)
r.get('/ratings/eligible/:creatorId', asyncHandler(async (req, res) => {
  const rated = new Set((await Rating.find({ reviewerId: req.user._id, creatorId: req.params.creatorId })).map((x) => String(x.qualifyingId)));
  const [a, b] = await Promise.all([SpecialRequest.find({ userId: req.user._id, creatorId: req.params.creatorId, status: 'COMPLETED' }), MeetupBooking.find({ userId: req.user._id, creatorId: req.params.creatorId, status: { $in: ['COMPLETED', 'EARNINGS_RELEASED'] } })]);
  res.json({ items: [...a.map((x) => ({ id: x.id, kind: 'Special request' })), ...b.map((x) => ({ id: x.id, kind: 'Meetup' }))].filter((x) => !rated.has(x.id)) });
}));

// ---- promotions
const DUR = { DAY1: 864e5, DAY3: 3 * 864e5, DAY7: 7 * 864e5 };
r.get('/promotions/prices', asyncHandler(async (_q, res) => res.json(await getSetting('promoPrices'))));
r.post('/promotions', asyncHandler(async (req, res) => {
  const b = z.object({ targetType: z.enum(['POST', 'PROFILE', 'COMMUNITY']), targetId: z.string().optional(), duration: z.enum(['DAY1', 'DAY3', 'DAY7']), idempotencyKey: z.string().min(8) }).parse(req.body);
  let targetId = b.targetId;
  if (b.targetType === 'PROFILE') targetId = req.user.id;
  else if (b.targetType === 'POST') { if (!(await Post.exists({ _id: targetId, authorId: req.user._id, access: 'PUBLIC', status: 'PUBLISHED' }))) throw new ApiError(403, 'Only your own public posts can be promoted'); }
  else if (!(await Community.exists({ _id: targetId, ownerId: req.user._id, visibility: 'PUBLIC' }))) throw new ApiError(403, 'Only your own public communities can be promoted');
  const price = (await getSetting('promoPrices'))[b.duration]; // price from settings, never the client
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'PROMOTION_PURCHASE', amount: price, idempotencyKey: `promo:${req.user.id}:${b.idempotencyKey}` });
  if (duplicate) return res.json({ ok: true, duplicate: true });
  const now = new Date();
  res.status(201).json(await Promotion.create({ ownerId: req.user._id, targetType: b.targetType, targetId, duration: b.duration, pricePoints: price, startsAt: now, expiresAt: new Date(now.getTime() + DUR[b.duration]), paymentTxId: tx._id }));
}));
r.get('/promotions/me', asyncHandler(async (req, res) => res.json({ items: await Promotion.find({ ownerId: req.user._id }).sort('-createdAt').limit(50) })));
r.post('/promotions/:id/cancel', asyncHandler(async (req, res) => {
  const p = await Promotion.findOneAndUpdate({ _id: req.params.id, ownerId: req.user._id, status: 'ACTIVE' }, { status: 'CANCELLED' }, { new: true });
  if (!p) throw new ApiError(409, 'Cannot cancel'); res.json(p); // policy: no refund after activation
}));
r.get('/promotions/discover', asyncHandler(async (_q, res) => {
  const items = await Promotion.find({ status: 'ACTIVE', expiresAt: { $gt: new Date() } }).limit(10);
  await Promotion.updateMany({ _id: { $in: items.map((i) => i._id) } }, { $inc: { impressions: 1 } });
  res.json({ items });
}));
export default r;

// ---- community detail, posting, moderation
r.get('/communities/:id', asyncHandler(async (req, res) => {
  if (!oidOk(req.params.id)) throw new ApiError(400, 'Bad id');
  const c = await Community.findById(req.params.id).populate('ownerId', 'username displayName avatarUrl'); if (!c || c.status === 'RESTRICTED') throw new ApiError(404, 'Not found');
  const member = !!(await CommunityMember.exists({ communityId: c._id, userId: req.user._id }));
  if (c.visibility === 'PRIVATE' && !member) throw new ApiError(404, 'Not found');
  const members = member || c.visibility === 'PUBLIC' ? await CommunityMember.find({ communityId: c._id }).limit(30).populate('userId', 'username displayName avatarUrl') : [];
  res.json({ community: c, member, owner: String(c.ownerId._id) === req.user.id, members: members.map((m) => m.userId) });
}));
r.patch('/communities/:id', asyncHandler(async (req, res) => {
  const b = z.object({ description: z.string().max(400).optional(), rules: z.string().max(800).optional(), accessFeePoints: z.number().int().min(0).optional() }).parse(req.body);
  if (b.accessFeePoints > 0 && req.user.accountMode !== 'CREATOR') throw new ApiError(403, 'Only creators can charge for communities');
  const c = await Community.findOneAndUpdate({ _id: req.params.id, ownerId: req.user._id }, b, { new: true }); if (!c) throw new ApiError(404, 'Not found'); res.json(c);
}));
r.post('/communities/:id/posts', asyncHandler(async (req, res) => {
  const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(req.body);
  if (!(await CommunityMember.exists({ communityId: req.params.id, userId: req.user._id }))) throw new ApiError(403, 'Join first');
  res.status(201).json(await Post.create({ authorId: req.user._id, content, communityId: req.params.id, access: 'PUBLIC', status: 'PUBLISHED' }));
}));
r.delete('/communities/:id/posts/:postId', asyncHandler(async (req, res) => {
  const c = await Community.findById(req.params.id); const p = await Post.findOne({ _id: req.params.postId, communityId: req.params.id });
  if (!c || !p) throw new ApiError(404, 'Not found'); if (String(c.ownerId) !== req.user.id && String(p.authorId) !== req.user.id) throw new ApiError(403, 'Not allowed');
  await p.deleteOne(); res.json({ ok: true });
}));
r.delete('/communities/:id/members/:userId', asyncHandler(async (req, res) => {
  const c = await Community.findOne({ _id: req.params.id, ownerId: req.user._id }); if (!c) throw new ApiError(403, 'Owner only');
  if (req.params.userId === req.user.id) throw new ApiError(400, 'Owner cannot be removed');
  const d = await CommunityMember.findOneAndDelete({ communityId: c._id, userId: req.params.userId }); if (d) await Community.updateOne({ _id: c._id }, { $inc: { memberCount: -1 } }); res.json({ ok: !!d });
}));
r.post('/communities/:id/invite', asyncHandler(async (req, res) => {
  const { username } = z.object({ username: z.string() }).parse(req.body);
  const c = await Community.findOne({ _id: req.params.id, ownerId: req.user._id }); const u = await User.findOne({ username: username.toLowerCase() });
  if (!c || !u) throw new ApiError(404, 'Not found');
  const ins = await CommunityMember.updateOne({ communityId: c._id, userId: u._id }, {}, { upsert: true }); if (ins.upsertedCount) await Community.updateOne({ _id: c._id }, { $inc: { memberCount: 1 } });
  await notify(u._id, 'COMMUNITY', `You were added to ${c.name}`, `/communities/${c.id}`); res.json({ ok: true });
}));
r.post('/promotions/click', asyncHandler(async (req, res) => {
  const b = z.object({ targetType: z.enum(['POST', 'PROFILE', 'COMMUNITY']), targetId: z.string() }).parse(req.body);
  await Promotion.updateMany({ targetType: b.targetType, targetId: b.targetId, status: 'ACTIVE', expiresAt: { $gt: new Date() } }, { $inc: { clicks: 1 } }); res.json({ ok: true });
}));
