import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { Post, Gift, GiftTransaction } from '../../models/Social.js';
import { PointTransaction, CreatorEarning, Wallet, AuditLog } from '../../models/Finance.js';
import { Follow, VerificationRecord, Report, Community, CommunityMember, Rating, Subscription } from '../../models/Extra.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { requirePermission as need } from '../../services/rbac.js';
import { audit } from '../../services/audit.js';
import { paged, rx, isId, dateRange } from '../../services/adminList.js';
import { notify } from '../../services/notify.js';
import { signUrl } from '../../services/media.js';
import { imageUpload, savePublicImage } from '../../services/publicUpload.js';
import { earningsSummary } from '../studio.js';

const r = Router();
const reason = z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500);
const PUBLIC_USER = 'username displayName email avatarUrl accountMode creatorPlan accountStatus statusReason statusAt createdAt lastActiveAt role category location creatorSince';
const userSearch = (q) => (isId(q) ? { _id: q } : { $or: [{ username: rx(q) }, { email: rx(q) }, { displayName: rx(q) }] });
const idsFor = async (q) => (q ? (await User.find(userSearch(q)).limit(50).select('_id').lean()).map((u) => u._id) : null);

// ================= users =================
r.get('/users', need('users.read'), asyncHandler(async (req, res) => {
  const f = {}; const { type, verification, q } = req.query;
  if (q) Object.assign(f, userSearch(String(q)));
  if (type === 'user') f.accountMode = 'USER'; if (type === 'creator') f.accountMode = 'CREATOR'; if (type === 'pro') { f.accountMode = 'CREATOR'; f.creatorPlan = 'PRO'; }
  if (type === 'suspended') f.accountStatus = 'SUSPENDED'; if (type === 'restricted') f.accountStatus = 'RESTRICTED';
  if (verification) f._id = { $in: await VerificationRecord.distinct('userId', { status: String(verification) }) };
  res.json(await paged(User, f, req, { sortable: ['createdAt', 'username', 'lastActiveAt'], select: PUBLIC_USER }));
}));
r.get('/users/:id', need('users.read'), asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(400, 'Bad id'); const id = req.params.id;
  const u = await User.findById(id).select('-passwordHash -emailVerifyHash -resetHash -emailVerifyExpires -resetExpires -googleId').populate('adminNotes.by', 'username').lean(); if (!u) throw new ApiError(404, 'User not found');
  const [posts, followers, following, owned, joined, reportsAgainst, wallet, txByType, ver, reports, audits] = await Promise.all([
    Post.countDocuments({ authorId: id, status: 'PUBLISHED' }), Follow.countDocuments({ followeeId: id }), Follow.countDocuments({ followerId: id }), Community.countDocuments({ ownerId: id }), CommunityMember.countDocuments({ userId: id }),
    Report.countDocuments({ targetType: 'USER', targetId: id }), Wallet.findOne({ userId: id }).select('availablePoints reservedPoints').lean(),
    PointTransaction.aggregate([{ $match: { userId: u._id, status: 'COMPLETED' } }, { $group: { _id: { type: '$type', dir: '$direction' }, points: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    VerificationRecord.findOne({ userId: id }).sort('-createdAt').select('status providerEnv failReason createdAt').lean(),
    Report.find({ targetType: 'USER', targetId: id }).sort('-createdAt').limit(5).select('category status priority createdAt').lean(),
    req.perms.has('audit_logs.read') ? AuditLog.find({ target: id }).sort('-createdAt').limit(20).select('action reason createdAt actorId').populate('actorId', 'username').lean() : [],
  ]);
  res.json({ user: u, stats: { posts, followers, following, communitiesOwned: owned, communitiesJoined: joined, reportsAgainst }, wallet: req.perms.has('transactions.read') ? wallet : undefined, transactions: req.perms.has('transactions.read') ? txByType.map((t) => ({ type: t._id.type, direction: t._id.dir, points: t.points, count: t.count })) : undefined, verification: ver, reports, audit: audits });
}));
r.post('/users/:id/status', need('users.restrict'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['restrict', 'suspend', 'restore']), reason }).parse(req.body);
  if (req.params.id === req.admin.id) throw new ApiError(400, 'You cannot change your own account status');
  const u = await User.findById(req.params.id); if (!u) throw new ApiError(404, 'User not found');
  if (u.role === 'ADMIN' && req.admin.adminRole !== 'SUPER_ADMIN') throw new ApiError(403, 'Only a Super Admin can change an administrator account');
  const before = u.accountStatus; u.accountStatus = { restrict: 'RESTRICTED', suspend: 'SUSPENDED', restore: 'ACTIVE' }[b.action]; u.statusReason = b.action === 'restore' ? undefined : b.reason; u.statusAt = new Date(); u.statusBy = req.admin._id; await u.save();
  await audit(req, `USER_${b.action.toUpperCase()}`, u.id, { reason: b.reason, before: { status: before }, after: { status: u.accountStatus } });
  await notify(u._id, 'ACCOUNT', b.action === 'restore' ? 'Your account has been restored.' : `Your account was ${b.action === 'suspend' ? 'suspended' : 'restricted'}. Contact support for details.`, '/home');
  res.json({ ok: true, status: u.accountStatus });
}));
r.post('/users/:id/notes', need('users.read'), asyncHandler(async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(2).max(1000) }).parse(req.body);
  const u = await User.findByIdAndUpdate(req.params.id, { $push: { adminNotes: { text, by: req.admin._id, at: new Date() } } }); if (!u) throw new ApiError(404, 'User not found');
  await audit(req, 'USER_NOTE_ADDED', req.params.id); res.status(201).json({ ok: true });
}));
r.post('/users/:id/creator-disable', need('creators.manage'), asyncHandler(async (req, res) => {
  const { reason: why } = z.object({ reason }).parse(req.body); const u = await User.findOne({ _id: req.params.id, accountMode: 'CREATOR' }); if (!u) throw new ApiError(404, 'Creator not found');
  u.accountMode = 'USER'; u.meetup = { ...(u.meetup?.toObject?.() || {}), enabled: false }; await u.save(); // records and earnings are kept for disputes and compliance
  await audit(req, 'CREATOR_DISABLED', u.id, { reason: why, before: { accountMode: 'CREATOR' }, after: { accountMode: 'USER' } }); res.json({ ok: true });
}));

