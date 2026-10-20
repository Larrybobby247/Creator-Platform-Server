import { Router } from 'express';
import { User } from '../../models/User.js';
import { PointTransaction, CreatorEarning, AuditLog } from '../../models/Finance.js';
import { Payout, Report, VerificationRecord, MeetupBooking, WebhookLog, ReferralReward } from '../../models/Extra.js';
import { Post } from '../../models/Social.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requirePermission } from '../../services/rbac.js';
import { getSetting } from '../../services/settings.js';
import { isId, rx } from '../../services/adminList.js';

const r = Router();
const OPEN_REPORT = ['NEW', 'UNDER_REVIEW', 'ACTION_REQUIRED'];
const TZ = 'Africa/Lagos';
function range(req) {
  const now = new Date(); const key = String(req.query.range || '30d'); let from, to = now;
  if (key === 'today') { from = new Date(now); from.setHours(0, 0, 0, 0); }
  else if (key === 'custom' && req.query.from) { from = new Date(req.query.from); if (req.query.to) { to = new Date(`${req.query.to}T23:59:59.999Z`); } if (isNaN(from) || isNaN(to) || to < from) { from = new Date(now - 30 * 864e5); to = now; } }
  else { const d = { '7d': 7, '30d': 30, '90d': 90 }[key] || 30; from = new Date(now - d * 864e5); }
  if (to - from > 180 * 864e5) from = new Date(to - 180 * 864e5);
  const len = to - from; return { from, to, prevFrom: new Date(from - len), prevTo: from };
}
const pct = (c, p) => (p > 0 ? Math.round(((c - p) / p) * 100) : null);
const sum = async (Model, match, field) => (await Model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` }, n: { $sum: 1 } } }]))[0] || { v: 0, n: 0 };
const between = (f, a, b) => ({ [f]: { $gte: a, $lt: b } });

async function periodMetrics(a, b) {
  const [users, creators, volume, commission, promo, earnings, refunds] = await Promise.all([
    User.countDocuments(between('createdAt', a, b)), User.countDocuments(between('creatorSince', a, b)),
    sum(PointTransaction, { type: 'POINT_PURCHASE', status: 'COMPLETED', ...between('completedAt', a, b) }, 'nairaAmount'),
    sum(CreatorEarning, { status: { $ne: 'REVERSED' }, ...between('createdAt', a, b) }, 'commission'),
    sum(PointTransaction, { type: { $in: ['PROMOTION_PURCHASE', 'PRO_PLAN'] }, status: 'COMPLETED', ...between('completedAt', a, b) }, 'amount'),
    sum(CreatorEarning, { status: { $ne: 'REVERSED' }, ...between('createdAt', a, b) }, 'net'),
    sum(PointTransaction, { type: 'REVERSAL', status: 'COMPLETED', ...between('createdAt', a, b) }, 'amount'),
  ]);
  return { newUsers: users, newCreators: creators, volumeNaira: volume.v, volumeCount: volume.n, revenuePoints: commission.v + promo.v, commissionPoints: commission.v, promoPoints: promo.v, earningsPoints: earnings.v, refundPoints: refunds.v };
}

r.get('/dashboard', requirePermission('dashboard.read'), asyncHandler(async (req, res) => {
  const { from, to, prevFrom, prevTo } = range(req); const rate = await getSetting('nairaPerPoint');
  const [cur, prev, totalUsers, totalCreators, avail, paid, inflight, pendVer, openReports] = await Promise.all([
    periodMetrics(from, new Date(to.getTime() + 1)), periodMetrics(prevFrom, prevTo), User.estimatedDocumentCount(), User.countDocuments({ accountMode: 'CREATOR' }),
    sum(CreatorEarning, { status: 'AVAILABLE' }, 'net'), sum(Payout, { status: 'PAID' }, 'amountPoints'),
    sum(Payout, { status: { $in: ['PENDING', 'PROCESSING'] } }, 'nairaAmount'), VerificationRecord.countDocuments({ status: { $in: ['PENDING', 'REQUIRES_REVIEW'] } }), Report.countDocuments({ status: { $in: OPEN_REPORT } }),
  ]);
  const inflightPts = (await sum(Payout, { status: { $in: ['PENDING', 'PROCESSING'] } }, 'amountPoints')).v;
  res.json({ range: { from, to }, nairaPerPoint: rate,
    users: { total: totalUsers, new: cur.newUsers, changePct: pct(cur.newUsers, prev.newUsers) },
    creators: { total: totalCreators, new: cur.newCreators, changePct: pct(cur.newCreators, prev.newCreators) },
    paymentVolume: { naira: cur.volumeNaira, count: cur.volumeCount, changePct: pct(cur.volumeNaira, prev.volumeNaira), note: 'Money collected from point purchases. This is not profit.' },
    platformRevenue: { points: cur.revenuePoints, naira: cur.revenuePoints * rate, commissionPoints: cur.commissionPoints, promotionAndPlanPoints: cur.promoPoints, changePct: pct(cur.revenuePoints, prev.revenuePoints), note: 'Creator commission + promotion + Pro plan spend, valued at the current point rate.' },
    creatorEarningsPayable: { points: Math.max(0, avail.v - paid.v - inflightPts), naira: Math.max(0, avail.v - paid.v - inflightPts) * rate, note: 'Available creator earnings not yet paid out or requested.' },
    pendingPayouts: { count: inflight.n, naira: inflight.v }, pendingVerification: pendVer, openReports,
    refunds: { points: cur.refundPoints }, creatorEarnings: { points: cur.earningsPoints } });
}));

function days(from, to) { const out = []; const d = new Date(from); d.setHours(0, 0, 0, 0); while (d <= to && out.length < 181) { out.push(new Date(d).toLocaleDateString('en-CA', { timeZone: TZ })); d.setDate(d.getDate() + 1); } return out; }
const byDay = (Model, match, field, valueExpr) => Model.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: TZ } }, v: { $sum: valueExpr } } }]);
r.get('/dashboard/series', requirePermission('dashboard.read'), asyncHandler(async (req, res) => {
  const { from, to } = range(req); const metric = String(req.query.metric || 'volume'); const win = { $gte: from, $lte: to }; let rows = [], unit = 'NGN';
  if (metric === 'volume') rows = await byDay(PointTransaction, { type: 'POINT_PURCHASE', status: 'COMPLETED', completedAt: win }, 'completedAt', '$nairaAmount');
  else if (metric === 'earnings') { unit = 'points'; rows = await byDay(CreatorEarning, { status: { $ne: 'REVERSED' }, createdAt: win }, 'createdAt', '$net'); }
  else if (metric === 'refunds') { unit = 'points'; rows = await byDay(PointTransaction, { type: 'REVERSAL', status: 'COMPLETED', createdAt: win }, 'createdAt', '$amount'); }
  else if (metric === 'revenue') { unit = 'points'; const [a, b] = await Promise.all([byDay(CreatorEarning, { status: { $ne: 'REVERSED' }, createdAt: win }, 'createdAt', '$commission'), byDay(PointTransaction, { type: { $in: ['PROMOTION_PURCHASE', 'PRO_PLAN'] }, status: 'COMPLETED', completedAt: win }, 'completedAt', '$amount')]); const m = {}; for (const x of [...a, ...b]) m[x._id] = (m[x._id] || 0) + x.v; rows = Object.entries(m).map(([k, v]) => ({ _id: k, v })); }
  const m = Object.fromEntries(rows.map((x) => [x._id, x.v])); res.json({ metric, unit, points: days(from, to).map((d) => ({ date: d, value: m[d] || 0 })) });
}));
r.get('/dashboard/growth', requirePermission('dashboard.read'), asyncHandler(async (req, res) => {
  const { from, to } = range(req); const win = { $gte: from, $lte: to };
  const [reg, cre] = await Promise.all([byDay(User, { createdAt: win }, 'createdAt', 1), byDay(User, { creatorSince: win }, 'creatorSince', 1)]);
  const a = Object.fromEntries(reg.map((x) => [x._id, x.v])), b = Object.fromEntries(cre.map((x) => [x._id, x.v]));
  res.json({ days: days(from, to).map((d) => ({ date: d, registrations: a[d] || 0, creatorActivations: b[d] || 0 })), returningActive: null, note: 'Returning-active history is not tracked (only the latest activity time is stored).' });
}));
r.get('/dashboard/breakdown', requirePermission('dashboard.read'), asyncHandler(async (req, res) => {
  const { from, to } = range(req); const win = { $gte: from, $lte: to };
  const [spend, volume, earn] = await Promise.all([
    PointTransaction.aggregate([{ $match: { direction: 'DEBIT', status: 'COMPLETED', completedAt: win } }, { $group: { _id: '$type', points: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { points: -1 } }]),
    sum(PointTransaction, { type: 'POINT_PURCHASE', status: 'COMPLETED', completedAt: win }, 'nairaAmount'),
    CreatorEarning.aggregate([{ $match: { status: { $ne: 'REVERSED' }, createdAt: win } }, { $group: { _id: null, gross: { $sum: '$gross' }, net: { $sum: '$net' }, commission: { $sum: '$commission' } } }]),
  ]);
  res.json({ spendByType: spend.map((s) => ({ type: s._id, points: s.points, count: s.count })), pointPurchasesNaira: volume.v, creatorSales: earn[0] || { gross: 0, net: 0, commission: 0 } });
}));

r.get('/dashboard/pending', requirePermission('dashboard.read'), asyncHandler(async (req, res) => {
  const can = (p) => req.perms.has(p); const week = new Date(Date.now() - 7 * 864e5);
  const [ver, rep, pay, disp, hooks] = await Promise.all([
    can('verification.read') ? VerificationRecord.find({ status: { $in: ['PENDING', 'REQUIRES_REVIEW'] } }).sort('createdAt').limit(5).populate('userId', 'username').lean() : [],
    can('reports.read') ? Report.find({ status: { $in: OPEN_REPORT } }).sort({ createdAt: 1 }).limit(5).lean() : [],
    can('payouts.read') ? Payout.find({ status: 'PENDING' }).sort('createdAt').limit(5).populate('creatorId', 'username').lean() : [],
    can('meetups.read') ? MeetupBooking.find({ status: 'DISPUTED' }).sort('updatedAt').limit(5).lean() : [],
    can('health.read') ? WebhookLog.find({ ok: false, createdAt: { $gte: week } }).sort('-createdAt').limit(5).lean() : [],
  ]);
  const items = [
    ...ver.map((v) => ({ kind: 'verification', label: `Verification ${v.status.toLowerCase().replace('_', ' ')}: @${v.userId?.username}`, since: v.createdAt, link: '/verification', urgent: v.status === 'REQUIRES_REVIEW' })),
    ...rep.map((x) => ({ kind: 'report', label: `${x.priority === 'HIGH' ? 'High priority r' : 'R'}eport (${x.category.toLowerCase().replace(/_/g, ' ')})`, since: x.createdAt, link: `/reports/${x._id}`, urgent: x.priority === 'HIGH' })),
    ...pay.map((p) => ({ kind: 'payout', label: `Payout request: @${p.creatorId?.username} ₦${p.nairaAmount.toLocaleString()}`, since: p.createdAt, link: '/payouts', urgent: Date.now() - p.createdAt > 2 * 864e5 })),
    ...disp.map((d) => ({ kind: 'dispute', label: 'Meetup dispute awaiting a decision', since: d.updatedAt, link: '/meetups?status=DISPUTED', urgent: true })),
    ...hooks.map((h) => ({ kind: 'webhook', label: `Failed ${h.provider} event: ${h.event}`, since: h.createdAt, link: '/health', urgent: true })),
  ].sort((a, b) => Number(b.urgent) - Number(a.urgent) || new Date(a.since) - new Date(b.since));
  res.json({ items });
}));

r.get('/dashboard/activity', requirePermission('dashboard.read'), asyncHandler(async (req, res) => {
  const [u, c, p, po, rp, v, au] = await Promise.all([
    User.find().sort('-createdAt').limit(6).select('username createdAt').lean(), User.find({ creatorSince: { $ne: null } }).sort('-creatorSince').limit(5).select('username creatorSince').lean(),
    PointTransaction.find({ type: 'POINT_PURCHASE', status: 'COMPLETED' }).sort('-completedAt').limit(5).populate('userId', 'username').select('nairaAmount completedAt userId').lean(),
    Payout.find({ status: 'PAID' }).sort('-updatedAt').limit(5).populate('creatorId', 'username').lean(), Report.find().sort('-createdAt').limit(5).select('category createdAt').lean(),
    VerificationRecord.find({ status: { $ne: 'PENDING' } }).sort('-updatedAt').limit(5).populate('userId', 'username').select('status updatedAt userId').lean(),
    req.perms.has('audit_logs.read') ? AuditLog.find({ action: { $nin: ['ADMIN_LOGIN', 'ADMIN_LOGIN_FAILED'] } }).sort('-createdAt').limit(8).select('action createdAt').lean() : [],
  ]);
  const items = [...u.map((x) => ({ type: 'user', text: `@${x.username} joined`, at: x.createdAt })), ...c.map((x) => ({ type: 'creator', text: `@${x.username} became a creator`, at: x.creatorSince })),
    ...p.map((x) => ({ type: 'payment', text: `@${x.userId?.username} paid ₦${(x.nairaAmount || 0).toLocaleString()}`, at: x.completedAt })), ...po.map((x) => ({ type: 'payout', text: `Payout of ₦${x.nairaAmount.toLocaleString()} completed for @${x.creatorId?.username}`, at: x.updatedAt })),
    ...rp.map((x) => ({ type: 'report', text: `New report: ${x.category.toLowerCase().replace(/_/g, ' ')}`, at: x.createdAt })), ...v.map((x) => ({ type: 'verification', text: `Verification ${x.status.toLowerCase()}: @${x.userId?.username}`, at: x.updatedAt })),
    ...au.map((x) => ({ type: 'admin', text: `Admin action: ${x.action.toLowerCase().replace(/_/g, ' ')}`, at: x.createdAt }))].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
  res.json({ items });
}));

// Sidebar attention badges: real counts, only for sections the admin may open.
r.get('/badges', asyncHandler(async (req, res) => {
  const can = (p) => req.perms.has(p); const day = new Date(Date.now() - 864e5);
  const [verification, reports, payouts, disputes, content, referrals, webhooks] = await Promise.all([
    can('verification.read') ? VerificationRecord.countDocuments({ status: { $in: ['PENDING', 'REQUIRES_REVIEW'] } }) : 0, can('reports.read') ? Report.countDocuments({ status: { $in: OPEN_REPORT } }) : 0,
    can('payouts.read') ? Payout.countDocuments({ status: 'PENDING' }) : 0, can('meetups.read') ? MeetupBooking.countDocuments({ status: 'DISPUTED' }) : 0,
    can('content.read') ? Post.countDocuments({ 'moderation.status': 'UNDER_REVIEW' }) : 0, can('referrals.read') ? ReferralReward.countDocuments({ status: 'PENDING', flagged: true }) : 0,
    can('health.read') ? WebhookLog.countDocuments({ ok: false, createdAt: { $gte: day } }) : 0]);
  res.json({ verification, reports, payouts, disputes, content, referrals, health: webhooks });
}));

r.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim(); if (q.length < 2) return res.json({ users: [], transactions: [], reports: [] });
  const [users, tx, rep] = await Promise.all([
    req.perms.has('users.read') ? User.find({ $or: [{ username: rx(q) }, { email: rx(q) }, { displayName: rx(q) }, ...(isId(q) ? [{ _id: q }] : [])] }).limit(6).select('username email accountMode').lean() : [],
    req.perms.has('transactions.read') ? PointTransaction.find({ $or: [{ reference: rx(q) }, ...(isId(q) ? [{ _id: q }] : [])] }).limit(6).select('reference type status').lean() : [],
    req.perms.has('reports.read') && isId(q) ? Report.find({ _id: q }).select('category status').lean() : [],
  ]);
  res.json({ users, transactions: tx, reports: rep });
}));
export default r;
