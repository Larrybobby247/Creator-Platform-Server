import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Block, PushSub, ReferralReward, Follow } from '../models/Extra.js';
import { limitsFor, proBenefits } from '../services/plans.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireCreator } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { imageUpload, savePublicImage } from '../services/publicUpload.js';
import { spend } from '../services/pointLedger.js';
import { getSetting } from '../services/settings.js';
import { env } from '../config/env.js';

const r = Router();
r.get('/push/key', (_q, res) => res.json({ key: env.vapidPublic }));
r.use(authenticate);

const full = (u) => ({ gender: u.gender, age: u.age, dmPolicy: u.dmPolicy, requestSettings: u.requestSettings, usernameChangedAt: u.usernameChangedAt, id: u.id, username: u.username, email: u.email, displayName: u.displayName, bio: u.bio, location: u.location, avatarUrl: u.avatarUrl, coverUrl: u.coverUrl, accountMode: u.accountMode, creatorPlan: u.creatorPlan, proExpiresAt: u.proExpiresAt, prefs: u.prefs, subscriptionPricePoints: u.subscriptionPricePoints, showGiftSenders: u.showGiftSenders, hasPassword: true, referredBy: !!u.referredBy });
r.get('/me', (req, res) => res.json({ me: full(req.user) }));
r.patch('/me', asyncHandler(async (req, res) => {
  const b = z.object({ gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(), age: z.number().int().min(18, 'You must be 18 or older').max(120).optional(), displayName: z.string().min(2).max(50).optional(), bio: z.string().max(500).optional(), location: z.string().max(60).optional(),
    prefs: z.object({ messages: z.enum(['EVERYONE', 'REQUESTS']).optional(), showOnline: z.boolean().optional(), emailNotifs: z.boolean().optional(), push: z.boolean().optional(), promoNotifs: z.boolean().optional() }).optional() }).parse(req.body);
  const { prefs, ...rest } = b; Object.assign(req.user, rest); if (prefs) Object.assign(req.user.prefs, prefs); await req.user.save();
  res.json({ me: full(req.user) });
}));
// Username change: unique, 3-24 chars, at most once every 7 days.
r.patch('/me/username', asyncHandler(async (req, res) => {
  const { username } = z.object({ username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i, 'Letters, numbers and underscores only') }).parse(req.body); const next = username.toLowerCase();
  if (next === req.user.username) return res.json({ me: full(req.user) });
  if (req.user.usernameChangedAt && Date.now() - req.user.usernameChangedAt < 7 * 864e5) throw new ApiError(429, 'You can change your username once every 7 days.', 'USERNAME_COOLDOWN');
  if (await User.exists({ username: next })) throw new ApiError(409, 'That username is taken');
  req.user.username = next; req.user.usernameChangedAt = new Date(); await req.user.save().catch((e) => { if (e.code === 11000) throw new ApiError(409, 'That username is taken'); throw e; });
  res.json({ me: full(req.user) });
}));
// Creator-only: who may message you (open / paid / subscribers only).
r.patch('/me/dm', requireCreator, asyncHandler(async (req, res) => {
  const b = z.object({ mode: z.enum(['OPEN', 'PAID', 'SUBSCRIBERS']), pricePoints: z.number().int().min(0).optional() }).parse(req.body);
  if (b.mode === 'PAID') { const lim = await limitsFor(req.user); if (!(b.pricePoints >= 1)) throw new ApiError(400, 'Set a price of at least 1 point'); if (b.pricePoints > lim.maxUnlockPoints) throw new ApiError(400, `Your plan allows up to ${lim.maxUnlockPoints} points. Upgrade to Pro for more.`, 'PLAN_LIMIT'); }
  req.user.dmPolicy = { mode: b.mode, pricePoints: b.mode === 'PAID' ? b.pricePoints : (req.user.dmPolicy?.pricePoints || 0) }; await req.user.save(); res.json({ dmPolicy: req.user.dmPolicy });
}));
// Your own followers / following (so you can follow back or unfollow).
const listPeople = (dir) => asyncHandler(async (req, res) => {
  const me = req.user._id; const mine = dir === 'following'; const q = mine ? { followerId: me } : { followeeId: me }; const SIZE = 30; const page = Math.max(0, Number(req.query.page) || 0);
  const rows = await Follow.find(q).sort('-createdAt').skip(page * SIZE).limit(SIZE + 1).populate(mine ? 'followeeId' : 'followerId', 'username displayName avatarUrl accountMode creatorPlan').lean();
  const more = rows.length > SIZE; if (more) rows.pop(); const users = rows.map((x) => (mine ? x.followeeId : x.followerId)).filter(Boolean);
  const back = mine ? new Set(users.map((u) => String(u._id))) : new Set((await Follow.find({ followerId: me, followeeId: { $in: users.map((u) => u._id) } }).select('followeeId').lean()).map((x) => String(x.followeeId)));
  res.json({ users: users.map((u) => ({ ...u, following: back.has(String(u._id)) })), hasMore: more, total: await Follow.countDocuments(q) });
});
r.get('/me/followers', listPeople('followers')); r.get('/me/following', listPeople('following'));
r.post('/me/avatar', imageUpload, asyncHandler(async (req, res) => { req.user.avatarUrl = await savePublicImage(req.file); await req.user.save(); res.json({ url: req.user.avatarUrl }); }));
r.post('/me/cover', imageUpload, asyncHandler(async (req, res) => { req.user.coverUrl = await savePublicImage(req.file); await req.user.save(); res.json({ url: req.user.coverUrl }); }));
r.post('/me/cover-post', requireCreator, imageUpload, asyncHandler(async (req, res) => res.json({ url: await savePublicImage(req.file) })));
r.put('/me/password', asyncHandler(async (req, res) => {
  const b = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
  const u = await User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(b.current, u.passwordHash))) throw new ApiError(400, 'Current password is wrong');
  u.passwordHash = await bcrypt.hash(b.next, 12); await u.save(); res.json({ ok: true });
}));

