import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assertCanInteract } from '../utils/restrict.js';
import { MediaAsset, Post } from '../models/Social.js';
import { Subscription } from '../models/Extra.js';
import { PointTransaction } from '../models/Finance.js';
import { getSetting } from '../services/settings.js';
import { limitsFor } from '../services/plans.js';
import { assertVideoAllowed, storePrivate, signUrl, verifySig } from '../services/media.js';
import { sendStored } from '../services/storage.js';
import { spend } from '../services/pointLedger.js';
import { recordEarning } from '../services/earnings.js';
import { hasAccess } from '../services/access.js';
import { resolveMentions, notifyMentions } from '../services/mentions.js';

const r = Router();
const ALLOWED = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const isCreator = (u) => u.accountMode === 'CREATOR';
const MAX_ITEMS = 4, MAX_VIDEOS = 2;
const oid = (s) => /^[0-9a-f]{24}$/i.test(String(s));

// Anyone can upload photos/videos; the video length limit follows their plan (regular users get the Default limit).
// Files are stored privately (Cloudinary "authenticated" assets in production), never in the project folder.
r.post('/upload', authenticate, multer({ dest: os.tmpdir() }).single('file'), asyncHandler(async (req, res) => {
  const f = req.file; if (!f) throw new ApiError(400, 'No file'); assertCanInteract(req.user);
  try {
    if (!ALLOWED[f.mimetype]) throw new ApiError(415, 'Unsupported file type');
    if (f.size > (await getSetting('maxUploadBytes'))) throw new ApiError(413, 'File too large');
    const isVideo = f.mimetype.startsWith('video/'); const isPreview = req.query.kind === 'preview';
    if (isPreview && !isVideo) throw new ApiError(400, 'A preview must be a short video clip');
    if (isPreview && !isCreator(req.user)) throw new ApiError(403, 'Only creators can add previews');
    const durationSec = isVideo ? await assertVideoAllowed(f.path, req.user.creatorPlan, isPreview ? await getSetting('previewMaxSec') : undefined) : undefined; // server-verified
    const storageKey = await storePrivate(f.path, ALLOWED[f.mimetype]);
    const a = await MediaAsset.create({ ownerId: req.user._id, storageKey, mediaType: isVideo ? 'VIDEO' : 'IMAGE', mimeType: f.mimetype, size: f.size, durationSec });
    res.status(201).json({ id: a.id, durationSec, mediaType: a.mediaType });
  } finally { fs.existsSync(f.path) && fs.unlinkSync(f.path); }
}));

const priceOk = async (p) => { const cap = await getSetting('maxPriceCapPoints'); if (!Number.isInteger(p) || p < 1) throw new ApiError(400, 'Exclusive items need a price of at least 1 point'); if (p > cap) throw new ApiError(400, `That price looks too high (maximum ${cap} points).`, 'PRICE_TOO_HIGH'); };

async function checkPostRules(user, { access, unlockPricePoints, gatedItems = 0 }) {
  if ((access !== 'PUBLIC' || gatedItems > 0) && !isCreator(user)) throw new ApiError(403, 'Only creators can post exclusive or subscriber-only content.', 'CREATOR_ONLY');
  if (unlockPricePoints > 0 && !isCreator(user)) throw new ApiError(403, 'Only creators can put a price on content.', 'CREATOR_ONLY');
  if (access === 'EXCLUSIVE') await priceOk(unlockPricePoints); // any price is allowed: only a sanity ceiling applies
  if (access !== 'PUBLIC' || gatedItems > 0) { // Default plan: up to 50 exclusive posts. Pro: unlimited.
    const cap = (await limitsFor(user)).exclusivePostsPerMonth;
    if (cap !== null) {
      const used = await Post.countDocuments({ authorId: user._id, status: { $ne: 'DELETED' }, $or: [{ access: { $ne: 'PUBLIC' } }, { 'media.access': { $in: ['EXCLUSIVE', 'SUBSCRIBERS'] } }] });
      if (used >= cap) throw new ApiError(403, `You have reached the limit of ${cap} exclusive posts on the free plan. Upgrade to Pro for unlimited exclusive posts.`, 'PLAN_LIMIT');
    }
  }
}

