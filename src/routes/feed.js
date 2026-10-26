import { Router } from 'express';
import { z } from 'zod';
import { Post, MediaAsset } from '../models/Social.js';
import { User } from '../models/User.js';
import { Rating, Follow, Like, Comment, CommentLike, PostView, Block, Report, Promotion, Community, CommunityMember, Subscription } from '../models/Extra.js';
import { PointTransaction } from '../models/Finance.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assertCanInteract } from '../utils/restrict.js';
import { notify } from '../services/notify.js';
import { resolveMentions, notifyMentions } from '../services/mentions.js';

const r = Router();
r.use(authenticate);
const PAGE = 20;
const VISIBLE = { status: 'PUBLISHED', 'moderation.status': { $nin: ['REMOVED', 'RESTRICTED'] } };
const cursorFilter = (c) => { if (!c) return null; const [t, id] = String(c).split('_'); const d = new Date(t); if (isNaN(d) || !/^[0-9a-f]{24}$/i.test(id || '')) return null; return { $or: [{ createdAt: { $lt: d } }, { createdAt: d, _id: { $lt: id } }] }; };
const AUTHOR = 'username displayName avatarUrl accountMode creatorPlan subscriptionPricePoints';

// Shape posts for the viewer. Protected text/media is NEVER included unless entitled.
// All lookups run once for the whole page (no per-post queries) and concurrently.
export async function shape(posts, me) {
  const ids = posts.map((p) => p._id);
  const authorOf = (p) => String(p.authorId._id || p.authorId);
  const has = (p, access) => p.access === access || p.media?.some((m) => m.access === access);
  const gatedIds = posts.filter((p) => has(p, 'EXCLUSIVE')).map((p) => p._id);
  const subAuthors = [...new Set(posts.filter((p) => has(p, 'SUBSCRIBERS')).map(authorOf))];
  const [likes, mine, comments, follows, promos, assets, unlocked, subs] = await Promise.all([
    Like.aggregate([{ $match: { postId: { $in: ids } } }, { $group: { _id: '$postId', n: { $sum: 1 } } }]),
    Like.find({ postId: { $in: ids }, userId: me._id }).select('postId').lean(),
    Comment.aggregate([{ $match: { postId: { $in: ids }, deleted: { $ne: true } } }, { $group: { _id: '$postId', n: { $sum: 1 } } }]),
    Follow.find({ followerId: me._id, followeeId: { $in: posts.map((p) => p.authorId._id || p.authorId) } }).select('followeeId').lean(),
    Promotion.find({ targetType: 'POST', targetId: { $in: ids }, status: 'ACTIVE', expiresAt: { $gt: new Date() } }).select('targetId').lean(),
    MediaAsset.find({ _id: { $in: posts.map((p) => p.mediaId).filter(Boolean) } }).select('mediaType durationSec').lean(),
    gatedIds.length ? PointTransaction.find({ userId: me._id, type: 'EXCLUSIVE_CONTENT_UNLOCK', relatedId: { $in: gatedIds }, status: 'COMPLETED' }).select('relatedId meta').lean() : [],
    subAuthors.length ? Subscription.find({ subscriberId: me._id, creatorId: { $in: subAuthors }, status: 'ACTIVE', expiresAt: { $gt: new Date() } }).select('creatorId').lean() : [],
  ]);
  const L = Object.fromEntries(likes.map((x) => [String(x._id), x.n])), C = Object.fromEntries(comments.map((x) => [String(x._id), x.n]));
  const M = new Set(mine.map((x) => String(x.postId))), F = new Set(follows.map((x) => String(x.followeeId))), P = new Set(promos.map((x) => String(x.targetId)));
  const A = Object.fromEntries(assets.map((a) => [String(a._id), a])), S = new Set(subs.map((x) => String(x.creatorId)));
  const U = new Map(); for (const t of unlocked) { const k = String(t.relatedId); if (!U.has(k)) U.set(k, new Set()); U.get(k).add(t.meta?.idx ?? 'all'); } // 'all' = legacy whole-post unlock
  return posts.map((p) => {
    const author = authorOf(p); const own = author === String(me._id); const open = U.get(String(p._id));
    const o = { ...p, hasPreview: !!p.previewMediaId, pinned: !!p.pinnedAt };
    if (p.communityId?.name) { o.community = { _id: p.communityId._id, name: p.communityId.name }; o.communityId = p.communityId._id; }
    if (author !== String(me._id)) delete o.viewCount;
    delete o.moderation; delete o.mentions;
    let locked = false;
    if (p.media?.length) { // ---- new style: each item has its own access; the caption is always public
      o.items = p.media.map((m, idx) => ({ idx, mediaType: m.mediaType, access: m.access, pricePoints: m.pricePoints, durationSec: m.durationSec,
        locked: !(m.access === 'PUBLIC' || own || (m.access === 'EXCLUSIVE' && (open?.has(idx) || open?.has('all'))) || (m.access === 'SUBSCRIBERS' && S.has(author))) }));
      o.mediaType = p.media[0].mediaType; delete o.media;
      if (!own && !o.items.some((i) => i.access !== 'PUBLIC' && !i.locked)) delete o.exclusiveText;
    } else { // ---- legacy: one optional media file, post-level access
      const ok = p.access === 'PUBLIC' || own || (p.access === 'EXCLUSIVE' && (open?.has('all'))) || (p.access === 'SUBSCRIBERS' && S.has(author));
      locked = !ok;
      if (p.mediaId) { const a = A[String(p.mediaId)]; o.mediaType = a?.mediaType; o.durationSec = a?.durationSec; o.items = [{ idx: 0, legacy: true, mediaType: a?.mediaType, access: p.access, pricePoints: p.unlockPricePoints, durationSec: a?.durationSec, locked: !ok, hasPreview: !!p.previewMediaId }]; }
      if (!ok) { delete o.exclusiveText; delete o.mediaId; delete o.previewMediaId; if (p.access === 'EXCLUSIVE') delete o.content; }
    }
    return { ...o, locked, likeCount: L[String(p._id)] || 0, liked: M.has(String(p._id)), commentCount: C[String(p._id)] || 0, following: F.has(author), sponsored: P.has(String(p._id)) };
  });
}

