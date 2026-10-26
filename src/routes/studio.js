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

// ---- payouts ----
// Flow: earnings are confirmed by the payment provider -> backend takes the platform fee -> net amount becomes available ->
// creator saves a VERIFIED bank account once -> enters an amount -> we validate and record the request -> funds arrive in 24 to 48 hours ->
// the creator is notified when the transfer succeeds or fails.
import { listBanks, resolveName, saveVerifiedAccount, maskedAccount } from '../services/bank.js';
import rateLimit from 'express-rate-limit';
const lookupLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const lagosDayStart = () => { const d = new Date(Date.now() + 3600e3); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() - 3600e3); }; // midnight in Africa/Lagos (UTC+1, no DST)
const payoutToday = (creatorId) => Payout.findOne({ creatorId, createdAt: { $gte: lagosDayStart() }, status: { $nin: ['FAILED', 'REVERSED'] } }).select('createdAt').lean();
export const PAYOUT_ETA = 'Money is sent to your bank account within 24 to 48 hours.';

r.get('/payouts', requireCreator, asyncHandler(async (req, res) => res.json({ items: await Payout.find({ creatorId: req.user._id }).sort('-createdAt').limit(50) })));
r.get('/payout-info', requireCreator, asyncHandler(async (req, res) => {
  const t = await payoutToday(req.user._id);
  res.json({ account: maskedAccount(req.user), requestedToday: !!t, nextAt: t ? new Date(lagosDayStart().getTime() + 864e5) : null, minPayoutPoints: await getSetting('minPayoutPoints'), eta: PAYOUT_ETA });
}));
r.get('/banks', requireCreator, asyncHandler(async (_q, res) => res.json(await listBanks())));
// Step 1: ask the bank who owns the account. Step 2: the creator confirms the name, then we save it.
r.post('/payout-account/verify', requireCreator, lookupLimit, asyncHandler(async (req, res) => {
  const b = z.object({ accountNumber: z.string().regex(/^\d{10}$/, 'An account number has 10 digits'), bankCode: z.string().min(1).max(10) }).parse(req.body);
  res.json({ accountName: await resolveName(b) });
}));
r.post('/payout-account', requireCreator, lookupLimit, asyncHandler(async (req, res) => {
  const b = z.object({ bankCode: z.string().min(1), bankName: z.string().min(2).max(80), accountNumber: z.string().regex(/^\d{10}$/), confirmedName: z.string().min(2).max(120) }).parse(req.body);
  res.json({ account: await saveVerifiedAccount(req.user, b) });
}));
r.post('/payouts', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ amountPoints: z.number().int().positive() }).parse(req.body);
  const acct = req.user.payoutAccount; if (!acct?.accountLast4) throw new ApiError(400, 'Add and verify a bank account first.', 'NO_BANK_ACCOUNT');
  if (env.paymentProvider === 'paystack' && !acct.recipientCode) throw new ApiError(400, 'Please re-add your bank account.', 'NO_BANK_ACCOUNT');
  const min = await getSetting('minPayoutPoints'); if (b.amountPoints < min) throw new ApiError(400, `Minimum withdrawal is ${min} points`);
  if (await payoutToday(req.user._id)) throw new ApiError(429, 'You can only request one withdrawal per day. Please try again tomorrow.', 'PAYOUT_DAILY_LIMIT');
  const { availableToWithdraw, nairaPerPoint } = await earningsSummary(req.user._id);
  if (b.amountPoints > availableToWithdraw) throw new ApiError(400, 'Amount exceeds your available earnings');
  const p = await Payout.create({ creatorId: req.user._id, amountPoints: b.amountPoints, nairaAmount: b.amountPoints * nairaPerPoint, bankName: acct.bankName, accountLast4: acct.accountLast4, accountName: acct.accountName, recipientCode: acct.recipientCode, reference: `PO_${crypto.randomBytes(8).toString('hex')}` });
  await notify(req.user._id, 'PAYOUT', `Withdrawal of ₦${p.nairaAmount.toLocaleString('en-NG')} requested. ${PAYOUT_ETA}`, '/studio');
  res.status(201).json({ payout: p, message: PAYOUT_ETA });
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