const itemSchema = z.object({ mediaId: z.string(), access: z.enum(['PUBLIC', 'EXCLUSIVE', 'SUBSCRIBERS']).default('PUBLIC'), pricePoints: z.number().int().min(0).default(0) });
r.post('/posts', authenticate, asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const { content, mediaId, previewMediaId, coverUrl, draft, access = 'PUBLIC', unlockPricePoints = 0, exclusiveText } = req.body;
  const items = req.body.media === undefined ? null : z.array(itemSchema).max(MAX_ITEMS, `You can add up to ${MAX_ITEMS} photos or videos`).parse(req.body.media);
  if (!['PUBLIC', 'EXCLUSIVE', 'SUBSCRIBERS'].includes(access)) throw new ApiError(400, 'Invalid visibility');
  const caption = String(content || '').slice(0, 5000);

  if (items?.length) { // ---- new style: up to 4 items, each with its own access
    if (new Set(items.map((i) => i.mediaId)).size !== items.length) throw new ApiError(400, 'The same file was added twice');
    const assets = await MediaAsset.find({ _id: { $in: items.map((i) => (oid(i.mediaId) ? i.mediaId : null)).filter(Boolean) }, ownerId: req.user._id }).lean();
    if (assets.length !== items.length) throw new ApiError(403, 'Not your media');
    const A = Object.fromEntries(assets.map((a) => [String(a._id), a]));
    if (assets.some((a) => !['IMAGE', 'VIDEO'].includes(a.mediaType))) throw new ApiError(400, 'Only photos and videos can be added to a post');
    if (assets.filter((a) => a.mediaType === 'VIDEO').length > MAX_VIDEOS) throw new ApiError(400, `A post can have at most ${MAX_VIDEOS} videos (and ${MAX_ITEMS} items in total)`, 'TOO_MANY_VIDEOS');
    const media = [];
    for (const it of items) {
      if (it.access === 'EXCLUSIVE') await priceOk(it.pricePoints);
      const a = A[it.mediaId]; media.push({ mediaId: a._id, mediaType: a.mediaType, access: it.access, pricePoints: it.access === 'EXCLUSIVE' ? it.pricePoints : 0, durationSec: a.durationSec });
    }
    const gated = media.filter((m) => m.access !== 'PUBLIC').length;
    const svc = req.user.services || {}; // services the creator switched off in Settings stay off
    if (media.some((m) => m.access !== 'PUBLIC' && m.mediaType === 'IMAGE') && svc.paidPhotos?.enabled === false) throw new ApiError(403, 'Paid photos are switched off. Turn them on in Settings → Creator services.', 'SERVICE_OFF');
    if (media.some((m) => m.access !== 'PUBLIC' && m.mediaType === 'VIDEO') && svc.paidVideos?.enabled === false) throw new ApiError(403, 'Paid videos are switched off. Turn them on in Settings → Creator services.', 'SERVICE_OFF');
    await checkPostRules(req.user, { access: 'PUBLIC', unlockPricePoints: 0, gatedItems: gated });
    if (exclusiveText && !gated) throw new ApiError(400, 'Protected text needs at least one exclusive or subscriber-only item');
    const mentions = await resolveMentions(caption, req.user._id);
    const post = await Post.create({ authorId: req.user._id, content: caption, media, mentions, coverUrl, access: 'PUBLIC', exclusiveText: gated ? exclusiveText : undefined, mediaTypeHint: media[0].mediaType, status: draft ? 'DRAFT' : 'PUBLISHED' });
    if (!draft) await notifyMentions(mentions, req.user, 'in a post', '/home');
    return res.status(201).json(post);
  }

  // ---- legacy / text-only: one optional media file and one post-level access
  await checkPostRules(req.user, { access, unlockPricePoints });
  if (!caption.trim() && !mediaId) throw new ApiError(400, 'Write something or add a photo or video');
  let asset; for (const id of [mediaId, previewMediaId].filter(Boolean)) { const a = oid(id) && await MediaAsset.findOne({ _id: id, ownerId: req.user._id }); if (!a) throw new ApiError(403, 'Not your media'); if (id === mediaId) asset = a; }
  if (previewMediaId && !isCreator(req.user)) throw new ApiError(403, 'Only creators can add previews');
  const mentions = await resolveMentions(caption, req.user._id);
  const post = await Post.create({ authorId: req.user._id, content: caption, mediaId, previewMediaId, coverUrl, access, unlockPricePoints: access === 'EXCLUSIVE' ? unlockPricePoints : 0, exclusiveText: access === 'PUBLIC' ? undefined : exclusiveText, mediaTypeHint: asset?.mediaType, mentions, status: draft ? 'DRAFT' : 'PUBLISHED' });
  if (!draft) await notifyMentions(mentions, req.user, 'in a post', '/home');
  res.status(201).json(post);
}));