// ================= creators =================
r.get('/creators', need('creators.read'), asyncHandler(async (req, res) => {
  const f = { accountMode: 'CREATOR' }; const { status, q } = req.query;
  if (q) Object.assign(f, userSearch(String(q)));
  if (status === 'active') f.accountStatus = 'ACTIVE'; if (status === 'pro') f.creatorPlan = 'PRO'; if (status === 'restricted') f.accountStatus = 'RESTRICTED'; if (status === 'suspended') f.accountStatus = 'SUSPENDED';
  if (status === 'verified') f._id = { $in: await VerificationRecord.distinct('userId', { status: 'VERIFIED' }) };
  if (status === 'verification_pending') f._id = { $in: await VerificationRecord.distinct('userId', { status: { $in: ['PENDING', 'REQUIRES_REVIEW'] } }) };
  const out = await paged(User, f, req, { sortable: ['createdAt', 'creatorSince', 'username'], defaultSort: '-creatorSince', select: PUBLIC_USER });
  const ids = out.items.map((c) => c._id);
  const [fol, unl, gifts, earn, ver] = await Promise.all([
    Follow.aggregate([{ $match: { followeeId: { $in: ids } } }, { $group: { _id: '$followeeId', n: { $sum: 1 } } }]),
    PointTransaction.aggregate([{ $match: { creatorId: { $in: ids }, type: 'EXCLUSIVE_CONTENT_UNLOCK', status: 'COMPLETED' } }, { $group: { _id: '$creatorId', n: { $sum: 1 }, points: { $sum: '$amount' } } }]),
    GiftTransaction.aggregate([{ $match: { recipientId: { $in: ids }, status: 'COMPLETED' } }, { $group: { _id: '$recipientId', n: { $sum: '$quantity' } } }]),
    CreatorEarning.aggregate([{ $match: { creatorId: { $in: ids }, status: { $ne: 'REVERSED' } } }, { $group: { _id: '$creatorId', net: { $sum: '$net' } } }]),
    VerificationRecord.aggregate([{ $match: { userId: { $in: ids } } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$userId', status: { $first: '$status' } } }]),
  ]);
  const m = (a, k = 'n') => Object.fromEntries(a.map((x) => [String(x._id), x[k]]));
  const F = m(fol), Un = m(unl), UnP = m(unl, 'points'), G = m(gifts), E = m(earn, 'net'), V = m(ver, 'status');
  out.items = out.items.map((c) => ({ ...c, followers: F[String(c._id)] || 0, exclusiveSales: Un[String(c._id)] || 0, exclusiveSalesPoints: UnP[String(c._id)] || 0, giftsReceived: G[String(c._id)] || 0, earningsNetPoints: E[String(c._id)] || 0, verification: V[String(c._id)] || 'NOT_STARTED' }));
  res.json(out);
}));
r.get('/creators/:id', need('creators.read'), asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(400, 'Bad id'); const id = req.params.id;
  const u = await User.findOne({ _id: id, accountMode: 'CREATOR' }).select('-passwordHash -emailVerifyHash -resetHash -emailVerifyExpires -resetExpires -googleId').populate('adminNotes.by', 'username').lean(); if (!u) throw new ApiError(404, 'Creator not found');
  const [followers, subs, posts, content, earnings, ver, reports] = await Promise.all([
    Follow.countDocuments({ followeeId: id }), Subscription.countDocuments({ creatorId: id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }), Post.countDocuments({ authorId: id, status: 'PUBLISHED' }),
    Post.find({ authorId: id, status: { $ne: 'DELETED' } }).sort('-createdAt').limit(20).select('content access unlockPricePoints status moderation createdAt mediaTypeHint').lean(),
    req.perms.has('transactions.read') ? earningsSummary(u._id) : null,
    VerificationRecord.find({ userId: id }).sort('-createdAt').limit(10).select('status providerEnv failReason createdAt feeKobo').lean(),
    Report.find({ targetType: 'USER', targetId: id }).sort('-createdAt').limit(20).select('category status priority createdAt resolution').lean(),
  ]);
  res.json({ creator: u, overview: { followers, subscribers: subs, posts }, content, earnings, verification: ver, reports });
}));
r.post('/creators/:id/plan', need('creators.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ plan: z.enum(['DEFAULT', 'PRO']), reason }).parse(req.body); const u = await User.findOne({ _id: req.params.id, accountMode: 'CREATOR' }); if (!u) throw new ApiError(404, 'Creator not found');
  const before = u.creatorPlan; u.creatorPlan = b.plan; if (b.plan === 'DEFAULT') u.proExpiresAt = undefined; await u.save();
  await audit(req, 'CREATOR_PLAN_CHANGED', u.id, { reason: b.reason, before: { plan: before }, after: { plan: b.plan } }); res.json({ ok: true });
}));

