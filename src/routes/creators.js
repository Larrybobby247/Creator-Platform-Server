import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { GiftTransaction, Gift } from '../models/Social.js';
import { Follow, Rating, Subscription, VerificationRecord } from '../models/Extra.js';
import { limitsFor } from '../services/plans.js';
import { isIdentityVerified } from '../services/verification.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireCreator } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

const r = Router();
r.use(authenticate);
r.post('/activate', asyncHandler(async (req, res) => {
  const b = z.object({ displayName: z.string().min(2).max(50), bio: z.string().max(500).optional(), category: z.string().max(30).optional() }).parse(req.body);
  Object.assign(req.user, b, { accountMode: 'CREATOR' }); req.user.creatorSince ||= new Date(); await req.user.save(); res.json({ ok: true });
}));
r.patch('/settings', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ subscriptionPricePoints: z.number().int().min(0).optional(), showGiftSenders: z.boolean().optional(), bio: z.string().max(500).optional(), displayName: z.string().min(2).max(50).optional() }).parse(req.body);
  if (b.subscriptionPricePoints !== undefined) { const lim = await limitsFor(req.user); if (b.subscriptionPricePoints > lim.maxSubscriptionPoints) throw new ApiError(400, `Your plan allows subscription prices up to ${lim.maxSubscriptionPoints} points. Upgrade to Pro for more.`, 'PLAN_LIMIT'); }
  Object.assign(req.user, b); await req.user.save(); res.json({ ok: true });
}));

// Special requests: creators set their own price floor and rules (regular users cannot).
r.patch('/request-settings', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), minPricePoints: z.number().int().min(1).max(100000), instructions: z.string().max(600).optional(), turnaroundDays: z.number().int().min(1).max(90) }).parse(req.body);
  req.user.requestSettings = b; await req.user.save(); res.json({ requestSettings: req.user.requestSettings });
}));
// Meetup toggle: backend requires an approved verification record. Enabling is impossible otherwise.
r.patch('/meetup', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), pricePoints: z.number().int().min(1).optional(), transportPoints: z.number().int().min(0).optional(), durationMin: z.number().int().min(15).max(480).optional(), area: z.string().max(120).optional(), noticeHours: z.number().int().min(1).optional(), cancelRule: z.string().max(500).optional() }).parse(req.body);
  if (b.enabled) {
    if (!(await isIdentityVerified(req.user._id))) throw new ApiError(403, 'Identity verification must be approved before enabling meetups', 'VERIFICATION_REQUIRED');
    if (!(b.pricePoints || req.user.meetup?.pricePoints)) throw new ApiError(400, 'Set a meetup price first');
  }
  req.user.meetup = { ...(req.user.meetup?.toObject?.() || {}), ...b }; await req.user.save();
  res.json({ meetup: req.user.meetup });
}));

r.get('/:id', asyncHandler(async (req, res) => {
  const u = await User.findOne({ $or: [{ _id: /^[0-9a-f]{24}$/i.test(req.params.id) ? req.params.id : null }, { username: req.params.id.toLowerCase() }] }).select('username displayName bio avatarUrl coverUrl creatorPlan category location accountMode meetup.enabled meetup.pricePoints meetup.transportPoints meetup.area meetup.durationMin meetup.cancelRule subscriptionPricePoints dmPolicy.mode dmPolicy.pricePoints requestSettings creatorSince');
  if (!u) throw new ApiError(404, 'Not found');
  const subscribers = u.accountMode === 'CREATOR' ? await Subscription.countDocuments({ creatorId: u._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }) : 0;
  const [followers, following, isFollowing, sub, rt] = await Promise.all([
    Follow.countDocuments({ followeeId: u._id }), Follow.countDocuments({ followerId: u._id }),
    Follow.exists({ followerId: req.user._id, followeeId: u._id }),
    Subscription.exists({ subscriberId: req.user._id, creatorId: u._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }),
    Rating.aggregate([{ $match: { creatorId: u._id, status: 'VISIBLE' } }, { $group: { _id: null, avg: { $avg: '$stars' }, n: { $sum: 1 } } }]),
  ]);
  if (u.id !== req.user.id) User.updateOne({ _id: u._id }, { $inc: { profileViews: 1 } }).catch(() => {});
  res.json({ creator: u, subscribers, followers, following, isFollowing: !!isFollowing, subscribed: !!sub, rating: rt[0] ? { avg: Math.round(rt[0].avg * 10) / 10, count: rt[0].n } : null });
}));

r.get('/:id/gifts', asyncHandler(async (req, res) => {
  const c = await User.findById(req.params.id).select('showGiftSenders');
  if (!c) throw new ApiError(404, 'Not found');
  const agg = await GiftTransaction.aggregate([{ $match: { recipientId: c._id, status: 'COMPLETED' } }, { $group: { _id: '$giftId', quantity: { $sum: '$quantity' }, pointsSpent: { $sum: '$grossPoints' } } }]);
  const gifts = await Gift.find({ _id: { $in: agg.map((a) => a._id) } });
  const out = { items: agg.map((a) => ({ gift: gifts.find((g) => g.id === String(a._id)), quantity: a.quantity, pointsSpent: a.pointsSpent })) };
  if (c.showGiftSenders) out.recent = await GiftTransaction.find({ recipientId: c._id }).sort('-createdAt').limit(20).populate('senderId', 'username avatarUrl');
  res.json(out);
}));
export default r;
