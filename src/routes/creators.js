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
import rateLimit from 'express-rate-limit';
import { getSetting } from '../services/settings.js';
import { listBanks, resolveName, saveVerifiedAccount, namesOverlap } from '../services/bank.js';
import { isOnline } from '../realtime.js';
import { env } from '../config/env.js';
import { notify } from '../services/notify.js';

const r = Router();
r.use(authenticate);
// ======================= Becoming a creator =======================
// No one-click activation: explanation -> step-by-step application (details, guidelines, services, payout account) -> profile is set up from the answers.
export const GUIDELINES_VERSION = '2026-10';
const SERVICE_KEYS = ['paidPhotos', 'paidVideos', 'promotions', 'specialRequests', 'paidCommunities', 'paidVoice', 'tipsGifts', 'subscriptions', 'innerCircle'];
const PRICED = new Set(['subscriptions', 'specialRequests', 'paidVoice', 'innerCircle']); // services with a default price the creator chooses
const guidelines = (c1, c2) => [
  { title: 'Copyright and intellectual property', body: 'Only post content you created or have the right to share. Do not upload pirated, copied or re-posted work.' },
  { title: 'Impersonation and fake accounts', body: 'Do not pretend to be someone else or run fake or duplicate accounts. Your legal name must match your payout account.' },
  { title: 'Harassment and abusive behaviour', body: 'No bullying, threats, hate or abuse toward fans, creators or staff. Violations lead to removal.' },
  { title: 'Fraudulent monetisation practices', body: 'No fake purchases, self-gifting, refund abuse or any trick to inflate earnings. Fraudulent earnings are reversed.' },
  { title: "Rules for uploading other people's images or videos", body: 'Only show people who are 18+ and gave clear consent. Never post someone’s private images without permission.' },
  { title: 'Refunds, disputes and chargebacks', body: 'Delivered digital content is not refundable. Rejected or undelivered special requests are refunded. Chargebacks may freeze related earnings while we review.' },
  { title: 'Creator earnings and platform fees', body: `The platform keeps ${c1 / 100}% of each sale (${c2 / 100}% on Pro). Earnings become withdrawable after payment is confirmed. Payouts arrive in 24 to 48 hours, one request per day.` },
  { title: 'Account suspension and termination', body: 'Breaking these rules can lead to restriction, suspension or termination. Earnings linked to fraud may be withheld.' },
];
r.get('/application/meta', asyncHandler(async (req, res) => {
  const [c1, c2] = await Promise.all([getSetting('commissionBps'), getSetting('proCommissionBps')]);
  res.json({ alreadyCreator: req.user.accountMode === 'CREATOR', country: 'Nigeria', categories: ['Personal content'], guidelinesVersion: GUIDELINES_VERSION, guidelines: guidelines(c1, c2), commissionBps: c1, proCommissionBps: c2,
    services: [['paidPhotos', 'Paid photos'], ['paidVideos', 'Paid videos'], ['promotions', 'Creator promotions'], ['specialRequests', 'Special requests'], ['paidCommunities', 'Paid communities'], ['paidVoice', 'Paid voice messages'], ['tipsGifts', 'Tips and gifts'], ['subscriptions', 'Monthly subscriptions'], ['innerCircle', 'Innercircle']].map(([key, label]) => ({ key, label, priced: PRICED.has(key) })) });
}));
r.get('/application/banks', asyncHandler(async (_q, res) => res.json(await listBanks())));
const lookupLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait a little and try again.', code: 'RATE_LIMITED' } });
r.post('/application/verify-account', lookupLimit, asyncHandler(async (req, res) => {
  const b = z.object({ accountNumber: z.string().regex(/^\d{10}$/, 'An account number has 10 digits'), bankCode: z.string().min(1).max(10) }).parse(req.body);
  res.json({ accountName: await resolveName(b) });
}));