// ================= verification (provider result only: admins can reject, never self-approve) =================
r.get('/verification', need('verification.read'), asyncHandler(async (req, res) => {
  const f = {}; if (req.query.status) f.status = String(req.query.status); if (req.query.q) { const ids = await idsFor(String(req.query.q)); f.userId = { $in: ids }; } Object.assign(f, dateRange(req));
  const [list, counts, fees] = await Promise.all([paged(VerificationRecord, f, req, { sortable: ['createdAt', 'updatedAt', 'status'], select: 'userId type provider providerEnv status failReason feeKobo createdAt updatedAt', populate: [['userId', 'username displayName']] }),
    VerificationRecord.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]), VerificationRecord.aggregate([{ $group: { _id: null, fee: { $sum: '$feeKobo' } } }])]);
  res.json({ ...list, summary: Object.fromEntries(counts.map((c) => [c._id, c.n])), totalProviderFeesNaira: Math.round((fees[0]?.fee || 0) / 100) });
}));
r.get('/verification/:id', need('verification.read'), asyncHandler(async (req, res) => {
  const v = await VerificationRecord.findById(req.params.id).select('-__v').populate('userId', 'username displayName accountMode').lean(); if (!v) throw new ApiError(404, 'Not found');
  const history = req.perms.has('audit_logs.read') ? await AuditLog.find({ target: String(v._id) }).sort('-createdAt').limit(20).select('action reason createdAt').lean() : [];
  res.json({ verification: v, note: 'No BVN, name or date of birth is stored. Only the provider outcome and match scores are kept.', history });
}));
r.post('/verification/:id/review', need('verification.review'), asyncHandler(async (req, res) => {
  const b = z.object({ decision: z.literal('reject'), reason }).parse(req.body);
  const v = await VerificationRecord.findOneAndUpdate({ _id: req.params.id, status: 'REQUIRES_REVIEW' }, { status: 'FAILED', failReason: 'REJECTED_BY_REVIEWER', reviewReason: b.reason }, { new: true });
  if (!v) throw new ApiError(409, 'Only cases awaiting review can be rejected. Approvals come from the verification provider.');
  await audit(req, 'VERIFICATION_REJECTED', v.id, { reason: b.reason }); await notify(v.userId, 'VERIFICATION', 'Your identity verification could not be approved. You can try again.', '/studio'); res.json({ ok: true });
}));

