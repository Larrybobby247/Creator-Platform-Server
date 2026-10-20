import { Router } from 'express';
import { User } from '../models/User.js';
import { Post } from '../models/Social.js';
import { Follow, Block, Community } from '../models/Extra.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const r = Router();
r.use(authenticate);
const esc = (s) => String(s).replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40);
const U = 'username displayName avatarUrl accountMode creatorPlan bio category';
const cache = new Map(); // public, non-personal data only; short TTL
const cached = async (key, ttlMs, fn) => { const h = cache.get(key); if (h && Date.now() - h.at < ttlMs) return h.data; const data = await fn(); cache.set(key, { at: Date.now(), data }); return data; };

const popularCreators = (limit = 40) => cached(`pop:${limit}`, 5 * 60e3, async () => {
  const since = new Date(Date.now() - 30 * 864e5);
  const top = await Follow.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$followeeId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: limit }]);
  return top.map((t) => ({ id: String(t._id), n: t.n }));
});

// People worth following: popular recently, not already followed, not blocked, not you. Creators first, then newest accounts.
r.get('/suggestions', asyncHandler(async (req, res) => {
  const limit = Math.min(20, Number(req.query.limit) || 10);
  const [pop, follows, blocks] = await Promise.all([popularCreators(), Follow.find({ followerId: req.user._id }).select('followeeId').lean(), Block.find({ $or: [{ blockerId: req.user._id }, { blockedId: req.user._id }] }).select('blockerId blockedId').lean()]);
  const skip = new Set([req.user.id, ...follows.map((f) => String(f.followeeId)), ...blocks.flatMap((b) => [String(b.blockerId), String(b.blockedId)])]);
  const ids = pop.map((p) => p.id).filter((id) => !skip.has(id)).slice(0, limit);
  let users = ids.length ? await User.find({ _id: { $in: ids }, accountStatus: { $ne: 'SUSPENDED' } }).select(U).lean() : [];
  users.sort((a, b) => ids.indexOf(String(a._id)) - ids.indexOf(String(b._id)));
  if (users.length < limit) { const have = new Set([...skip, ...users.map((u) => String(u._id))]); users = users.concat(await User.find({ _id: { $nin: [...have] }, accountStatus: { $ne: 'SUSPENDED' }, emailVerified: true }).sort({ accountMode: -1, _id: -1 }).limit(limit - users.length).select(U).lean()); }
  const counts = await Follow.aggregate([{ $match: { followeeId: { $in: users.map((u) => u._id) } } }, { $group: { _id: '$followeeId', n: { $sum: 1 } } }]); const cm = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ users: users.map((u) => ({ ...u, followers: cm[String(u._id)] || 0, following: false })) });
}));

r.get('/trending', asyncHandler(async (_q, res) => {
  res.json(await cached('trending', 5 * 60e3, async () => {
    const since = new Date(Date.now() - 7 * 864e5);
    const [topics, communities, creatorIds] = await Promise.all([
      Post.aggregate([{ $match: { status: 'PUBLISHED', access: 'PUBLIC', createdAt: { $gte: since }, 'moderation.status': { $nin: ['REMOVED', 'RESTRICTED'] }, communityId: { $exists: false } } }, { $unwind: '$tags' }, { $group: { _id: '$tags', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      Community.find({ visibility: 'PUBLIC', status: { $ne: 'RESTRICTED' } }).sort({ memberCount: -1 }).limit(8).select('name description memberCount accessFeePoints').lean(),
      popularCreators(8),
    ]);
    const creators = await User.find({ _id: { $in: creatorIds.map((c) => c.id) }, accountMode: 'CREATOR' }).select(U).lean();
    return { topics: topics.map((t) => ({ tag: t._id, count: t.count })), communities, creators };
  }));
}));

r.get('/search', asyncHandler(async (req, res) => {
  const q = esc(req.query.q || ''); if (q.length < 2) return res.json({ people: [], communities: [], topics: [] });
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), pre = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const [people, communities, topics] = await Promise.all([
    User.find({ accountStatus: { $ne: 'SUSPENDED' }, emailVerified: true, _id: { $ne: req.user._id }, $or: [{ username: pre }, { displayName: re }] }).sort({ accountMode: -1 }).limit(8).select(U).lean(),
    Community.find({ visibility: 'PUBLIC', status: { $ne: 'RESTRICTED' }, name: re }).limit(6).select('name description memberCount accessFeePoints').lean(),
    Post.aggregate([{ $match: { status: 'PUBLISHED', access: 'PUBLIC', tags: pre } }, { $unwind: '$tags' }, { $match: { tags: pre } }, { $group: { _id: '$tags', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 6 }]),
  ]);
  const f = await Follow.find({ followerId: req.user._id, followeeId: { $in: people.map((p) => p._id) } }).select('followeeId').lean(); const F = new Set(f.map((x) => String(x.followeeId)));
  res.json({ people: people.map((p) => ({ ...p, following: F.has(String(p._id)) })), communities, topics: topics.map((t) => ({ tag: t._id, count: t.count })) });
}));
export default r;
