import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';
import { Story, StoryView, Follow, Block } from '../models/Extra.js';
import { MediaAsset } from '../models/Social.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assertCanInteract } from '../utils/restrict.js';
import { getSetting } from '../services/settings.js';
import { assertVideoAllowed, storePrivate, signUrl } from '../services/media.js';

const r = Router();
r.use(authenticate);
const TTL = 24 * 3600e3, MAX_ACTIVE = 10;
const MIME = { 'image/jpeg': ['IMAGE', '.jpg'], 'image/png': ['IMAGE', '.png'], 'image/webp': ['IMAGE', '.webp'], 'video/mp4': ['VIDEO', '.mp4'], 'video/webm': ['VIDEO', '.webm'], 'video/quicktime': ['VIDEO', '.mov'] };
const BG = ['violet', 'pink', 'blue', 'green', 'amber'];
const AUTHOR = 'username displayName avatarUrl accountMode creatorPlan';

// Add a status: a photo/video (video length follows your plan) or a short text card. Expires after 24 hours.
r.post('/', multer({ dest: os.tmpdir() }).single('file'), asyncHandler(async (req, res) => {
  const f = req.file; try {
    assertCanInteract(req.user);
    const b = z.object({ text: z.string().max(220).optional(), bg: z.enum(BG).optional() }).parse(req.body);
    if ((await Story.countDocuments({ authorId: req.user._id, expiresAt: { $gt: new Date() } })) >= MAX_ACTIVE) throw new ApiError(409, `You can have up to ${MAX_ACTIVE} active statuses.`);
    let type = 'TEXT', mediaId;
    if (f) {
      const kind = MIME[f.mimetype]; if (!kind) throw new ApiError(415, 'Use a JPG/PNG/WebP image or an MP4/WebM video'); if (f.size > (await getSetting('maxUploadBytes'))) throw new ApiError(413, 'File too large');
      type = kind[0]; const durationSec = type === 'VIDEO' ? await assertVideoAllowed(f.path, req.user.creatorPlan) : undefined;
      const a = await MediaAsset.create({ ownerId: req.user._id, storageKey: await storePrivate(f.path, kind[1]), mediaType: type, mimeType: f.mimetype, size: f.size, durationSec }); mediaId = a._id;
    } else if (!b.text?.trim()) throw new ApiError(400, 'Add a photo, a video or some text');
    const s = await Story.create({ authorId: req.user._id, type, text: b.text?.trim(), bg: b.bg || 'violet', mediaId, expiresAt: new Date(Date.now() + TTL) });
    res.status(201).json({ story: s });
  } finally { if (f && fs.existsSync(f.path)) fs.unlinkSync(f.path); }
}));

const group = (rows, seen, source) => { const by = new Map(); for (const s of rows) { const k = String(s.authorId._id); if (!by.has(k)) by.set(k, { user: s.authorId, source, stories: [] }); by.get(k).stories.push({ _id: s._id, type: s.type, text: s.text, bg: s.bg, createdAt: s.createdAt, seen: seen.has(String(s._id)), hasMedia: !!s.mediaId }); }
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
  const groups = group(fol, seen, 'following').sort((a, b) => Number(b.unseen) - Number(a.unseen)).concat(group(sug, seen, 'suggested').slice(0, 5));
  res.json({ mine: group(mine, seen, 'me')[0] || null, groups });
}));
r.get('/user/:userId', asyncHandler(async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.userId)) throw new ApiError(400, 'Bad id');
  if (await Block.exists({ $or: [{ blockerId: req.params.userId, blockedId: req.user._id }, { blockerId: req.user._id, blockedId: req.params.userId }] })) return res.json({ group: null });
  const rows = await Story.find({ authorId: req.params.userId, expiresAt: { $gt: new Date() } }).populate('authorId', AUTHOR).lean();
  const seen = new Set((await StoryView.find({ userId: req.user._id, storyId: { $in: rows.map((s) => s._id) } }).select('storyId').lean()).map((x) => String(x.storyId)));
  res.json({ group: group(rows, seen, 'profile')[0] || null });
}));
const live = async (req) => { const s = await Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } }); if (!s) throw new ApiError(404, 'This status has expired'); if (await Block.exists({ $or: [{ blockerId: s.authorId, blockedId: req.user._id }, { blockerId: req.user._id, blockedId: s.authorId }] })) throw new ApiError(404, 'Not found'); return s; };
r.get('/:id/media', asyncHandler(async (req, res) => { const s = await live(req); if (!s.mediaId) throw new ApiError(404, 'No media'); res.json({ url: signUrl(s.mediaId, req.user.id, 300) }); }));
r.post('/:id/view', asyncHandler(async (req, res) => {
  const s = await live(req); if (String(s.authorId) === req.user.id) return res.json({ ok: true });
  const up = await StoryView.updateOne({ storyId: s._id, userId: req.user._id }, { $setOnInsert: { storyId: s._id, userId: req.user._id } }, { upsert: true }); if (up.upsertedCount) await Story.updateOne({ _id: s._id }, { $inc: { viewCount: 1 } });
  res.json({ ok: true });
}));
r.delete('/:id', asyncHandler(async (req, res) => { const d = await Story.findOneAndDelete({ _id: req.params.id, authorId: req.user._id }); if (!d) throw new ApiError(404, 'Not found'); res.json({ ok: true }); }));
export default r;
