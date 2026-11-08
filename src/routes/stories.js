import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';
import { Story, StoryView, StoryLike, Follow, Block } from '../models/Extra.js';
import { replyAccess, sendStatusReply } from './messages.js';
import { notify } from '../services/notify.js';
import { MediaAsset } from '../models/Social.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assertCanInteract } from '../utils/restrict.js';
import { getSetting } from '../services/settings.js';
import { assertVideoAllowed, storePrivate, signUrl, parseTrim, trimVideo } from '../services/media.js';

import { planKey } from '../services/plans.js';
const r = Router();
r.use(authenticate);
const TTL = 24 * 3600e3, MAX_ACTIVE = 10;
const MIME = { 'image/jpeg': ['IMAGE', '.jpg'], 'image/png': ['IMAGE', '.png'], 'image/webp': ['IMAGE', '.webp'], 'video/mp4': ['VIDEO', '.mp4'], 'video/webm': ['VIDEO', '.webm'], 'video/quicktime': ['VIDEO', '.mov'] };
const BG_FREE = ['violet', 'pink', 'blue', 'green', 'amber', 'teal', 'red', 'orange', 'indigo', 'slate']; // 10 gradient status backgrounds for everyone
// Privy Pro palettes: flat colours (the app's own colours, no gradient) and the same colours with hand-drawn doodle line art. Must match client src/lib/statusBg.js.
const BG_PRO = ['flat-violet', 'flat-pink', 'flat-blue', 'flat-green', 'flat-amber', 'flat-red', 'flat-ink', 'doodle-stars', 'doodle-hearts', 'doodle-waves', 'doodle-leaves', 'doodle-bolts', 'doodle-swirls', 'doodle-dots'];
const BG = [...BG_FREE, ...BG_PRO];
const AUTHOR = 'username displayName avatarUrl accountMode creatorPlan';

// Add a status: a photo/video (video length follows your plan) or a short text card. Expires after 24 hours.
r.post('/', multer({ dest: os.tmpdir() }).single('file'), asyncHandler(async (req, res) => {
  const f = req.file; try {
    assertCanInteract(req.user);
    const b = z.object({ text: z.string().max(220).optional(), bg: z.enum(BG).optional() }).parse(req.body);
    if (BG_PRO.includes(b.bg) && planKey(req.user) !== 'PRO') throw new ApiError(403, 'Flat and doodle colours are for Privy Pro creators.', 'PRO_ONLY');
    if ((await Story.countDocuments({ authorId: req.user._id, expiresAt: { $gt: new Date() } })) >= MAX_ACTIVE) throw new ApiError(409, `You can have up to ${MAX_ACTIVE} active statuses.`);
    let type = 'TEXT', mediaId;
    if (f) {
      const kind = MIME[f.mimetype]; if (!kind) throw new ApiError(415, 'Use a JPG/PNG/WebP image or an MP4/WebM video'); if (f.size > (await getSetting('maxUploadBytes'))) throw new ApiError(413, 'File too large');
      let ext = kind[1]; type = kind[0]; if (type === 'VIDEO') { const trim = parseTrim(req.body); if (trim) { const t = await trimVideo(f.path, trim); f.trimmedFrom = f.path; f.path = t; f.mimetype = 'video/mp4'; f.size = fs.statSync(t).size; ext = '.mp4'; } }
      const durationSec = type === 'VIDEO' ? await assertVideoAllowed(f.path, req.user.creatorPlan) : undefined;
      const a = await MediaAsset.create({ ownerId: req.user._id, storageKey: await storePrivate(f.path, ext), mediaType: type, mimeType: f.mimetype, size: f.size, durationSec }); mediaId = a._id;
    } else if (!b.text?.trim()) throw new ApiError(400, 'Add a photo, a video or some text');
    const s = await Story.create({ authorId: req.user._id, type, text: b.text?.trim(), bg: b.bg || 'violet', mediaId, expiresAt: new Date(Date.now() + TTL) });
    res.status(201).json({ story: s });
  } finally { for (const x of [f?.path, f?.trimmedFrom]) if (x && fs.existsSync(x)) fs.unlinkSync(x); }
}));

const group = (rows, seen, source, liked = new Set(), me = '') => { const by = new Map(); for (const s of rows) { const k = String(s.authorId._id); if (!by.has(k)) by.set(k, { user: s.authorId, source, stories: [] }); by.get(k).stories.push({ _id: s._id, type: s.type, text: s.text, bg: s.bg, createdAt: s.createdAt, seen: seen.has(String(s._id)), hasMedia: !!s.mediaId, liked: liked.has(String(s._id)), ...(String(s.authorId._id) === me ? { likeCount: s.likeCount || 0, viewCount: s.viewCount || 0 } : {}) }); }
  return [...by.values()].map((g) => { g.stories.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); g.unseen = g.stories.some((s) => !s.seen); return g; }); };