r.get('/posts/mine', authenticate, asyncHandler(async (req, res) => res.json({ items: await Post.find({ authorId: req.user._id, status: { $ne: 'DELETED' } }).sort({ pinnedAt: -1, createdAt: -1 }).limit(100).select('-__v').lean() })));

r.patch('/posts/:id', authenticate, asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const p = await Post.findOne({ _id: req.params.id, authorId: req.user._id, status: { $ne: 'DELETED' } }); if (!p) throw new ApiError(404, 'Not found');
  const { content, exclusiveText, unlockPricePoints, status, coverUrl, mediaPrices } = req.body; const wasDraft = p.status === 'DRAFT';
  if (content !== undefined) { p.content = String(content).slice(0, 5000); p.mentions = await resolveMentions(p.content, req.user._id); }
  if (exclusiveText !== undefined) { if (!isCreator(req.user)) throw new ApiError(403, 'Only creators can edit protected text', 'CREATOR_ONLY'); p.exclusiveText = String(exclusiveText).slice(0, 5000); }
  if (coverUrl !== undefined) p.coverUrl = coverUrl;
  if (unlockPricePoints !== undefined) { await priceOk(unlockPricePoints); if (!isCreator(req.user)) throw new ApiError(403, 'Only creators can put a price on content.', 'CREATOR_ONLY'); if (p.access === 'EXCLUSIVE') p.unlockPricePoints = unlockPricePoints; } // past buyers keep access at the price they paid
  if (Array.isArray(mediaPrices)) for (const mp of z.array(z.object({ idx: z.number().int().min(0).max(3), pricePoints: z.number().int() })).parse(mediaPrices)) { const it = p.media[mp.idx]; if (it?.access === 'EXCLUSIVE') { await priceOk(mp.pricePoints); it.pricePoints = mp.pricePoints; } }
  if (status && ['DRAFT', 'PUBLISHED'].includes(status)) { p.status = status; if (status === 'DRAFT') p.pinnedAt = undefined; }
  await p.save();
  if (wasDraft && p.status === 'PUBLISHED') await notifyMentions(p.mentions || [], req.user, 'in a post', '/home');
  res.json(p);
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

// ---- per-item access (new style posts) ----
const visiblePost = async (id) => { const p = oid(id) ? await Post.findById(id) : null; if (!p || p.status !== 'PUBLISHED' || ['REMOVED', 'RESTRICTED'].includes(p.moderation?.status)) throw new ApiError(404, 'Not found'); return p; };
const unlockedIdx = async (userId, post) => new Set((await PointTransaction.find({ userId, type: 'EXCLUSIVE_CONTENT_UNLOCK', relatedId: post._id, status: 'COMPLETED' }).select('meta').lean()).map((t) => t.meta?.idx));
async function itemAllowed(user, post, idx) {
  const it = post.media?.[idx]; if (!it) return false;
  if (it.access === 'PUBLIC' || String(post.authorId) === String(user._id)) return true;
  if (it.access === 'EXCLUSIVE') return (await unlockedIdx(user._id, post)).has(idx);
  return !!(await Subscription.exists({ subscriberId: user._id, creatorId: post.authorId, status: 'ACTIVE', expiresAt: { $gt: new Date() } }));
}
// Unlock one exclusive item, or all remaining exclusive items at once ({ all: true }). Legacy posts: no body = unlock the post.
r.post('/posts/:id/unlock', authenticate, asyncHandler(async (req, res) => {
  assertCanInteract(req.user);
  const post = await Post.findOne({ _id: req.params.id, status: 'PUBLISHED' }); if (!post) throw new ApiError(404, 'Not found');
  if (post.media?.length) {
    const b = z.object({ idx: z.number().int().min(0).max(3).optional(), all: z.boolean().optional() }).parse(req.body || {}); const done = await unlockedIdx(req.user._id, post); let todo;
    if (b.all) todo = post.media.map((m, i) => (m.access === 'EXCLUSIVE' && !done.has(i) ? i : -1)).filter((i) => i >= 0);
    else if (b.idx !== undefined) { if (post.media[b.idx]?.access !== 'EXCLUSIVE') throw new ApiError(400, 'This item is not for sale'); todo = done.has(b.idx) ? [] : [b.idx]; }
    else throw new ApiError(400, 'Choose which item to unlock');
    for (const i of todo) {
      const price = post.media[i].pricePoints;
      const { tx, duplicate } = await spend({ userId: req.user._id, type: 'EXCLUSIVE_CONTENT_UNLOCK', amount: price, idempotencyKey: `unlock:${req.user.id}:${post.id}:${i}`, creatorId: post.authorId, relatedId: post._id, meta: { idx: i } });
      if (!duplicate) await recordEarning({ creatorId: post.authorId, sourceTx: tx, gross: price, label: 'unlock' });
    }
    return res.json({ ok: true, unlocked: todo.length });
  }
  if (post.access !== 'EXCLUSIVE') throw new ApiError(404, 'Not found');
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'EXCLUSIVE_CONTENT_UNLOCK', amount: post.unlockPricePoints, idempotencyKey: `unlock:${req.user.id}:${post.id}`, creatorId: post.authorId, relatedId: post._id });
  if (!duplicate) await recordEarning({ creatorId: post.authorId, sourceTx: tx, gross: post.unlockPricePoints, label: 'unlock' });
  res.json({ ok: true });
}));
// Short-lived signed URL for ONE item, only if the caller is entitled.
r.get('/posts/:id/media/:idx', authenticate, asyncHandler(async (req, res) => {
  const post = await visiblePost(req.params.id); const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || !post.media?.[idx]) throw new ApiError(404, 'Not found');
  if (!(await itemAllowed(req.user, post, idx))) throw new ApiError(403, 'Locked', 'LOCKED');
  res.json({ url: signUrl(post.media[idx].mediaId, req.user.id, 300) });
}));
// Legacy single-media posts.
r.get('/posts/:id/playback', authenticate, asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post?.mediaId || post.status !== 'PUBLISHED' || ['REMOVED', 'RESTRICTED'].includes(post.moderation?.status)) throw new ApiError(404, 'Not found');
  if (!(await hasAccess(req.user, post))) throw new ApiError(403, 'Locked', 'LOCKED');
  res.json({ url: signUrl(post.mediaId, req.user.id, 300) });
}));
// The only way to read stored bytes: a per-user, expiring signature minted after an access check. Cloudinary itself is never exposed.
r.get('/:id/stream', asyncHandler(async (req, res) => {
  const { uid, exp, sig } = req.query;
  if (!verifySig(req.params.id, uid, exp, sig)) throw new ApiError(403, 'Link expired');
  const a = oid(req.params.id) && await MediaAsset.findById(req.params.id);
  if (!a) throw new ApiError(404, 'Not found');
  await sendStored(req, res, a);
}));
export default r;