const servicesSchema = z.record(z.enum(SERVICE_KEYS), z.object({ enabled: z.boolean(), pricePoints: z.number().int().min(1).max(100000).optional() }));
// Copies the creator's service choices onto the fields the rest of the app already reads (subscription price, request settings, innercircle price).
// Innercircle is only SWITCHED ON later, after identity verification (Creator Studio).
async function applyServices(user, svc) {
  if (svc.innerCircle?.enabled && !(await isIdentityVerified(user._id))) throw new ApiError(403, 'Identity verification must be approved before turning on Innercircle', 'VERIFICATION_REQUIRED');
  user.services = { ...(user.services || {}) };
  for (const [k, v] of Object.entries(svc)) {
    if (PRICED.has(k) && v.enabled && !v.pricePoints && k !== 'specialRequests') throw new ApiError(400, `Set a price for ${k === 'paidVoice' ? 'paid voice messages' : k === 'innerCircle' ? 'Innercircle' : 'monthly subscriptions'}`);
    user.services[k] = { enabled: v.enabled, ...(v.pricePoints ? { pricePoints: v.pricePoints } : {}) };
    if (k === 'subscriptions') user.subscriptionPricePoints = v.enabled ? v.pricePoints : 0;
    if (k === 'specialRequests') user.requestSettings = { ...(user.requestSettings?.toObject?.() || user.requestSettings || { turnaroundDays: 7 }), enabled: v.enabled, minPricePoints: v.pricePoints || user.requestSettings?.minPricePoints || 1 };
    if (k === 'innerCircle') { user.meetup = { ...(user.meetup?.toObject?.() || {}), pricePoints: v.pricePoints || user.meetup?.pricePoints || 0, enabled: v.enabled ? !!user.meetup?.enabled : false }; }
  }
  user.markModified('services');
}
const normPhone = (p) => p.replace(/[\s-]/g, '').replace(/^\+234/, '0');
r.post('/apply', asyncHandler(async (req, res) => {
  if (req.user.accountMode === 'CREATOR') throw new ApiError(409, 'You are already a creator');
  const b = z.object({
    contentCategory: z.literal('Personal content'), country: z.literal('Nigeria'),
    legalName: z.string().trim().min(5, 'Enter your full legal name').max(100).refine((n) => n.split(/\s+/).length >= 2, 'Enter your first and last name'),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth'), phone: z.string().refine((p) => /^0[789][01]\d{8}$/.test(normPhone(p)), 'Enter a valid Nigerian phone number'),
    acceptGuidelines: z.literal(true, { errorMap: () => ({ message: 'You must accept the content guidelines' }) }), guidelinesVersion: z.string(),
    services: servicesSchema, bank: z.object({ bankCode: z.string().min(1), bankName: z.string().min(2).max(80), accountNumber: z.string().regex(/^\d{10}$/), confirmedName: z.string().min(2).max(120) }),
    displayName: z.string().trim().min(2).max(50).optional(), bio: z.string().max(500).optional(),
  }).parse(req.body);
  const dob = new Date(`${b.dob}T00:00:00Z`); const age = (Date.now() - dob.getTime()) / (365.25 * 864e5);
  if (isNaN(dob) || age < 18 || age > 120) throw new ApiError(400, 'You must be 18 or older to become a creator');
  if (b.guidelinesVersion !== GUIDELINES_VERSION) throw new ApiError(409, 'The guidelines were updated. Please read and accept them again.', 'GUIDELINES_CHANGED');
  const holder = await resolveName(b.bank); // asked of the bank again: never trust what the browser says
  if (env.paymentProvider === 'paystack' && !namesOverlap(b.legalName, holder)) throw new ApiError(422, 'The name on this bank account does not match your legal name. Use an account in your own name.', 'NAME_MISMATCH');
  await applyServices(req.user, b.services);
  await saveVerifiedAccount(req.user, b.bank); // re-verifies the name, registers the recipient, saves it (last 4 digits only)
  req.user.creatorApplication = { legalName: b.legalName, dob, phone: normPhone(b.phone), country: b.country, contentCategory: b.contentCategory, guidelinesAcceptedAt: new Date(), guidelinesVersion: GUIDELINES_VERSION, submittedAt: new Date() };
  req.user.category = 'Personal'; if (b.displayName) req.user.displayName = b.displayName; if (b.bio) req.user.bio = b.bio;
  req.user.accountMode = 'CREATOR'; req.user.creatorSince ||= new Date(); await req.user.save();
  await notify(req.user._id, 'CREATOR', 'Your creator account is ready. Welcome!', '/studio');
  res.status(201).json({ ok: true });
}));
// Old one-click endpoint is closed on purpose.
r.post('/activate', (_q, _r, next) => next(new ApiError(409, 'Please complete the creator application first.', 'APPLICATION_REQUIRED')));