async function assertCommunityView(id, user) {
  const c = await Community.findById(id).select('visibility accessFeePoints status').lean(); if (!c || c.status === 'RESTRICTED') throw new ApiError(404, 'Community not found');
  if (c.visibility === 'PUBLIC' && !c.accessFeePoints) return;
  if (!(await CommunityMember.exists({ communityId: c._id, userId: user._id }))) throw new ApiError(403, 'Join this community to view its posts', 'NOT_MEMBER');
}
r.get('/feed', asyncHandler(async (req, res) => {
  const tab = req.query.tab || 'forYou';
  const [blockRows, followRows, memberRows] = await Promise.all([
    Block.find({ $or: [{ blockerId: req.user._id }, { blockedId: req.user._id }] }).select('blockerId blockedId').lean(),
    tab === 'following' ? Follow.find({ followerId: req.user._id }).select('followeeId').lean() : [],
    tab === 'communities' ? CommunityMember.find({ userId: req.user._id }).select('communityId').lean() : [],
  ]);
  const blocked = blockRows.map((b) => String(b.blockerId) === req.user.id ? b.blockedId : b.blockerId);
  const q = { ...VISIBLE, authorId: { $nin: blocked } };
  const author = req.query.author && /^[0-9a-f]{24}$/i.test(req.query.author) ? req.query.author : null;
  if (author) q.authorId = author;
  if (req.query.community) { await assertCommunityView(req.query.community, req.user); q.communityId = req.query.community; }
  else if (tab === 'communities') q.communityId = { $in: memberRows.map((m) => m.communityId) };
  else if (!author) q.communityId = { $exists: false };
  if (tab === 'following') q.authorId = { $in: followRows.map((f) => f.followeeId), $nin: blocked };
  if (req.query.access) q.access = req.query.access;
  if (req.query.tag) { q.tags = String(req.query.tag).toLowerCase().slice(0, 40); q.access = 'PUBLIC'; }
  const cf = cursorFilter(req.query.cursor); if (cf) Object.assign(q, cf);
  let pinned = [];
  if (author && !req.query.cursor && !req.query.community) { // pinned posts always lead a profile
    const pq = { ...q, pinnedAt: { $ne: null } }; delete pq.$or; pinned = await Post.find(pq).sort({ pinnedAt: -1 }).limit(10).select('-__v').populate('authorId', AUTHOR).lean();
  }
  if (author) q.pinnedAt = null;
  const rows = await Post.find(q).sort({ createdAt: -1, _id: -1 }).limit(PAGE + 1).select('-__v').populate('authorId', AUTHOR).populate('communityId', 'name').lean();
  const more = rows.length > PAGE; if (more) rows.pop();
  const last = rows.at(-1);
  res.json({ posts: await shape([...pinned, ...rows], req.user), nextCursor: more && last ? `${last.createdAt.toISOString()}_${last._id}` : null });
}));

