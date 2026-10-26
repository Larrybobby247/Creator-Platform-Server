import { Router } from 'express';
import fs from 'fs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { AuditLog } from '../../models/Finance.js';
import { WebhookLog } from '../../models/Extra.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { requirePermission as need, PERMISSIONS, ROLE_PERMISSIONS } from '../../services/rbac.js';
import { audit } from '../../services/audit.js';
import { paged, rx, isId, dateRange } from '../../services/adminList.js';
import { getSetting, setSetting, DEFAULTS } from '../../services/settings.js';
import { resolveDojahConfig } from '../../services/dojahConfig.js';
import { env } from '../../config/env.js';
import { recentErrors } from '../../middleware/errorHandler.js';
import { jobStatus } from '../../jobs/index.js';

const r = Router();
const pos = z.number().int().positive(), nn = z.number().int().min(0), pair = (s) => z.object({ DEFAULT: s, PRO: s });
const SCHEMAS = {
  platform: z.object({ name: z.string().trim().min(2).max(40), tagline: z.string().trim().max(120), supportEmail: z.string().email(), logoUrl: z.string().max(300).optional().default(''), currency: z.literal('NGN'), timezone: z.string().min(3).max(60) }),
  nairaPerPoint: pos, commissionBps: z.number().int().min(0).max(10000), proCommissionBps: z.number().int().min(0).max(10000), maxPurchasePoints: pos, minPayoutPoints: pos, verificationFeeKobo: nn,
  videoLimitSec: pair(pos), maxUploadBytes: pos, previewMaxSec: pos, voiceMaxSec: pos,
  planLimits: z.object({ exclusivePostsPerMonth: pair(nn), pinnedPosts: z.object({ USER: nn, DEFAULT: nn, PRO: nn }), advancedAnalytics: pair(z.boolean()) }),
  promoPrices: z.object({ DAY1: pos, DAY3: pos, DAY7: pos }), referralBps: z.number().int().min(0).max(10000), referralDays: pos, referralHoldDays: nn,
  meetupDisputeHours: nn, meetupRequestExpiryHours: pos, proPricePoints: pos, proDays: pos,
};
const GROUPS = { General: ['platform'], 'Pricing and fees': ['nairaPerPoint', 'commissionBps', 'proCommissionBps', 'maxPurchasePoints', 'minPayoutPoints', 'proPricePoints', 'proDays', 'planLimits', 'promoPrices', 'verificationFeeKobo'], Content: ['videoLimitSec', 'maxUploadBytes', 'previewMaxSec', 'voiceMaxSec'], Referrals: ['referralBps', 'referralDays', 'referralHoldDays'], Meetups: ['meetupDisputeHours', 'meetupRequestExpiryHours'] };
const HIGH_IMPACT = new Set(['nairaPerPoint', 'commissionBps', 'proCommissionBps', 'proCommissionBps', 'maxPurchasePoints', 'planLimits']);

r.get('/settings', need('settings.read'), asyncHandler(async (_q, res) => { const values = {}; for (const k of Object.keys(SCHEMAS)) values[k] = await getSetting(k); res.json({ values, groups: GROUPS, highImpact: [...HIGH_IMPACT] }); }));
r.put('/settings/:key', need('settings.manage'), asyncHandler(async (req, res) => {
  const key = req.params.key; const schema = SCHEMAS[key]; if (!schema) throw new ApiError(404, 'Unknown setting');
  const { value, reason, confirm } = z.object({ value: z.any(), reason: z.string().trim().max(500).optional(), confirm: z.boolean().optional() }).parse(req.body); const parsed = schema.parse(value);
  if (HIGH_IMPACT.has(key) && (!confirm || (reason || '').length < 5)) throw new ApiError(400, 'This is a high-impact change: confirm it and give a reason.', 'CONFIRM_REQUIRED');
  const before = await getSetting(key); await setSetting(key, parsed); // changing the rate never rewrites past transactions (each stores its own rate)
  await audit(req, 'SETTING_CHANGED', key, { reason, before, after: parsed }); res.json({ ok: true });
}));
r.get('/settings/:key/history', need('settings.read'), asyncHandler(async (req, res) => res.json({ items: await AuditLog.find({ action: 'SETTING_CHANGED', target: req.params.key }).sort('-createdAt').limit(20).populate('actorId', 'username').select('before after reason createdAt actorId').lean() })));