// ================= content moderation =================
r.get('/content', need('content.read'), asyncHandler(async (req, res) => {
  const f = {}; const { type, access, moderation, reported, creator, q } = req.query;
  if (type === 'text') f.mediaTypeHint = null; else if (type === 'image' || type === 'video') f.mediaTypeHint = type.toUpperCase();
  if (access) f.access = String(access); if (moderation) f['moderation.status'] = String(moderation);
  if (creator) f.authorId = { $in: (await idsFor(String(creator))) || [] }; if (q) f.content = rx(String(q)); Object.assign(f, dateRange(req));
  if (reported === 'true') f._id = { $in: await Report.distinct('targetId', { targetType: 'POST', status: { $in: ['NEW', 'UNDER_REVIEW', 'ACTION_REQUIRED'] } }) };
  const out = await paged(Post, f, req, { sortable: ['createdAt'], select: 'authorId content access unlockPricePoints status moderation mediaTypeHint createdAt communityId', populate: [['authorId', 'username displayName avatarUrl']] });
  const rc = await Report.aggregate([{ $match: { targetType: 'POST', targetId: { $in: out.items.map((p) => p._id) } } }, { $group: { _id: '$targetId', n: { $sum: 1 } } }]); const R = Object.fromEntries(rc.map((x) => [String(x._id), x.n]));
  out.items = out.items.map((p) => ({ ...p, reportCount: R[String(p._id)] || 0 })); res.json(out);
}));
r.get('/content/:id', need('content.read'), asyncHandler(async (req, res) => {
  const p = await Post.findById(req.params.id).populate('authorId', 'username displayName avatarUrl accountMode').lean(); if (!p) throw new ApiError(404, 'Not found');
  const [reports, history] = await Promise.all([Report.find({ targetType: 'POST', targetId: p._id }).sort('-createdAt').select('category reason status priority createdAt').lean(), AuditLog.find({ target: String(p._id), action: /^CONTENT_/ }).sort('-createdAt').populate('actorId', 'username').select('action reason createdAt actorId').lean()]);
  res.json({ post: { ...p, hasMedia: !!p.mediaId }, reports, history });
}));
r.get('/content/:id/media', need('content.read'), asyncHandler(async (req, res) => { const p = await Post.findById(req.params.id).select('mediaId'); if (!p?.mediaId) throw new ApiError(404, 'No media'); res.json({ url: signUrl(p.mediaId, req.admin.id, 300) }); }));
r.post('/content/:id/moderate', need('content.moderate'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['review', 'remove', 'restrict', 'restore']), reason }).parse(req.body);
  const p = await Post.findById(req.params.id); if (!p) throw new ApiError(404, 'Not found'); const before = p.moderation?.status || 'OK';
  p.moderation = { status: { review: 'UNDER_REVIEW', remove: 'REMOVED', restrict: 'RESTRICTED', restore: 'OK' }[b.action], reason: b.reason, by: req.admin._id, at: new Date() }; await p.save(); // reversible: nothing is deleted
  await audit(req, `CONTENT_${b.action.toUpperCase()}`, p.id, { reason: b.reason, before: { moderation: before }, after: { moderation: p.moderation.status } });
  if (['remove', 'restrict'].includes(b.action)) await notify(p.authorId, 'MODERATION', 'One of your posts was hidden for violating our rules.', '/home'); res.json({ ok: true });
}));

