import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Wallet } from '../models/Finance.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate.js';
import { sendEmail, emailHtml } from '../services/email.js';

export const TERMS_VERSION = '2026-10';
const r = Router();
const sign = (u) => jwt.sign({ sub: u.id }, env.jwtSecret, { expiresIn: '7d' });
const cookie = {
  httpOnly: true,
  sameSite: env.prod ? 'none' : 'lax',
  secure: env.prod,
  maxAge: 8 * 3600e3,
  path: '/'
};

export const pub = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, accountMode: u.accountMode, creatorPlan: u.creatorPlan, role: u.role, referralCode: u.referralCode });

async function createUser({ username, email, passwordHash, ref, googleId, displayName, gender, age, emailVerified = false }) {
  const referrer = ref ? await User.findOne({ referralCode: ref }) : null;
  const u = await User.create({ username, email, passwordHash, googleId, displayName, referralCode: crypto.randomBytes(4).toString('hex'), referredBy: referrer?._id, emailVerified, gender, age, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION });
  await Wallet.create({ userId: u._id });
  return u;
}
// Single-use, hashed, 24h verification token. Accounts cannot log in until it is used.
async function issueVerification(u) {
  const token = crypto.randomBytes(32).toString('hex');
  u.emailVerifyHash = crypto.createHash('sha256').update(token).digest('hex'); u.emailVerifyExpires = new Date(Date.now() + 24 * 3600e3); u.emailVerifySentAt = new Date(); await u.save();
  const link = `${env.frontendUrl}/verify-email?token=${token}`;
  if (env.emailEnabled || process.env.NODE_ENV === 'test') return sendEmail(u.email, 'Verify your email address', `Welcome! Confirm your email to activate your account (link valid for 24 hours):\n\n${link}`, { html: emailHtml({ title: 'Confirm your email', lines: ['Welcome! Confirm your email address to activate your account.', 'This link is valid for 24 hours.'], cta: { label: 'Verify my email', url: link } }) });
  else if (!env.prod) console.log('[dev] email verification link:', link);
  return true;
}
const sensitive = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait a little and try again.', code: 'RATE_LIMITED' } });
const dupe = (e) => { if (e.code === 11000) throw new ApiError(409, 'Username or email already used'); throw e; };

r.post(['/register', '/signup'], sensitive, asyncHandler(async (req, res) => {
  const b = z.object({ username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i), email: z.string().email(), password: z.string().min(8), ref: z.string().optional(), gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(), age: z.number().int().min(18, 'You must be 18 or older to join').max(120).optional(), acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy' }) }) }).parse(req.body);
  if (env.prod && !env.emailEnabled) throw new ApiError(503, 'Sign-up is temporarily unavailable (email service not configured)', 'EMAIL_NOT_CONFIGURED');
  const { acceptTerms, ...rest } = b;
  const u = await createUser({ ...rest, passwordHash: await bcrypt.hash(b.password, 12) }).catch(dupe);
  const emailSent = await issueVerification(u);
  res.status(201).json({ pendingVerification: true, email: u.email, emailSent }); // deliberately no session cookie
}));

r.post('/login', asyncHandler(async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
  const u = await User.findOne({ email: b.email }).select('+passwordHash');
  if (!u || !(await bcrypt.compare(b.password, u.passwordHash))) throw new ApiError(401, 'Invalid credentials');
  if (!u.emailVerified) return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox or request a new link.', code: 'EMAIL_NOT_VERIFIED', email: u.email });
  res.cookie('token', sign(u), cookie).json({ user: pub(u) });
}));

// Google Sign-In: client sends the Google ID token; we verify it server-side.
r.post('/google', asyncHandler(async (req, res) => {
  const b = z.object({ credential: z.string(), acceptTerms: z.boolean().optional(), ref: z.string().optional() }).parse(req.body);
  if (!env.googleClientId) throw new ApiError(503, 'Google sign-in is not configured');
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(b.credential)}`);
  const g = await resp.json();
  if (!resp.ok || g.aud !== env.googleClientId || g.email_verified !== 'true') throw new ApiError(401, 'Google sign-in failed');
  let u = await User.findOne({ $or: [{ googleId: g.sub }, { email: g.email.toLowerCase() }] });
  if (!u) {
    if (b.acceptTerms !== true) throw new ApiError(400, 'You must accept the Terms and Privacy Policy');
    const base = g.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18) || 'user';
    u = await createUser({ username: `${base}${crypto.randomInt(100, 999)}`, email: g.email.toLowerCase(), passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), googleId: g.sub, displayName: g.name, ref: b.ref, emailVerified: true }).catch(dupe);
  } else if (!u.googleId || !u.emailVerified) { u.googleId ||= g.sub; u.emailVerified = true; await u.save(); } // Google already verified this address
  res.cookie('token', sign(u), cookie).json({ user: pub(u), created: false });
}));

// Password reset: single-use, hashed, 30-minute token. Same response whether or not the email exists.
r.post('/verify-email', sensitive, asyncHandler(async (req, res) => {
  const { token } = z.object({ token: z.string().length(64) }).parse(req.body);
  const u = await User.findOne({ emailVerifyHash: crypto.createHash('sha256').update(token).digest('hex'), emailVerifyExpires: { $gt: new Date() } });
  if (!u) throw new ApiError(400, 'This verification link is invalid, expired or already used. Request a new one.', 'INVALID_TOKEN');
  u.emailVerified = true; u.emailVerifyHash = undefined; u.emailVerifyExpires = undefined; await u.save();
  res.json({ ok: true });
}));
// Same response whether or not the account exists; 60-second cooldown per account.
r.post('/resend-verification', sensitive, asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const u = await User.findOne({ email: email.toLowerCase() });
  if (u && !u.emailVerified && (!u.emailVerifySentAt || Date.now() - u.emailVerifySentAt > 60e3)) await issueVerification(u);
  res.json({ ok: true });
}));
r.post('/forgot', sensitive, asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const u = await User.findOne({ email: email.toLowerCase() });
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    u.resetHash = crypto.createHash('sha256').update(token).digest('hex'); u.resetExpires = new Date(Date.now() + 30 * 60e3); await u.save();
    const link = `${env.frontendUrl}/reset?token=${token}`;
    if (env.emailEnabled) sendEmail(u.email, 'Reset your password', `Use this link within 30 minutes:\n${link}`, { html: emailHtml({ title: 'Reset your password', lines: ['We received a request to reset your password.', 'The link below works for 30 minutes. If this was not you, ignore this email.'], cta: { label: 'Choose a new password', url: link } }) }); else if (!env.prod) console.log('[dev] password reset link:', link);
  }
  res.json({ ok: true });
}));
r.post('/reset', asyncHandler(async (req, res) => {
  const b = z.object({ token: z.string().length(64), password: z.string().min(8) }).parse(req.body);
  const u = await User.findOne({ resetHash: crypto.createHash('sha256').update(b.token).digest('hex'), resetExpires: { $gt: new Date() } });
  if (!u) throw new ApiError(400, 'This reset link is invalid or has expired');
  u.passwordHash = await bcrypt.hash(b.password, 12); u.resetHash = undefined; u.resetExpires = undefined; await u.save(); res.json({ ok: true });
}));
r.post('/logout', (_q, res) => res.clearCookie('token').json({ ok: true }));
r.get('/me', authenticate, (req, res) => res.json({ user: pub(req.user) }));
r.get('/config', (_q, res) => { res.set('Cache-Control', 'public, max-age=300'); res.json({ googleClientId: env.googleClientId, termsVersion: TERMS_VERSION, paymentProvider: env.paymentProvider }); });
export default r;
