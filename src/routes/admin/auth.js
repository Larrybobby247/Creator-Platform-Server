import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ADMIN_COOKIE, signAdmin, adminAuthenticate } from '../../middleware/adminAuth.js';
import { audit } from '../../services/audit.js';

const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, handler: (_q, res) => res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' }) });
const cookie = {
  httpOnly: true,
  sameSite: env.prod ? 'none' : 'lax',
  secure: env.prod,
  maxAge: 8 * 3600e3,
  path: '/'
};

const DUMMY = bcrypt.hashSync('not-a-real-password', 10); // equalises timing for unknown emails
export const me = (u, perms) => ({ id: u.id, name: u.displayName || u.username, username: u.username, email: u.email, role: u.adminRole, avatarUrl: u.avatarUrl, permissions: [...perms] });

r.post('/login', limiter, asyncHandler(async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(req.body);
  const u = await User.findOne({ email: b.email.toLowerCase() }).select('+passwordHash');
  const ok = await bcrypt.compare(b.password, u?.passwordHash || DUMMY);
  if (!u || !ok || u.role !== 'ADMIN' || !u.adminRole || u.accountStatus !== 'ACTIVE' || !u.emailVerified) {
    await audit({ ip: req.ip }, 'ADMIN_LOGIN_FAILED', b.email.toLowerCase()); throw new ApiError(401, 'Invalid email or password'); // same message for every failure
  }
  await audit({ admin: u, ip: req.ip }, 'ADMIN_LOGIN', u.id);
  const { effectivePermissions } = await import('../../services/rbac.js');
  res.cookie(ADMIN_COOKIE, signAdmin(u), cookie).json({ admin: me(u, effectivePermissions(u)) });
}));
r.post('/logout', (_q, res) => res.clearCookie(ADMIN_COOKIE, { path: '/' }).json({ ok: true }));
r.get('/me', adminAuthenticate, (req, res) => res.json({ admin: me(req.admin, req.perms) }));
r.put('/password', adminAuthenticate, asyncHandler(async (req, res) => {
  const b = z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters').max(200) }).parse(req.body);
  const u = await User.findById(req.admin._id).select('+passwordHash'); if (!(await bcrypt.compare(b.current, u.passwordHash))) throw new ApiError(400, 'Current password is wrong');
  u.passwordHash = await bcrypt.hash(b.next, 12); await u.save(); await audit(req, 'ADMIN_PASSWORD_CHANGED', u.id); res.json({ ok: true });
}));
export default r;