// ================= reports queue =================
const OPEN = ['NEW', 'UNDER_REVIEW', 'ACTION_REQUIRED'];
r.get('/reports', need('reports.read'), asyncHandler(async (req, res) => {
  const f = {}; const { status, category, priority, assigned, q } = req.query; if (status === 'open') f.status = { $in: OPEN }; else if (status) f.status = String(status);
  if (category) f.category = String(category); if (priority) f.priority = String(priority); if (req.query.targetType) f.targetType = String(req.query.targetType); if (assigned === 'me') f.assignedTo = req.admin._id; if (assigned === 'none') f.assignedTo = null; if (q && isId(String(q))) f.$or = [{ _id: q }, { targetId: q }]; Object.assign(f, dateRange(req));
  const out = await paged(Report, f, req, { sortable: ['createdAt', 'priority', 'status'], select: 'reporterId targetType targetId category reason priority status assignedTo createdAt', populate: [['reporterId', 'username'], ['assignedTo', 'username']] });
  const counts = await Report.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]); res.json({ ...out, summary: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}));
r.get('/reports/:id', need('reports.read'), asyncHandler(async (req, res) => {
  const rp = await Report.findById(req.params.id).populate('reporterId', 'username').populate('assignedTo', 'username').populate('notes.by', 'username').populate('history.by', 'username').lean(); if (!rp) throw new ApiError(404, 'Not found');
  let target = null; // snapshot of what was reported (private messages are never shown)
  if (rp.targetType === 'POST') target = await Post.findById(rp.targetId).select('content access status moderation authorId').populate('authorId', 'username').lean();
  else if (rp.targetType === 'USER') target = await User.findById(rp.targetId).select('username displayName accountStatus accountMode').lean();
  else if (rp.targetType === 'COMMUNITY') target = await Community.findById(rp.targetId).select('name description status').lean();
  else if (rp.targetType === 'RATING') target = await Rating.findById(rp.targetId).select('stars text status').lean();
  const related = await Report.find({ targetType: rp.targetType, targetId: rp.targetId, _id: { $ne: rp._id } }).sort('-createdAt').limit(10).select('category status createdAt').lean();
  res.json({ report: rp, target, related });
}));
r.post('/reports/:id/transition', need('reports.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ status: z.enum(['UNDER_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'DISMISSED']), reason: z.string().trim().max(500).optional() }).parse(req.body);
  if (['RESOLVED', 'DISMISSED'].includes(b.status) && (b.reason || '').length < 5) throw new ApiError(400, 'A resolution reason is required');
  const rp = await Report.findById(req.params.id); if (!rp) throw new ApiError(404, 'Not found');
  const ok = { NEW: ['UNDER_REVIEW', 'DISMISSED'], UNDER_REVIEW: ['ACTION_REQUIRED', 'RESOLVED', 'DISMISSED'], ACTION_REQUIRED: ['RESOLVED', 'DISMISSED', 'UNDER_REVIEW'], RESOLVED: [], DISMISSED: [] };
  if (!ok[rp.status].includes(b.status)) throw new ApiError(409, `Cannot move a ${rp.status.toLowerCase().replace('_', ' ')} report to ${b.status.toLowerCase().replace('_', ' ')}`);
  const before = rp.status; rp.status = b.status; if (['RESOLVED', 'DISMISSED'].includes(b.status)) rp.resolution = b.reason; if (!rp.assignedTo) rp.assignedTo = req.admin._id; rp.history.push({ status: b.status, by: req.admin._id, at: new Date(), reason: b.reason }); await rp.save();
  await audit(req, 'REPORT_STATUS_CHANGED', rp.id, { reason: b.reason, before: { status: before }, after: { status: b.status } }); res.json({ ok: true });
}));
r.post('/reports/:id/assign', need('reports.manage'), asyncHandler(async (req, res) => { const { adminId } = z.object({ adminId: z.string().optional() }).parse(req.body); const to = adminId && isId(adminId) ? adminId : req.admin.id;
  const a = await User.findOne({ _id: to, role: 'ADMIN' }); if (!a) throw new ApiError(404, 'Admin not found'); await Report.updateOne({ _id: req.params.id }, { assignedTo: a._id }); await audit(req, 'REPORT_ASSIGNED', req.params.id, { after: { assignedTo: a.username } }); res.json({ ok: true }); }));