// ================= admin accounts & roles =================
import { imageUpload, savePublicImage } from '../../services/publicUpload.js';
r.post('/settings/logo', need('settings.manage'), imageUpload, asyncHandler(async (req, res) => res.json({ url: await savePublicImage(req.file) })));
const roleEnum = z.enum(['SUPER_ADMIN', 'FINANCE', 'MODERATOR', 'SUPPORT', 'VERIFICATION']);
const supers = () => User.countDocuments({ role: 'ADMIN', adminRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE' });
r.get('/roles', need('admins.manage'), asyncHandler(async (_q, res) => res.json({ roles: ROLE_PERMISSIONS, permissions: PERMISSIONS, admins: await User.find({ role: 'ADMIN' }).select('username email adminRole adminPermissions lastActiveAt accountStatus').lean() })));
r.post('/roles/grant', need('admins.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ identifier: z.string().min(3), adminRole: roleEnum, reason: z.string().trim().min(5).max(300) }).parse(req.body);
  const u = await User.findOne({ $or: [{ email: b.identifier.toLowerCase() }, { username: b.identifier.toLowerCase() }] }); if (!u || !u.emailVerified || u.accountStatus !== 'ACTIVE') throw new ApiError(404, 'No verified, active account matches that email or username');
  u.role = 'ADMIN'; u.adminRole = b.adminRole; u.adminPermissions = []; await u.save(); await audit(req, 'ADMIN_GRANTED', u.id, { reason: b.reason, after: { role: b.adminRole } }); res.json({ ok: true });
}));
r.put('/roles/:userId', need('admins.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ adminRole: roleEnum, adminPermissions: z.array(z.enum(PERMISSIONS)).default([]), reason: z.string().trim().min(5).max(300) }).parse(req.body);
  if (req.params.userId === req.admin.id) throw new ApiError(400, 'You cannot change your own role'); const u = await User.findOne({ _id: req.params.userId, role: 'ADMIN' }); if (!u) throw new ApiError(404, 'Admin not found');
  if (u.adminRole === 'SUPER_ADMIN' && b.adminRole !== 'SUPER_ADMIN' && (await supers()) <= 1) throw new ApiError(409, 'There must always be at least one Super Admin');
  const before = { role: u.adminRole, extra: u.adminPermissions }; u.adminRole = b.adminRole; u.adminPermissions = b.adminPermissions; await u.save(); await audit(req, 'ADMIN_ROLE_CHANGED', u.id, { reason: b.reason, before, after: { role: b.adminRole, extra: b.adminPermissions } }); res.json({ ok: true });
}));
r.delete('/roles/:userId', need('admins.manage'), asyncHandler(async (req, res) => {
  const reason = z.string().trim().min(5).max(300).parse(req.query.reason); if (req.params.userId === req.admin.id) throw new ApiError(400, 'You cannot remove your own admin access');
  const u = await User.findOne({ _id: req.params.userId, role: 'ADMIN' }); if (!u) throw new ApiError(404, 'Admin not found'); if (u.adminRole === 'SUPER_ADMIN' && (await supers()) <= 1) throw new ApiError(409, 'There must always be at least one Super Admin');
  u.role = 'USER'; u.adminRole = undefined; u.adminPermissions = []; await u.save(); await audit(req, 'ADMIN_REVOKED', u.id, { reason }); res.json({ ok: true });
}));

// ================= audit log (append-only: there is no update or delete route) =================
r.get('/audit-logs', need('audit_logs.read'), asyncHandler(async (req, res) => {
  const f = { ...dateRange(req) }; if (req.query.action) f.action = rx(String(req.query.action)); if (req.query.target) f.target = String(req.query.target);
  if (req.query.admin) f.actorId = { $in: (await User.find({ $or: [{ username: rx(String(req.query.admin)) }, ...(isId(String(req.query.admin)) ? [{ _id: req.query.admin }] : [])], role: 'ADMIN' }).select('_id').lean()).map((u) => u._id) };
  res.json(await paged(AuditLog, f, req, { sortable: ['createdAt'], select: 'actorId action target reason before after meta ip createdAt', populate: [['actorId', 'username']] }));
}));

// ================= system health: real checks, "unknown" where nothing can be measured =================
r.get('/health', need('health.read'), asyncHandler(async (_q, res) => {
  const t0 = Date.now(); let db = { status: 'down' };
  try { await mongoose.connection.db.admin().ping(); db = { status: 'ok', latencyMs: Date.now() - t0 }; } catch (e) { db = { status: 'down', detail: String(e.message).slice(0, 120) }; }
  const dir = (p) => { try { fs.mkdirSync(p, { recursive: true }); fs.accessSync(p, fs.constants.W_OK); return 'ok'; } catch { return 'not writable'; } };
  const since = new Date(Date.now() - 864e5); const [hookFail, hookOk, lastHooks] = await Promise.all([WebhookLog.countDocuments({ ok: false, createdAt: { $gte: since } }), WebhookLog.countDocuments({ ok: true, createdAt: { $gte: since } }), WebhookLog.find({ ok: false }).sort('-createdAt').limit(10).select('provider event reference error createdAt').lean()]);
  const dj = resolveDojahConfig();
  res.json({ checkedAt: new Date(), checks: [
    { name: 'Database', ...db },
    { name: 'Payment provider', status: env.paymentProvider === 'paystack' ? (env.paystackSecret ? 'configured' : 'misconfigured') : 'test mode (mock)', detail: env.paymentProvider === 'paystack' ? 'Key present; live connectivity is not probed.' : 'No real payments in this mode.' },
    { name: 'Payment webhooks (24h)', status: hookFail ? 'failures' : hookOk ? 'ok' : 'unknown', detail: `${hookOk} processed, ${hookFail} failed` },
    { name: 'Identity verification (Dojah)', status: dj.ok ? `configured (${dj.environment})` : `unavailable: ${dj.reason}` },
    { name: 'Email delivery (Resend)', status: env.emailEnabled ? 'configured' : 'not configured', detail: `Sender: ${env.mailFrom}. Delivery success is not tracked here; see the Resend dashboard.` },
    { name: 'Web push', status: env.vapidPublic && env.vapidPrivate ? 'configured' : 'not configured' },
    { name: 'Private media storage', status: env.cloudinaryEnabled ? 'Cloudinary (authenticated, not publicly reachable)' : `local disk fallback: ${dir(env.mediaDir)} (set CLOUDINARY_* for production)` }, { name: 'Public uploads', status: dir(env.publicDir) },
    { name: 'Google sign-in', status: env.googleClientId ? 'configured' : 'not configured' },
  ], jobs: Object.entries(jobStatus).map(([name, s]) => ({ name, ...s })), failedWebhooks: lastHooks, recentErrors, uptimeSec: Math.round(process.uptime()) });
}));
export default r;