r.get('/blocks', asyncHandler(async (req, res) => res.json({ items: await Block.find({ blockerId: req.user._id }).populate('blockedId', 'username displayName avatarUrl') })));
r.delete('/block/:userId', asyncHandler(async (req, res) => { await Block.deleteOne({ blockerId: req.user._id, blockedId: req.params.userId }); res.json({ ok: true }); }));

// ---- Web push
r.post('/push/subscribe', asyncHandler(async (req, res) => {
  const b = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body);
  await PushSub.findOneAndUpdate({ endpoint: b.endpoint }, { userId: req.user._id, keys: b.keys }, { upsert: true });
  req.user.prefs.push = true; await req.user.save(); res.json({ ok: true });
}));
r.post('/push/unsubscribe', asyncHandler(async (req, res) => { await PushSub.deleteMany({ userId: req.user._id }); req.user.prefs.push = false; await req.user.save(); res.json({ ok: true }); }));

// ---- Referral claim (only for accounts that registered without a link, soon after signup)
r.post('/referrals/claim', asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().min(4).max(20) }).parse(req.body);
  if (req.user.referredBy) throw new ApiError(409, 'You already have a referrer');
  if (Date.now() - req.user.createdAt > 7 * 864e5) throw new ApiError(400, 'Referral codes can only be claimed in your first 7 days');
  const ref = await User.findOne({ referralCode: code });
  if (!ref || ref.id === req.user.id) throw new ApiError(400, 'Invalid code');
  if (await ReferralReward.exists({ referrerId: req.user._id, referredId: ref._id })) throw new ApiError(400, 'Not allowed'); // blocks referral loops
  req.user.referredBy = ref._id; await req.user.save(); res.json({ ok: true });
}));

// ---- Pro plan (paid in points; platform revenue, not creator earnings)
r.get('/pro', asyncHandler(async (_q, res) => res.json(await proBenefits())));
r.post('/pro/upgrade', requireCreator, asyncHandler(async (req, res) => {
  const [price, days] = await Promise.all([getSetting('proPricePoints'), getSetting('proDays')]);
  const key = `pro:${req.user.id}:${new Date().toISOString().slice(0, 10)}`; // one charge per day max
  const { duplicate } = await spend({ userId: req.user._id, type: 'PRO_PLAN', amount: price, idempotencyKey: key });
  if (duplicate) return res.json({ ok: true, duplicate: true });
  const base = req.user.proExpiresAt && req.user.proExpiresAt > new Date() ? req.user.proExpiresAt : new Date();
  req.user.creatorPlan = 'PRO'; req.user.proExpiresAt = new Date(base.getTime() + days * 864e5); await req.user.save();
  res.json({ ok: true, proExpiresAt: req.user.proExpiresAt });
}));
export default r;