r.post('/reports/:id/notes', need('reports.manage'), asyncHandler(async (req, res) => { const { text } = z.object({ text: z.string().trim().min(2).max(1000) }).parse(req.body); await Report.updateOne({ _id: req.params.id }, { $push: { notes: { text, by: req.admin._id, at: new Date() } } }); res.status(201).json({ ok: true }); }));

// ================= communities / ratings / gifts =================
r.get('/communities', need('communities.read'), asyncHandler(async (req, res) => {
  const f = {}; const { visibility, paid, status, reported, q } = req.query; if (visibility) f.visibility = String(visibility); if (paid === 'true') f.accessFeePoints = { $gt: 0 }; if (paid === 'false') f.accessFeePoints = 0; if (status) f.status = String(status); if (q) f.name = rx(String(q));
  if (reported === 'true') f._id = { $in: await Report.distinct('targetId', { targetType: 'COMMUNITY', status: { $in: OPEN } }) };
  const out = await paged(Community, f, req, { sortable: ['createdAt', 'memberCount', 'name'], select: 'name ownerId memberCount visibility accessFeePoints status statusReason createdAt', populate: [['ownerId', 'username']] });
  const rc = await Report.aggregate([{ $match: { targetType: 'COMMUNITY', targetId: { $in: out.items.map((c) => c._id) } } }, { $group: { _id: '$targetId', n: { $sum: 1 } } }]); const R = Object.fromEntries(rc.map((x) => [String(x._id), x.n]));
  out.items = out.items.map((c) => ({ ...c, reportCount: R[String(c._id)] || 0 })); res.json(out);
}));
r.get('/communities/:id', need('communities.read'), asyncHandler(async (req, res) => { const c = await Community.findById(req.params.id).populate('ownerId', 'username displayName').lean(); if (!c) throw new ApiError(404, 'Not found');
  const [posts, reports] = await Promise.all([Post.find({ communityId: c._id }).sort('-createdAt').limit(15).select('content createdAt authorId moderation').populate('authorId', 'username').lean(), Report.find({ targetType: 'COMMUNITY', targetId: c._id }).sort('-createdAt').limit(10).select('category status createdAt').lean()]); res.json({ community: c, posts, reports }); }));
