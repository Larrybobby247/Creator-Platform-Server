import { Router } from 'express';
import { Post } from '../models/Social.js';
import { User } from '../models/User.js';
import { Like, Comment, Follow, Promotion } from '../models/Extra.js';
import { PointTransaction } from '../models/Finance.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { limitsFor } from '../services/plans.js';

const r = Router();
r.use(authenticate);
const SUPPORT_TYPES = ['CREATOR_GIFT', 'EXCLUSIVE_CONTENT_UNLOCK', 'CREATOR_SUBSCRIPTION', 'PAID_MESSAGE', 'SPECIAL_REQUEST', 'COMMUNITY_ACCESS'];

// Post analytics for EVERY account (users and creators): views, likes, comments, and (creators) unlock revenue.
r.get('/posts', asyncHandler(async (req, res) => {
  const posts = await Post.find({ authorId: req.user._id, status: 'PUBLISHED' }).sort({ createdAt: -1 }).limit(50).select('content access unlockPricePoints viewCount createdAt mediaTypeHint pinnedAt').lean();
  const ids = posts.map((p) => p._id);
  const [likes, comments, unlocks, promos] = await Promise.all([
    Like.aggregate([{ $match: { postId: { $in: ids } } }, { $group: { _id: '$postId', n: { $sum: 1 } } }]),
    Comment.aggregate([{ $match: { postId: { $in: ids }, deleted: { $ne: true } } }, { $group: { _id: '$postId', n: { $sum: 1 } } }]),
    req.user.accountMode === 'CREATOR' ? PointTransaction.aggregate([{ $match: { relatedId: { $in: ids }, type: 'EXCLUSIVE_CONTENT_UNLOCK', status: 'COMPLETED' } }, { $group: { _id: '$relatedId', n: { $sum: 1 }, points: { $sum: '$amount' } } }]) : [],
    Promotion.aggregate([{ $match: { ownerId: req.user._id, targetType: 'POST', targetId: { $in: ids } } }, { $group: { _id: '$targetId', impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, active: { $max: { $cond: [{ $and: [{ $eq: ['$status', 'ACTIVE'] }, { $gt: ['$expiresAt', new Date()] }] }, 1, 0] } } } }]),
  ]);
  const L = Object.fromEntries(likes.map((x) => [String(x._id), x.n])), C = Object.fromEntries(comments.map((x) => [String(x._id), x.n])), Un = Object.fromEntries(unlocks.map((x) => [String(x._id), x])), Pr = Object.fromEntries(promos.map((x) => [String(x._id), x]));
  const items = posts.map((p) => ({ ...p, views: p.viewCount || 0, likes: L[String(p._id)] || 0, comments: C[String(p._id)] || 0, unlocks: Un[String(p._id)]?.n || 0, revenuePoints: Un[String(p._id)]?.points || 0, promotion: Pr[String(p._id)] || null }));
  const sum = (k) => items.reduce((n, i) => n + i[k], 0);
  res.json({ items, totals: { posts: items.length, views: sum('views'), likes: sum('likes'), comments: sum('comments'), revenuePoints: sum('revenuePoints') } });
}));

// Advanced analytics: Pro creators only (enforced here, not just hidden in the UI).
r.get('/advanced', asyncHandler(async (req, res) => {
  if (req.user.accountMode !== 'CREATOR') throw new ApiError(403, 'Creators only', 'CREATOR_ONLY');
  if (!(await limitsFor(req.user)).advancedAnalytics) throw new ApiError(403, 'Advanced analytics are part of the Pro plan.', 'PRO_REQUIRED');
  const me = req.user._id; const since = new Date(Date.now() - 29 * 864e5); since.setHours(0, 0, 0, 0);
  const myPosts = await Post.find({ authorId: me, status: 'PUBLISHED' }).sort({ createdAt: -1 }).limit(200).select('content access viewCount unlockPricePoints').lean(); const pids = myPosts.map((p) => p._id);
  const [spend, byType, likers, commenters, unlockRev, likesPer, commentsPer, growth] = await Promise.all([
    PointTransaction.aggregate([{ $match: { creatorId: me, status: 'COMPLETED', direction: 'DEBIT', type: { $in: SUPPORT_TYPES } } }, { $group: { _id: '$userId', points: { $sum: '$amount' }, purchases: { $sum: 1 } } }, { $sort: { points: -1 } }, { $limit: 10 }]),
    PointTransaction.aggregate([{ $match: { creatorId: me, status: 'COMPLETED', direction: 'DEBIT', type: { $in: SUPPORT_TYPES } } }, { $group: { _id: '$type', points: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { points: -1 } }]),
    Like.aggregate([{ $match: { postId: { $in: pids } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
    Comment.aggregate([{ $match: { postId: { $in: pids }, deleted: { $ne: true } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
    PointTransaction.aggregate([{ $match: { relatedId: { $in: pids }, type: 'EXCLUSIVE_CONTENT_UNLOCK', status: 'COMPLETED' } }, { $group: { _id: '$relatedId', points: { $sum: '$amount' }, buyers: { $sum: 1 } } }, { $sort: { points: -1 } }, { $limit: 5 }]),
    Like.aggregate([{ $match: { postId: { $in: pids } } }, { $group: { _id: '$postId', n: { $sum: 1 } } }]),
    Comment.aggregate([{ $match: { postId: { $in: pids }, deleted: { $ne: true } } }, { $group: { _id: '$postId', n: { $sum: 1 } } }]),
    Follow.aggregate([{ $match: { followeeId: me, createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } }]),
  ]);
  const active = new Map(); for (const x of [...likers, ...commenters]) active.set(String(x._id), (active.get(String(x._id)) || 0) + x.n);
  const activeTop = [...active.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const uids = [...new Set([...spend.map((s) => String(s._id)), ...activeTop.map((a) => a[0])])];
  const users = Object.fromEntries((await User.find({ _id: { $in: uids } }).select('username displayName avatarUrl').lean()).map((u) => [String(u._id), u]));
  const L = Object.fromEntries(likesPer.map((x) => [String(x._id), x.n])), C = Object.fromEntries(commentsPer.map((x) => [String(x._id), x.n])), P = Object.fromEntries(myPosts.map((p) => [String(p._id), p]));
  const popular = myPosts.map((p) => ({ _id: p._id, caption: (p.content || '').slice(0, 80), access: p.access, views: p.viewCount || 0, likes: L[String(p._id)] || 0, comments: C[String(p._id)] || 0 })).map((p) => ({ ...p, score: p.views + p.likes * 3 + p.comments * 5 })).sort((a, b) => b.score - a.score).slice(0, 5);
  const gmap = Object.fromEntries(growth.map((g) => [g._id, g.n])); const days = Array.from({ length: 30 }, (_, i) => { const k = new Date(since.getTime() + i * 864e5).toISOString().slice(0, 10); return { date: k, followers: gmap[k] || 0 }; });
  res.json({
    topSupporters: spend.map((s) => ({ user: users[String(s._id)], points: s.points, purchases: s.purchases })),
    mostActiveSupporters: activeTop.map(([id, n]) => ({ user: users[id], interactions: n })),
    popularContent: popular,
    exclusiveByRevenue: unlockRev.map((u) => ({ _id: u._id, caption: (P[String(u._id)]?.content || '').slice(0, 80), points: u.points, buyers: u.buyers })),
    revenueBySource: byType.map((b) => ({ type: b._id, points: b.points, count: b.count })), followerGrowth: days,
  });
}));
export default r;
