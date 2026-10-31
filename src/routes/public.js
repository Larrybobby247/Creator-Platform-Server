// Read-only pages anyone can open WITHOUT an account (shared profile / community links).
// Only already-public data is returned: public posts, free (PUBLIC) media items, and community info. Exclusive, subscriber-only and
// private content stays locked. Every action (follow, like, comment, unlock, join...) still needs a login.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { User } from '../models/User.js';
import { Post } from '../models/Social.js';
import { Follow, Rating, Subscription, Community, CommunityMember } from '../models/Extra.js';
import { signUrl } from '../services/media.js';
import { shape } from './feed.js';
import { isOnline } from '../realtime.js';
import { isIdentityVerified } from '../services/verification.js';

const r = Router();
r.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' } }));
const oid = (s) => /^[0-9a-f]{24}$/i.test(String(s));
const FIELDS = 'username displayName bio avatarUrl coverUrl creatorPlan category location accountMode subscriptionPricePoints creatorSince services requestSettings.enabled requestSettings.minPricePoints meetup.enabled prefs.showOnline';
const AUTHOR = 'username displayName avatarUrl accountMode creatorPlan subscriptionPricePoints';
const VISIBLE = { status: 'PUBLISHED', 'moderation.status': { $nin: ['REMOVED', 'RESTRICTED'] } };
const findUser = async (idOrName) => {
  const u = await User.findOne({ $or: [{ _id: oid(idOrName) ? idOrName : null }, { username: String(idOrName).toLowerCase() }], accountStatus: { $ne: 'SUSPENDED' }, emailVerified: { $ne: false } }).select(FIELDS);
  if (!u) throw new ApiError(404, 'Not found'); return u;
};
const cursorFilter = (c) => { if (!c) return null; const [t, id] = String(c).split('_'); const d = new Date(t); if (isNaN(d) || !oid(id)) return null; return { $or: [{ createdAt: { $lt: d } }, { createdAt: d, _id: { $lt: id } }] }; };
const stranger = () => ({ _id: new mongoose.Types.ObjectId() }); // a viewer who owns/follows/unlocked nothing

r.get('/profile/:id', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  const [followers, following, subscribers, rt] = await Promise.all([Follow.countDocuments({ followeeId: u._id }), Follow.countDocuments({ followerId: u._id }),
    u.accountMode === 'CREATOR' ? Subscription.countDocuments({ creatorId: u._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } }) : 0,
    Rating.aggregate([{ $match: { creatorId: u._id, status: 'VISIBLE' } }, { $group: { _id: null, avg: { $avg: '$stars' }, n: { $sum: 1 } } }])]);
  const pub = u.toObject(); if (pub.meetup?.enabled && !(await isIdentityVerified(u._id))) pub.meetup.enabled = false; const online = u.prefs?.showOnline !== false && isOnline(u._id); delete pub.prefs;
  res.json({ creator: { ...pub, online }, followers, following, subscribers, isFollowing: false, subscribed: false, rating: rt[0] ? { avg: Math.round(rt[0].avg * 10) / 10, count: rt[0].n } : null });
}));

// Public posts only (exclusive and subscriber-only posts are not listed). Items inside a mixed post come back marked locked.
r.get('/profile/:id/posts', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id); const PAGE = 12;
  const q = { ...VISIBLE, authorId: u._id, access: 'PUBLIC', communityId: { $exists: false } };
  const cf = cursorFilter(req.query.cursor); if (cf) Object.assign(q, cf);
  const rows = await Post.find(q).sort({ createdAt: -1, _id: -1 }).limit(PAGE + 1).select('-__v').populate('authorId', AUTHOR).lean();
  const more = rows.length > PAGE; if (more) rows.pop(); const last = rows.at(-1);
  const posts = (await shape(rows, stranger())).map(({ exclusiveText, ...p }) => p);
  res.json({ posts, nextCursor: more && last ? `${last.createdAt.toISOString()}_${last._id}` : null });
}));

// Link for ONE free media item of a public post. Locked items are never served here.
r.get('/posts/:id/media/:idx', asyncHandler(async (req, res) => {
  const p = oid(req.params.id) ? await Post.findOne({ _id: req.params.id, ...VISIBLE, access: 'PUBLIC', communityId: { $exists: false } }) : null; const idx = Number(req.params.idx);
  const owner = p && await User.exists({ _id: p.authorId, accountStatus: { $ne: 'SUSPENDED' } });
  if (!p || !owner) throw new ApiError(404, 'Not found');
  const it = p.media?.length ? p.media[idx] : (p.mediaId && idx === 0 ? { access: 'PUBLIC', mediaId: p.mediaId } : null); // older single-media posts have no media list
  if (!it || it.access !== 'PUBLIC') throw new ApiError(403, 'Log in to view this', 'LOCKED');
  res.json({ url: signUrl(it.mediaId, 'public', 300) });
}));

r.get('/community/:id', asyncHandler(async (req, res) => {
  if (!oid(req.params.id)) throw new ApiError(400, 'Bad id');
  const c = await Community.findById(req.params.id).populate('ownerId', 'username displayName avatarUrl').select('name description rules visibility memberCount accessFeePoints status ownerId allowPosting allowMedia createdAt').lean();
  if (!c || c.status === 'RESTRICTED' || c.visibility !== 'PUBLIC') throw new ApiError(404, 'Not found'); // private communities are never shown to strangers
  const members = await CommunityMember.find({ communityId: c._id }).limit(12).populate('userId', 'username displayName avatarUrl').lean();
  res.json({ community: c, members: members.map((m) => m.userId).filter(Boolean) });
}));
export default r;