r.post('/communities/:id/moderate', need('communities.moderate'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['restrict', 'restore']), reason }).parse(req.body); const c = await Community.findById(req.params.id); if (!c) throw new ApiError(404, 'Not found');
  const before = c.status; c.status = b.action === 'restrict' ? 'RESTRICTED' : 'ACTIVE'; c.statusReason = b.action === 'restrict' ? b.reason : undefined; await c.save(); await audit(req, `COMMUNITY_${b.action.toUpperCase()}`, c.id, { reason: b.reason, before: { status: before }, after: { status: c.status } }); res.json({ ok: true });
}));
r.get('/ratings', need('ratings.read'), asyncHandler(async (req, res) => {
  const f = {}; if (req.query.status) f.status = String(req.query.status); if (req.query.creator) f.creatorId = { $in: (await idsFor(String(req.query.creator))) || [] };
  const out = await paged(Rating, f, req, { sortable: ['createdAt', 'stars'], select: 'creatorId reviewerId stars text status qualifyingId qualifyingKind createdAt', populate: [['creatorId', 'username'], ['reviewerId', 'username']] });
  const dup = await Rating.aggregate([{ $match: { _id: { $in: out.items.map((x) => x._id) } } }, { $group: { _id: { c: '$creatorId', r: '$reviewerId' }, n: { $sum: 1 } } }]); out.items = out.items.map((x) => ({ ...x, reviewerReviewsOfCreator: dup.find((d) => String(d._id.c) === String(x.creatorId?._id) && String(d._id.r) === String(x.reviewerId?._id))?.n || 1 })); res.json(out);
}));
r.post('/ratings/:id/moderate', need('ratings.moderate'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['remove', 'restore', 'dismiss_report']), reason }).parse(req.body); const x = await Rating.findById(req.params.id); if (!x) throw new ApiError(404, 'Not found');
  const before = x.status; x.status = b.action === 'remove' ? 'REMOVED' : 'VISIBLE'; await x.save(); // the original review text is kept; stars are never edited
  await audit(req, `RATING_${b.action.toUpperCase()}`, x.id, { reason: b.reason, before: { status: before }, after: { status: x.status } }); res.json({ ok: true });
}));
r.get('/gifts', need('gifts.manage'), asyncHandler(async (_q, res) => { const [items, sent] = await Promise.all([Gift.find().sort('order').lean(), GiftTransaction.aggregate([{ $group: { _id: '$giftId', n: { $sum: '$quantity' } } }])]); const S = Object.fromEntries(sent.map((s) => [String(s._id), s.n])); res.json({ items: items.map((g) => ({ ...g, sent: S[String(g._id)] || 0 })) }); }));
const giftBody = z.object({ name: z.string().trim().min(2).max(40), description: z.string().max(200).optional(), imageUrl: z.string().max(300).optional(), pricePoints: z.number().int().min(1).max(100000), active: z.boolean().optional(), order: z.number().int().min(0).max(1000).optional() });
r.post('/gifts', need('gifts.manage'), asyncHandler(async (req, res) => { const b = giftBody.parse(req.body); const g = await Gift.create(b); await audit(req, 'GIFT_CREATED', g.id, { after: b }); res.status(201).json(g); }));
r.patch('/gifts/:id', need('gifts.manage'), asyncHandler(async (req, res) => { const b = giftBody.partial().parse(req.body); const g = await Gift.findById(req.params.id); if (!g) throw new ApiError(404, 'Not found'); const before = { name: g.name, pricePoints: g.pricePoints, active: g.active, order: g.order }; Object.assign(g, b); await g.save(); await audit(req, 'GIFT_UPDATED', g.id, { before, after: b }); res.json(g); })); // disabling never deletes history
r.post('/gifts/image', need('gifts.manage'), imageUpload, asyncHandler(async (req, res) => res.json({ url: savePublicImage(req.file) })));
export default r;