// One post, shaped for the viewer (used to refresh a card right after an unlock).
r.get('/posts/:id', asyncHandler(async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw new ApiError(400, 'Bad id');
  const p = await Post.findOne({ _id: req.params.id, ...VISIBLE }).select('-__v').populate('authorId', AUTHOR).populate('communityId', 'name').lean(); if (!p) throw new ApiError(404, 'Not found');
  res.json({ post: (await shape([p], req.user))[0] });
}));

// Unique-viewer counting: the client reports posts that scrolled into view; each viewer counts once per post.
r.post('/posts/views', asyncHandler(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((i) => /^[0-9a-f]{24}$/i.test(i)).slice(0, 30); if (!ids.length) return res.json({ ok: true });
  const own = new Set((await Post.find({ _id: { $in: ids }, authorId: req.user._id }).select('_id').lean()).map((p) => String(p._id)));
  const todo = ids.filter((i) => !own.has(i)); if (!todo.length) return res.json({ ok: true });
  const w = await PostView.bulkWrite(todo.map((id) => ({ updateOne: { filter: { postId: id, userId: req.user._id }, update: { $setOnInsert: { postId: id, userId: req.user._id } }, upsert: true } })), { ordered: false });
  const fresh = Object.keys(w.upsertedIds || {}).map((i) => todo[Number(i)]);
  if (fresh.length) await Post.updateMany({ _id: { $in: fresh } }, { $inc: { viewCount: 1 } });
  res.json({ ok: true });
}));

r.post('/posts/:id/like', asyncHandler(async (req, res) => {
  const post = await Post.findOne({ _id: req.params.id, ...VISIBLE }).select('_id'); if (!post) throw new ApiError(404, 'Not found');
  const del = await Like.findOneAndDelete({ postId: post._id, userId: req.user._id });
  if (!del) { await Like.create({ postId: post._id, userId: req.user._id }); }
  res.json({ liked: !del, likeCount: await Like.countDocuments({ postId: post._id }) });
}));