// Stories from people you follow, plus a few suggested ones from people you don't (recommendations).
r.get('/', asyncHandler(async (req, res) => {
  const now = new Date(); const [follows, blocks] = await Promise.all([Follow.find({ followerId: req.user._id }).select('followeeId').lean(), Block.find({ $or: [{ blockerId: req.user._id }, { blockedId: req.user._id }] }).select('blockerId blockedId').lean()]);
  const blocked = blocks.map((b) => String(b.blockerId) === req.user.id ? b.blockedId : b.blockerId); const fids = follows.map((f) => f.followeeId);
  const [mine, fol, sug] = await Promise.all([
    Story.find({ authorId: req.user._id, expiresAt: { $gt: now } }).sort('createdAt').populate('authorId', AUTHOR).lean(),
    Story.find({ authorId: { $in: fids, $nin: blocked }, expiresAt: { $gt: now } }).sort('-createdAt').limit(200).populate('authorId', AUTHOR).lean(),
    Story.find({ authorId: { $nin: [...fids, ...blocked, req.user._id] }, expiresAt: { $gt: now } }).sort('-createdAt').limit(40).populate('authorId', AUTHOR).lean(),
  ]);
  const seen = new Set((await StoryView.find({ userId: req.user._id, storyId: { $in: [...mine, ...fol, ...sug].map((s) => s._id) } }).select('storyId').lean()).map((x) => String(x.storyId)));
  const liked = new Set((await StoryLike.find({ userId: req.user._id, storyId: { $in: [...fol, ...sug].map((s) => s._id) } }).select('storyId').lean()).map((x) => String(x.storyId))); const me = req.user.id;
  const groups = group(fol, seen, 'following', liked, me).sort((a, b) => Number(b.unseen) - Number(a.unseen)).concat(group(sug, seen, 'suggested', liked, me).slice(0, 5));
  res.json({ mine: group(mine, seen, 'me', liked, me)[0] || null, groups });
}));
r.get('/user/:userId', asyncHandler(async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.userId)) throw new ApiError(400, 'Bad id');
  if (await Block.exists({ $or: [{ blockerId: req.params.userId, blockedId: req.user._id }, { blockerId: req.user._id, blockedId: req.params.userId }] })) return res.json({ group: null });
  const rows = await Story.find({ authorId: req.params.userId, expiresAt: { $gt: new Date() } }).populate('authorId', AUTHOR).lean();
  const seen = new Set((await StoryView.find({ userId: req.user._id, storyId: { $in: rows.map((s) => s._id) } }).select('storyId').lean()).map((x) => String(x.storyId)));
  const liked = new Set((await StoryLike.find({ userId: req.user._id, storyId: { $in: rows.map((s) => s._id) } }).select('storyId').lean()).map((x) => String(x.storyId)));
  res.json({ group: group(rows, seen, 'profile', liked, req.user.id)[0] || null });
}));
const live = async (req) => { const s = await Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } }); if (!s) throw new ApiError(404, 'This status has expired'); if (await Block.exists({ $or: [{ blockerId: s.authorId, blockedId: req.user._id }, { blockerId: req.user._id, blockedId: s.authorId }] })) throw new ApiError(404, 'Not found'); return s; };
r.get('/:id/media', asyncHandler(async (req, res) => { const s = await live(req); if (!s.mediaId) throw new ApiError(404, 'No media'); res.json({ url: signUrl(s.mediaId, req.user.id, 300) }); }));
r.post('/:id/view', asyncHandler(async (req, res) => {
  const s = await live(req); if (String(s.authorId) === req.user.id) return res.json({ ok: true });
  const up = await StoryView.updateOne({ storyId: s._id, userId: req.user._id }, { $setOnInsert: { storyId: s._id, userId: req.user._id } }, { upsert: true }); if (up.upsertedCount) await Story.updateOne({ _id: s._id }, { $inc: { viewCount: 1 } });
  res.json({ ok: true });
}));
// Love a status (tap again to remove). The owner sees the total; the person who loved it gets a filled heart.
r.post('/:id/like', asyncHandler(async (req, res) => {
  assertCanInteract(req.user); const s = await live(req);
  const had = await StoryLike.findOne({ storyId: s._id, userId: req.user._id }).select('_id').lean(); let liked;
  if (had) { const d = await StoryLike.deleteOne({ _id: had._id }); if (d.deletedCount) await Story.updateOne({ _id: s._id, likeCount: { $gt: 0 } }, { $inc: { likeCount: -1 } }); liked = false; }
  else { const up = await StoryLike.updateOne({ storyId: s._id, userId: req.user._id }, { $setOnInsert: { storyId: s._id, userId: req.user._id } }, { upsert: true }); if (up.upsertedCount) { await Story.updateOne({ _id: s._id }, { $inc: { likeCount: 1 } }); if (String(s.authorId) !== req.user.id) await notify(s.authorId, 'STORY_LIKE', `${req.user.username} loved your status`, '/home').catch(() => {}); } liked = true; }
  const fresh = await Story.findById(s._id).select('likeCount').lean();
  res.json({ liked, ...(String(s.authorId) === req.user.id ? { likeCount: fresh?.likeCount || 0 } : {}) });
}));
// Is replying to this status allowed? (the owner decides who can message them)
r.get('/:id/reply-status', asyncHandler(async (req, res) => { const s = await live(req); const to = await User.findById(s.authorId).select('accountMode accountStatus dmPolicy'); res.json(await replyAccess(req.user, to)); }));
r.post('/:id/reply', asyncHandler(async (req, res) => {
  assertCanInteract(req.user); const { text } = z.object({ text: z.string().trim().min(1, 'Write a reply').max(1000) }).parse(req.body); const s = await live(req);
  const to = await User.findById(s.authorId).select('accountMode accountStatus dmPolicy'); const access = await replyAccess(req.user, to);
  if (!access.ok) throw new ApiError(403, access.reason || 'You can’t reply to this status.', access.code);
  const message = await sendStatusReply(req.user, s, text); res.status(201).json({ ok: true, conversationId: message.conversationId });
}));
r.delete('/:id', asyncHandler(async (req, res) => { const d = await Story.findOneAndDelete({ _id: req.params.id, authorId: req.user._id }); if (!d) throw new ApiError(404, 'Not found'); res.json({ ok: true }); }));
export default r;
