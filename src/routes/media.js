import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assertCanInteract } from '../utils/restrict.js';
import { MediaAsset, Post } from '../models/Social.js';
import { PointTransaction } from '../models/Finance.js';
import { env } from '../config/env.js';
import { getSetting } from '../services/settings.js';
import { limitsFor } from '../services/plans.js';
import { assertVideoAllowed, storePrivate, signUrl, verifySig } from '../services/media.js';
import { spend } from '../services/pointLedger.js';
import { recordEarning } from '../services/earnings.js';
import { hasAccess } from '../services/access.js';

const r = Router();
const ALLOWED = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const isCreator = (u) => u.accountMode === 'CREATOR';

// Anyone can upload photos/videos; the video length limit follows their plan (regular users get the Default limit).
r.post('/upload', authenticate, multer({ dest: os.tmpdir() }).single('file'), asyncHandler(async (req, res) => {
  const f = req.file; if (!f) throw new ApiError(400, 'No file'); assertCanInteract(req.user);
  try {
    if (!ALLOWED[f.mimetype]) throw new ApiError(415, 'Unsupported file type');
    if (f.size > (await getSetting('maxUploadBytes'))) throw new ApiError(413, 'File too large');
    const isVideo = f.mimetype.startsWith('video/'); const isPreview = req.query.kind === 'preview';
    if (isPreview && !isVideo) throw new ApiError(400, 'A preview must be a short video clip');
    if (isPreview && !isCreator(req.user)) throw new ApiError(403, 'Only creators can add previews');
    const durationSec = isVideo ? await assertVideoAllowed(f.path, req.user.creatorPlan, isPreview ? await getSetting('previewMaxSec') : undefined) : undefined; // server-verified
    const storageKey = storePrivate(f.path, ALLOWED[f.mimetype]);
    const a = await MediaAsset.create({ ownerId: req.user._id, storageKey, mediaType: isVideo ? 'VIDEO' : 'IMAGE', mimeType: f.mimetype, size: f.size, durationSec });
    res.status(201).json({ id: a.id, durationSec });
  } finally { fs.existsSync(f.path) && fs.unlinkSync(f.path); }
}));

async function checkPostRules(user, { access, unlockPricePoints }) {
  if (access !== 'PUBLIC' && !isCreator(user)) throw new ApiError(403, 'Only creators can post exclusive or subscriber-only content.', 'CREATOR_ONLY');
  if (unlockPricePoints > 0 && !isCreator(user)) throw new ApiError(403, 'Only creators can put a price on content.', 'CREATOR_ONLY');
  if (access === 'EXCLUSIVE') {
    if (!Number.isInteger(unlockPricePoints) || unlockPricePoints < 1) throw new ApiError(400, 'Exclusive posts need a point price');
    const lim = await limitsFor(user);
    if (unlockPricePoints > lim.maxUnlockPoints) throw new ApiError(400, `Your plan allows prices up to ${lim.maxUnlockPoints} points. Upgrade to Pro for higher prices.`, 'PLAN_LIMIT');
  }
}

r.post('/posts', authenticate, asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const { content, mediaId, previewMediaId, coverUrl, draft, access = 'PUBLIC', unlockPricePoints = 0, exclusiveText } = req.body;
  if (!['PUBLIC', 'EXCLUSIVE', 'SUBSCRIBERS'].includes(access)) throw new ApiError(400, 'Invalid visibility');
  await checkPostRules(req.user, { access, unlockPricePoints });
  if (!String(content || '').trim() && !mediaId) throw new ApiError(400, 'Write something or add a photo or video');
  let asset; for (const id of [mediaId, previewMediaId].filter(Boolean)) { const a = await MediaAsset.findOne({ _id: id, ownerId: req.user._id }); if (!a) throw new ApiError(403, 'Not your media'); if (id === mediaId) asset = a; }
  if (previewMediaId && !isCreator(req.user)) throw new ApiError(403, 'Only creators can add previews');
  res.status(201).json(await Post.create({ authorId: req.user._id, content: String(content || '').slice(0, 5000), mediaId, previewMediaId, coverUrl, access, unlockPricePoints: access === 'EXCLUSIVE' ? unlockPricePoints : 0, exclusiveText: access === 'PUBLIC' ? undefined : exclusiveText, mediaTypeHint: asset?.mediaType, status: draft ? 'DRAFT' : 'PUBLISHED' }));
}));

r.get('/posts/mine', authenticate, asyncHandler(async (req, res) => res.json({ items: await Post.find({ authorId: req.user._id, status: { $ne: 'DELETED' } }).sort({ pinnedAt: -1, createdAt: -1 }).limit(100).select('-__v').lean() })));