// ---------- comments (threaded one level, with likes) ----------
const CU = 'username displayName avatarUrl accountMode';
const canSee = async (user, post) => { const { hasAccess } = await import('../services/access.js'); return !!post && post.status === 'PUBLISHED' && await hasAccess(user, post); };
async function shapeComments(rows, me, postAuthorId) {
  const liked = new Set((await CommentLike.find({ commentId: { $in: rows.map((c) => c._id) }, userId: me._id }).select('commentId').lean()).map((x) => String(x.commentId)));
  return rows.map((c) => ({ _id: c._id, parentId: c.parentId, user: c.userId, text: c.deleted ? '' : c.text, deleted: !!c.deleted, likeCount: c.likeCount || 0, replyCount: c.replyCount || 0, liked: liked.has(String(c._id)), createdAt: c.createdAt,
    canDelete: String(c.userId?._id) === String(me._id) || String(postAuthorId) === String(me._id) }));
}
r.get('/posts/:id/comments', asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id).select('authorId access status').lean(); if (!(await canSee(req.user, post))) throw new ApiError(403, 'Locked');
  const q = { postId: post._id, parentId: req.query.parent && /^[0-9a-f]{24}$/i.test(req.query.parent) ? req.query.parent : null };
  const cf = q.parentId ? null : cursorFilter(req.query.cursor); if (cf) Object.assign(q, cf);
  const rows = await Comment.find(q).sort(q.parentId ? { createdAt: 1 } : { createdAt: -1, _id: -1 }).limit(q.parentId ? 50 : 21).populate('userId', CU).lean();
  const more = !q.parentId && rows.length > 20; if (more) rows.pop(); const last = rows.at(-1);
  res.json({ comments: await shapeComments(rows, req.user, post.authorId), nextCursor: more && last ? `${last.createdAt.toISOString()}_${last._id}` : null });
}));
r.post('/posts/:id/comments', asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const b = z.object({ text: z.string().trim().min(1).max(1000), parentId: z.string().optional() }).parse(req.body);
  const post = await Post.findById(req.params.id).select('authorId access status').lean(); if (!(await canSee(req.user, post))) throw new ApiError(403, 'Locked');
  let parent = null; if (b.parentId) { parent = await Comment.findOne({ _id: b.parentId, postId: post._id, deleted: { $ne: true } }); if (!parent) throw new ApiError(404, 'Comment not found'); }
  const rootId = parent ? (parent.parentId || parent._id) : null; // replies stay one level deep
  const c = await Comment.create({ postId: post._id, userId: req.user._id, text: b.text, parentId: rootId });
  if (rootId) await Comment.updateOne({ _id: rootId }, { $inc: { replyCount: 1 } });
  const target = parent ? parent.userId : post.authorId;
  if (String(target) !== req.user.id) await notify(target, 'COMMENT', `${req.user.username} ${parent ? 'replied to your comment' : 'commented on your post'}`, '/home');
  const mentioned = (await resolveMentions(b.text, req.user._id)).filter((id) => String(id) !== String(target)); await notifyMentions(mentioned, req.user, 'in a comment', '/home');
  const full = await Comment.findById(c._id).populate('userId', CU).lean();
  res.status(201).json({ comment: (await shapeComments([full], req.user, post.authorId))[0] });
}));
r.post('/comments/:id/like', asyncHandler(async (req, res) => {
  const c = await Comment.findOne({ _id: req.params.id, deleted: { $ne: true } }).select('_id'); if (!c) throw new ApiError(404, 'Not found');
  const del = await CommentLike.findOneAndDelete({ commentId: c._id, userId: req.user._id });
  if (!del) await CommentLike.create({ commentId: c._id, userId: req.user._id }).catch((e) => { if (e.code !== 11000) throw e; });
  const likeCount = await CommentLike.countDocuments({ commentId: c._id }); await Comment.updateOne({ _id: c._id }, { likeCount });
  res.json({ liked: !del, likeCount });
}));
r.delete('/comments/:id', asyncHandler(async (req, res) => {
  const c = await Comment.findById(req.params.id); if (!c) throw new ApiError(404, 'Not found');
  const post = await Post.findById(c.postId).select('authorId').lean();
  if (String(c.userId) !== req.user.id && String(post?.authorId) !== req.user.id) throw new ApiError(403, 'Not allowed');
  c.deleted = true; c.text = ''; await c.save(); res.json({ ok: true });
}));

