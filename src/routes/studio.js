import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { CreatorEarning, PointTransaction, AuditLog } from '../models/Finance.js';
import { GiftTransaction } from '../models/Social.js';
import { Payout, ReferralReward, Subscription, Follow, VerificationRecord, Promotion, MeetupBooking, Rating } from '../models/Extra.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireCreator } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { getSetting } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { env } from '../config/env.js';
import * as provider from '../services/paymentProvider.js';

const r = Router();
r.use(authenticate);

export async function earningsSummary(creatorId) {
  const [byStatus, payouts, nairaPerPoint] = await Promise.all([
    CreatorEarning.aggregate([{ $match: { creatorId } }, { $group: { _id: '$status', gross: { $sum: '$gross' }, fee: { $sum: '$commission' }, net: { $sum: '$net' } } }]),
    Payout.aggregate([{ $match: { creatorId } }, { $group: { _id: '$status', v: { $sum: '$amountPoints' } } }]),
    getSetting('nairaPerPoint'),
  ]);
  const E = Object.fromEntries(byStatus.map((x) => [x._id, x])), P = Object.fromEntries(payouts.map((x) => [x._id, x.v]));
  const live = byStatus.filter((x) => x._id !== 'REVERSED'); const paidOut = P.PAID || 0, inFlight = (P.PENDING || 0) + (P.PROCESSING || 0);
  return { gross: live.reduce((n, x) => n + x.gross, 0), platformFees: live.reduce((n, x) => n + x.fee, 0), refunded: E.REVERSED?.gross || 0,
    availableToWithdraw: Math.max(0, (E.AVAILABLE?.net || 0) - paidOut - inFlight), pendingEarnings: (E.PENDING?.net || 0) + (E.RESERVED?.net || 0), pendingPayouts: inFlight, paidOut, nairaPerPoint };
}

r.get('/earnings', requireCreator, asyncHandler(async (req, res) => res.json(await earningsSummary(req.user._id))));

r.get('/analytics', requireCreator, asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 6 * 864e5); since.setHours(0, 0, 0, 0);
  const rows = await CreatorEarning.aggregate([{ $match: { creatorId: req.user._id, createdAt: { $gte: since }, status: { $ne: 'REVERSED' } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, v: { $sum: '$net' } } }]);
  const m = Object.fromEntries(rows.map((x) => [x._id, x.v]));
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(since.getTime() + i * 864e5); const k = d.toISOString().slice(0, 10); return { date: k, points: m[k] || 0 }; });
  const [followers, subscribers, gifts, promos, bookings, rt] = await Promise.all([
    Follow.countDocuments({ followeeId: req.user._id }), Subscription.countDocuments({ creatorId: req.user._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }),
    GiftTransaction.aggregate([{ $match: { recipientId: req.user._id } }, { $group: { _id: null, n: { $sum: '$quantity' } } }]).then((x) => x[0]?.n || 0),
    Promotion.countDocuments({ ownerId: req.user._id, status: 'ACTIVE' }), MeetupBooking.countDocuments({ creatorId: req.user._id }),
    Rating.aggregate([{ $match: { creatorId: req.user._id, status: 'VISIBLE' } }, { $group: { _id: null, avg: { $avg: '$stars' }, n: { $sum: 1 } } }]),
  ]);
  const views = (await User.findById(req.user._id).select('profileViews')).profileViews || 0;
  res.json({ days, profileViews: views, followers, subscribers, giftsReceived: gifts, activePromotions: promos, meetupBookings: bookings, rating: rt[0] ? { avg: Math.round(rt[0].avg * 10) / 10, count: rt[0].n } : null });
}));

// ---- payouts (records + admin processing; no automated bank transfer is integrated)
r.get('/payouts', requireCreator, asyncHandler(async (req, res) => res.json({ items: await Payout.find({ creatorId: req.user._id }).sort('-createdAt').limit(50) })));
r.post('/payouts', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ amountPoints: z.number().int().positive(), bankName: z.string().min(2).max(60), bankCode: z.string().max(10).optional(), accountNumber: z.string().regex(/^\d{10}$/), accountName: z.string().min(2).max(80) }).parse(req.body);
  const min = await getSetting('minPayoutPoints'); if (b.amountPoints < min) throw new ApiError(400, `Minimum withdrawal is ${min} points`);
  const { availableToWithdraw, nairaPerPoint } = await earningsSummary(req.user._id);
  if (b.amountPoints > availableToWithdraw) throw new ApiError(400, 'Amount exceeds available earnings');
  // The full account number goes only to the payout provider (to create a recipient). We keep the last 4 digits and the provider's recipient code.
  let recipientCode;
  if (env.paymentProvider === 'paystack') {
    if (!b.bankCode) throw new ApiError(400, 'Choose your bank');
    recipientCode = (await provider.createRecipient({ name: b.accountName, accountNumber: b.accountNumber, bankCode: b.bankCode })).recipient_code;
  }
  const p = await Payout.create({ creatorId: req.user._id, amountPoints: b.amountPoints, nairaAmount: b.amountPoints * nairaPerPoint, bankName: b.bankName, accountLast4: b.accountNumber.slice(-4), accountName: b.accountName, recipientCode, reference: `PO_${crypto.randomBytes(8).toString('hex')}` });
  res.status(201).json(p);
}));

r.get('/banks', requireCreator, asyncHandler(async (_q, res) => {
  if (env.paymentProvider !== 'paystack') return res.json({ banks: [{ name: 'Test Bank (dev)', code: '000' }], dev: true });
  res.json({ banks: (await provider.listBanks()).map((b) => ({ name: b.name, code: b.code })) });
}));
r.get('/audience', requireCreator, asyncHandler(async (req, res) => {
  const [f, s] = await Promise.all([Follow.find({ followeeId: req.user._id }).sort('-createdAt').limit(50).populate('followerId', 'username displayName avatarUrl').lean(), Subscription.find({ creatorId: req.user._id }).sort('-createdAt').limit(50).populate('subscriberId', 'username displayName avatarUrl').lean()]);
  res.json({ followers: f.map((x) => x.followerId), subscribers: s.map((x) => ({ user: x.subscriberId, status: x.status, expiresAt: x.expiresAt })) });
}));
// ---- referrals
r.get('/referrals', asyncHandler(async (req, res) => {
  const [people, rewards] = await Promise.all([User.find({ referredBy: req.user._id }).select('username accountMode createdAt'), ReferralReward.find({ referrerId: req.user._id }).sort('-createdAt').limit(50)]);
  const tot = (s) => rewards.filter((x) => x.status === s).reduce((n, x) => n + x.amount, 0);
  res.json({ code: req.user.referralCode, link: `${env.frontendUrl}/?ref=${req.user.referralCode}`, referred: people.length, qualified: people.filter((p) => p.accountMode === 'CREATOR').length, pendingRewards: tot('PENDING'), approvedRewards: tot('APPROVED'), history: rewards, bps: await getSetting('referralBps'), days: await getSetting('referralDays') });
}));

export default r;