r.patch('/settings', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ subscriptionPricePoints: z.number().int().min(0).max(100000).optional(), showGiftSenders: z.boolean().optional(), bio: z.string().max(500).optional(), displayName: z.string().min(2).max(50).optional() }).parse(req.body);
  if (b.subscriptionPricePoints !== undefined) { req.user.services = { ...(req.user.services || {}), subscriptions: { enabled: b.subscriptionPricePoints > 0, ...(b.subscriptionPricePoints ? { pricePoints: b.subscriptionPricePoints } : {}) } }; req.user.markModified('services'); } // any price is allowed on every plan
  Object.assign(req.user, b); await req.user.save(); res.json({ ok: true });
}));
// Turn services on/off later and change their prices. Every creator chooses their own prices.
r.get('/services', requireCreator, asyncHandler(async (req, res) => res.json({ identityVerified: await isIdentityVerified(req.user._id), services: req.user.services || {}, subscriptionPricePoints: req.user.subscriptionPricePoints, requestSettings: req.user.requestSettings, meetup: { pricePoints: req.user.meetup?.pricePoints || 0, enabled: !!req.user.meetup?.enabled } })));
r.patch('/services', requireCreator, asyncHandler(async (req, res) => {
  const { services } = z.object({ services: servicesSchema }).parse(req.body);
  await applyServices(req.user, services); await req.user.save(); res.json({ services: req.user.services });
}));

// Special requests: creators set their own price floor and rules (regular users cannot).
r.patch('/request-settings', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), minPricePoints: z.number().int().min(1).max(100000), instructions: z.string().max(600).optional(), turnaroundDays: z.number().int().min(1).max(90) }).parse(req.body);
  req.user.requestSettings = b; await req.user.save(); res.json({ requestSettings: req.user.requestSettings });
}));
// Innercircle toggle (route keeps its old name /meetup): the backend requires an approved verification record. Enabling is impossible otherwise.
r.patch('/meetup', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), pricePoints: z.number().int().min(1).optional(), transportPoints: z.number().int().min(0).optional(), durationMin: z.number().int().min(15).max(480).optional(), area: z.string().max(120).optional(), noticeHours: z.number().int().min(1).optional(), cancelRule: z.string().max(500).optional() }).parse(req.body);
  if (b.enabled) {
    if (!(await isIdentityVerified(req.user._id))) throw new ApiError(403, 'Identity verification must be approved before enabling Innercircle', 'VERIFICATION_REQUIRED');
    if (!(b.pricePoints || req.user.meetup?.pricePoints)) throw new ApiError(400, 'Set an Innercircle price first');
  }
  req.user.meetup = { ...(req.user.meetup?.toObject?.() || {}), ...b }; await req.user.save();
  res.json({ meetup: req.user.meetup });
}));

r.get('/:id', asyncHandler(async (req, res) => {
  const u = await User.findOne({ $or: [{ _id: /^[0-9a-f]{24}$/i.test(req.params.id) ? req.params.id : null }, { username: req.params.id.toLowerCase() }] }).select('username displayName bio avatarUrl coverUrl creatorPlan category location accountMode meetup.enabled meetup.pricePoints meetup.transportPoints meetup.area meetup.durationMin meetup.cancelRule subscriptionPricePoints dmPolicy.mode dmPolicy.pricePoints requestSettings creatorSince services prefs.showOnline');
  if (!u) throw new ApiError(404, 'Not found');
  const subscribers = u.accountMode === 'CREATOR' ? await Subscription.countDocuments({ creatorId: u._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }) : 0;
  const [followers, following, isFollowing, sub, rt] = await Promise.all([
    Follow.countDocuments({ followeeId: u._id }), Follow.countDocuments({ followerId: u._id }),
    Follow.exists({ followerId: req.user._id, followeeId: u._id }),
    Subscription.exists({ subscriberId: req.user._id, creatorId: u._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }),
    Rating.aggregate([{ $match: { creatorId: u._id, status: 'VISIBLE' } }, { $group: { _id: null, avg: { $avg: '$stars' }, n: { $sum: 1 } } }]),
  ]);
  if (u.id !== req.user.id) User.updateOne({ _id: u._id }, { $inc: { profileViews: 1 } }).catch(() => {});
  const pub = u.toObject(); if (pub.meetup?.enabled && !(await isIdentityVerified(u._id))) pub.meetup.enabled = false; // Innercircle is only shown for verified creators
  const online = u.prefs?.showOnline !== false && isOnline(u._id); delete pub.prefs;
  res.json({ creator: { ...pub, online }, subscribers, followers, following, isFollowing: !!isFollowing, subscribed: !!sub, rating: rt[0] ? { avg: Math.round(rt[0].avg * 10) / 10, count: rt[0].n } : null });
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