r.post('/follow/:userId', asyncHandler(async (req, res) => {
  if (req.params.userId === req.user.id) throw new ApiError(400, 'Cannot follow yourself');
  const del = await Follow.findOneAndDelete({ followerId: req.user._id, followeeId: req.params.userId });
  if (!del) { await Follow.create({ followerId: req.user._id, followeeId: req.params.userId }); await notify(req.params.userId, 'FOLLOW', `${req.user.username} started following you`, `/u/${req.user.username}`); }
  res.json({ following: !del });
}));
r.post('/block/:userId', asyncHandler(async (req, res) => {
  await Block.updateOne({ blockerId: req.user._id, blockedId: req.params.userId }, {}, { upsert: true }); res.json({ ok: true });
}));
const CAT = ['HARASSMENT', 'IMPERSONATION', 'FRAUD', 'INAPPROPRIATE_CONTENT', 'SPAM', 'PAYMENT_DISPUTE', 'SAFETY', 'OTHER'];
r.post('/report', asyncHandler(async (req, res) => {
  const b = z.object({ targetType: z.enum(['USER', 'POST', 'RATING', 'MESSAGE', 'COMMUNITY', 'PAYOUT']), targetId: z.string(), category: z.enum(CAT).default('OTHER'), reason: z.string().min(3).max(500) }).parse(req.body);
  const priority = ['SAFETY', 'FRAUD', 'HARASSMENT'].includes(b.category) ? 'HIGH' : b.category === 'SPAM' ? 'LOW' : 'NORMAL';
  res.status(201).json(await Report.create({ ...b, priority, reporterId: req.user._id, history: [{ status: 'NEW', at: new Date(), by: req.user._id }] }));
}));

// ---- Explore (creator directory with search / category)
r.get('/explore', asyncHandler(async (req, res) => {
  const page = Math.max(0, Number(req.query.page) || 0), SIZE = 24;
  const q = { accountMode: 'CREATOR', accountStatus: { $ne: 'SUSPENDED' }, _id: { $ne: req.user._id } };
  if (req.query.category) q.category = String(req.query.category).slice(0, 30);
  const term = String(req.query.q || '').replace(/[^\w ]/g, '').slice(0, 40);
  if (term) q.$or = [{ username: new RegExp(`^${term}`, 'i') }, { displayName: new RegExp(term, 'i') }];
  const creators = await User.find(q).sort({ _id: -1 }).skip(page * SIZE).limit(SIZE + 1).select('username displayName bio avatarUrl category creatorPlan accountMode').lean();
  const more = creators.length > SIZE; if (more) creators.pop();
  const ids = creators.map((c) => c._id);
  const [follows, counts, rt, promoted] = await Promise.all([
    Follow.find({ followerId: req.user._id, followeeId: { $in: ids } }).select('followeeId').lean(),
    Follow.aggregate([{ $match: { followeeId: { $in: ids } } }, { $group: { _id: '$followeeId', n: { $sum: 1 } } }]),
    Rating.aggregate([{ $match: { status: 'VISIBLE', creatorId: { $in: ids } } }, { $group: { _id: '$creatorId', avg: { $avg: '$stars' }, n: { $sum: 1 } } }]),
    Promotion.find({ targetType: 'PROFILE', targetId: { $in: ids }, status: 'ACTIVE', expiresAt: { $gt: new Date() } }).select('targetId').lean(),
  ]);
  const F = new Set(follows.map((f) => String(f.followeeId))), cm = Object.fromEntries(counts.map((c) => [String(c._id), c.n])), rm = Object.fromEntries(rt.map((x) => [String(x._id), x])), P = new Set(promoted.map((p) => String(p.targetId)));
  const out = creators.map((c) => ({ ...c, followers: cm[String(c._id)] || 0, following: F.has(String(c._id)), rating: rm[String(c._id)] ? { avg: Math.round(rm[String(c._id)].avg * 10) / 10, count: rm[String(c._id)].n } : null, sponsored: P.has(String(c._id)) }));
  out.sort((a, b) => Number(b.sponsored) - Number(a.sponsored));
  res.json({ creators: out, hasMore: more });
}));
export default r;