r.patch('/posts/:id', authenticate, asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const p = await Post.findOne({ _id: req.params.id, authorId: req.user._id, status: { $ne: 'DELETED' } }); if (!p) throw new ApiError(404, 'Not found');
  const { content, exclusiveText, unlockPricePoints, status, coverUrl } = req.body;
  if (content !== undefined) p.content = String(content).slice(0, 5000);
  if (exclusiveText !== undefined) { if (!isCreator(req.user)) throw new ApiError(403, 'Only creators can edit protected text', 'CREATOR_ONLY'); p.exclusiveText = String(exclusiveText).slice(0, 5000); }
  if (coverUrl !== undefined) p.coverUrl = coverUrl;
  if (unlockPricePoints !== undefined) { await checkPostRules(req.user, { access: p.access === 'EXCLUSIVE' ? 'EXCLUSIVE' : 'PUBLIC', unlockPricePoints: p.access === 'EXCLUSIVE' ? unlockPricePoints : 1 }); if (p.access === 'EXCLUSIVE') p.unlockPricePoints = unlockPricePoints; } // past buyers keep access at the price they paid
  if (status && ['DRAFT', 'PUBLISHED'].includes(status)) { p.status = status; if (status === 'DRAFT') p.pinnedAt = undefined; }
  await p.save(); res.json(p);
}));
// Policy: content that has been purchased cannot be deleted (buyers paid for access). Move it to draft instead.
r.delete('/posts/:id', authenticate, asyncHandler(async (req, res) => {
  const p = await Post.findOne({ _id: req.params.id, authorId: req.user._id, status: { $ne: 'DELETED' } }); if (!p) throw new ApiError(404, 'Not found');
  if (await PointTransaction.exists({ relatedId: p._id, type: 'EXCLUSIVE_CONTENT_UNLOCK', status: 'COMPLETED' })) throw new ApiError(409, 'This content has buyers and cannot be deleted. Set it to draft instead.', 'HAS_BUYERS');
  p.status = 'DELETED'; p.pinnedAt = undefined; await p.save(); res.json({ ok: true });
}));
// Pin / unpin on your own profile. Creators can pin exclusive posts too. The number of pins depends on the plan (admin-configurable).
r.post('/posts/:id/pin', authenticate, asyncHandler(async (req, res) => {
  const p = await Post.findOne({ _id: req.params.id, authorId: req.user._id, status: 'PUBLISHED', communityId: { $exists: false } }); if (!p) throw new ApiError(404, 'Only your published profile posts can be pinned');
  if (p.pinnedAt) { p.pinnedAt = undefined; await p.save(); return res.json({ pinned: false }); }
  const lim = (await limitsFor(req.user)).pinnedPosts;
  if ((await Post.countDocuments({ authorId: req.user._id, status: 'PUBLISHED', pinnedAt: { $ne: null } })) >= lim) throw new ApiError(409, `You can pin up to ${lim} post${lim === 1 ? '' : 's'}. Unpin one first${isCreator(req.user) ? ' or upgrade to Pro for more' : ''}.`, 'PIN_LIMIT');
  p.pinnedAt = new Date(); await p.save(); res.json({ pinned: true });
}));
r.get('/posts/:id/preview', authenticate, asyncHandler(async (req, res) => {
  const p = await Post.findOne({ _id: req.params.id, status: 'PUBLISHED' }); if (!p?.previewMediaId) throw new ApiError(404, 'No preview');
  res.json({ url: signUrl(p.previewMediaId, req.user.id, 300) });
}));
r.post('/posts/:id/unlock', authenticate, asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const post = await Post.findOne({ _id: req.params.id, access: 'EXCLUSIVE', status: 'PUBLISHED' });
  if (!post) throw new ApiError(404, 'Not found');
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'EXCLUSIVE_CONTENT_UNLOCK', amount: post.unlockPricePoints, idempotencyKey: `unlock:${req.user.id}:${post.id}`, creatorId: post.authorId, relatedId: post._id });
  if (!duplicate) await recordEarning({ creatorId: post.authorId, sourceTx: tx, gross: post.unlockPricePoints, label: 'unlock' });
  res.json({ ok: true });
}));
// Returns a short-lived signed URL only if the caller is entitled.
r.get('/posts/:id/playback', authenticate, asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post?.mediaId || post.status !== 'PUBLISHED' || ['REMOVED', 'RESTRICTED'].includes(post.moderation?.status)) throw new ApiError(404, 'Not found');
  if (!(await hasAccess(req.user, post))) throw new ApiError(403, 'Locked', 'LOCKED');
  res.json({ url: signUrl(post.mediaId, req.user.id, 300) });
}));
r.get('/:id/stream', asyncHandler(async (req, res) => {
  const { uid, exp, sig } = req.query;
  if (!verifySig(req.params.id, uid, exp, sig)) throw new ApiError(403, 'Link expired');
  const a = await MediaAsset.findById(req.params.id);
  if (!a) throw new ApiError(404, 'Not found');
  res.type(a.mimeType).sendFile(path.resolve(env.mediaDir, a.storageKey)); // sendFile handles Range for video
}));
export default r;
