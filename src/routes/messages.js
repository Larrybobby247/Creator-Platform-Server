import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';
import { Conversation, Message, MediaAsset } from '../models/Social.js';
import { User } from '../models/User.js';
import { Block, Subscription, ConversationLabel } from '../models/Extra.js';
import { assertCanInteract } from '../utils/restrict.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { emitToUser, isOnline } from '../realtime.js';
import { getSetting } from '../services/settings.js';
import { assertVideoAllowed, probeDuration, storePrivate, signUrl } from '../services/media.js';
import { spend } from '../services/pointLedger.js';
import { recordEarning } from '../services/earnings.js';

const r = Router();
r.use(authenticate);
const unreadOf = (c, me) => Number((c.unread instanceof Map ? c.unread.get(String(me)) : c.unread?.[String(me)]) || 0);
const other = (c, me) => c.participants.find((p) => String(p._id || p) !== String(me));
const MIME = { 'image/jpeg': ['IMAGE', '.jpg'], 'image/png': ['IMAGE', '.png'], 'image/webp': ['IMAGE', '.webp'], 'video/mp4': ['VIDEO', '.mp4'], 'video/webm': ['VIDEO', '.webm'], 'video/quicktime': ['VIDEO', '.mov'],
  'audio/webm': ['VOICE', '.webm'], 'audio/ogg': ['VOICE', '.ogg'], 'audio/mp4': ['VOICE', '.m4a'], 'audio/mpeg': ['VOICE', '.mp3'], 'audio/wav': ['VOICE', '.wav'] };

// Never leak paid content: locked paid messages lose their text/media for everyone except sender and buyers.
export function shapeMsg(m, meId) {
  const o = m.toObject ? m.toObject() : { ...m };
  const mine = String(o.senderId) === String(meId);
  const unlocked = mine || (o.unlockedBy || []).some((u) => String(u) === String(meId));
  if (o.price > 0 && !unlocked) { delete o.paidText; delete o.mediaId; o.locked = true; }
  delete o.unlockedBy; return o;
}
const convFor = async (id, me) => { const c = await Conversation.findOne({ _id: id, participants: me }); if (!c) throw new ApiError(404, 'Conversation not found'); return c; };
async function deliver(c, m, from, clientId) {
  const to = other(c, from._id);
  c.lastMessageAt = new Date(); c.lastMessageText = m.type === 'TEXT' ? (m.text || '').slice(0, 120) : m.price > 0 ? '🔒 Paid message' : m.type === 'VOICE' ? '🎤 Voice message' : m.type === 'IMAGE' ? '📷 Photo' : '🎬 Video';
  c.unread.set(String(to), (c.unread.get(String(to)) || 0) + 1);
  if (String(c.requestedBy) !== String(from._id)) c.accepted = true;
  if (m.price > 0) c.paid = true;
  if (from.accountMode === 'CREATOR' && from.dmPolicy?.mode && from.dmPolicy.mode !== 'OPEN' && !(c.dmPaid || []).some((id) => String(id) === String(to))) c.dmPaid.push(to);
  await c.save();
  emitToUser(to, 'message:new', { message: { ...shapeMsg(m, to), clientId }, conversationId: c.id });
  const mine = { ...shapeMsg(m, from._id), clientId }; emitToUser(from._id, 'message:new', { message: mine, conversationId: c.id });
  return mine;
}
// Creators choose who may message them: everyone (OPEN), pay-to-message (PAID, subscribers free) or subscribers only.
async function enforceDmPolicy(from, to, conv) {
  const mode = to.accountMode === 'CREATOR' ? to.dmPolicy?.mode : 'OPEN'; if (!mode || mode === 'OPEN') return;
  if (conv && (conv.dmPaid || []).some((id) => String(id) === String(from._id))) return;
  if (await Subscription.exists({ subscriberId: from._id, creatorId: to._id, status: 'ACTIVE', expiresAt: { $gt: new Date() } })) return;
  if (mode === 'SUBSCRIBERS') throw Object.assign(new ApiError(403, 'Only subscribers can message this creator.', 'DM_SUBSCRIBERS_ONLY'), { extra: { creatorId: to.id } });
  throw Object.assign(new ApiError(402, 'This creator charges a fee to start a conversation.', 'DM_PAYMENT_REQUIRED'), { extra: { price: to.dmPolicy.pricePoints, creatorId: to.id } });
}
async function getOrCreateConv(from, toId) {
  assertCanInteract(from);
  const to = await User.findById(toId);
  if (!to || to.id === from.id || to.accountStatus === 'SUSPENDED') throw new ApiError(400, 'Invalid recipient');
  if (await Block.exists({ $or: [{ blockerId: to._id, blockedId: from._id }, { blockerId: from._id, blockedId: to._id }] })) throw new ApiError(403, 'You cannot message this account');
  let c = await Conversation.findOne({ participants: { $all: [from._id, to._id], $size: 2 } });
  await enforceDmPolicy(from, to, c);
  const fromGated = from.accountMode === 'CREATOR' && from.dmPolicy?.mode && from.dmPolicy.mode !== 'OPEN';
  if (!c) c = await Conversation.create({ participants: [from._id, to._id], requestedBy: from._id, accepted: to.prefs?.messages !== 'REQUESTS', dmPaid: fromGated ? [to._id] : [] }); // people a creator writes to can always reply
  return c;
}

r.get('/unread-count', asyncHandler(async (req, res) => {
  const cs = await Conversation.find({ participants: req.user._id, archivedBy: { $ne: req.user._id } }).select('unread').lean();
  res.json({ count: cs.reduce((n, c) => n + (unreadOf(c, req.user._id)), 0) });
}));

// ---- custom categories ("labels"): each person makes their own and files conversations under them
r.get('/labels', asyncHandler(async (req, res) => res.json({ items: await ConversationLabel.find({ ownerId: req.user._id }).sort('createdAt').select('name').lean() })));
r.post('/labels', asyncHandler(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(24) }).parse(req.body);
  if ((await ConversationLabel.countDocuments({ ownerId: req.user._id })) >= 10) throw new ApiError(409, 'You can create up to 10 categories');
  if (await ConversationLabel.exists({ ownerId: req.user._id, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })) throw new ApiError(409, 'You already have a category with that name');
  res.status(201).json(await ConversationLabel.create({ ownerId: req.user._id, name }));
}));
r.delete('/labels/:id', asyncHandler(async (req, res) => {
  const l = await ConversationLabel.findOneAndDelete({ _id: req.params.id, ownerId: req.user._id }); if (!l) throw new ApiError(404, 'Not found');
  await Conversation.updateMany({ participants: req.user._id }, { $pull: { labels: { userId: req.user._id, labelId: l._id } } }); res.json({ ok: true });
}));
r.post('/:id/label', asyncHandler(async (req, res) => {
  const { labelId, on } = z.object({ labelId: z.string(), on: z.boolean() }).parse(req.body);
  const c = await convFor(req.params.id, req.user._id); if (!(await ConversationLabel.exists({ _id: labelId, ownerId: req.user._id }))) throw new ApiError(404, 'Category not found');
  await Conversation.updateOne({ _id: c._id }, on ? { $addToSet: { labels: { userId: req.user._id, labelId } } } : { $pull: { labels: { userId: req.user._id, labelId } } }); res.json({ ok: true });
}));

r.get('/conversations', asyncHandler(async (req, res) => {
  const me = req.user._id, cat = String(req.query.category || 'all');
  const q = { participants: me };
  if (cat === 'archived') q.archivedBy = me; else q.archivedBy = { $ne: me };
  if (cat === 'unread') q[`unread.${me}`] = { $gt: 0 };
  if (cat === 'requests') { q.accepted = false; q.requestedBy = { $ne: me }; }
  if (cat === 'paid') q.paid = true;
  if (cat === 'subscribers') { // only meaningful for creators
    if (req.user.accountMode !== 'CREATOR') return res.json({ items: [] });
    const subs = await Subscription.find({ creatorId: me, status: 'ACTIVE', expiresAt: { $gt: new Date() } }).select('subscriberId').lean(); q.$and = [{ participants: { $in: subs.map((s) => s.subscriberId) } }];
  }
  if (cat.startsWith('label:')) { const id = cat.slice(6); if (!/^[0-9a-f]{24}$/i.test(id)) return res.json({ items: [] }); q.labels = { $elemMatch: { userId: me, labelId: id } }; }
  let items = await Conversation.find(q).sort('-lastMessageAt').limit(50).select('-__v').populate('participants', 'username displayName avatarUrl accountMode prefs').lean();
  if (cat === 'creators') items = items.filter((c) => other(c, me)?.accountMode === 'CREATOR');
  if (cat === 'users') items = items.filter((c) => other(c, me)?.accountMode === 'USER');
  res.json({ items: items.map((c) => { const o = { ...c }; const p = other(c, me); o.unreadCount = unreadOf(c, me); delete o.unread; o.myLabelIds = (c.labels || []).filter((l) => String(l.userId) === String(me)).map((l) => String(l.labelId)); delete o.labels; delete o.dmPaid; o.online = p?.prefs?.showOnline !== false && isOnline(p?._id); return o; }) });
}));

// Pay a creator's message fee once (subscribers never pay). After this you can message them freely.
r.post('/dm-access', asyncHandler(async (req, res) => {
  assertCanInteract(req.user); const { toUserId } = z.object({ toUserId: z.string() }).parse(req.body);
  const to = await User.findOne({ _id: toUserId, accountMode: 'CREATOR' }); if (!to || to.id === req.user.id) throw new ApiError(400, 'Invalid creator');
  if (to.dmPolicy?.mode !== 'PAID' || !(to.dmPolicy.pricePoints > 0)) throw new ApiError(400, 'This creator does not charge for messages');
  if (await Block.exists({ $or: [{ blockerId: to._id, blockedId: req.user._id }, { blockerId: req.user._id, blockedId: to._id }] })) throw new ApiError(403, 'You cannot message this account');
  let c = await Conversation.findOne({ participants: { $all: [req.user._id, to._id], $size: 2 } });
  if (c && c.dmPaid.some((id) => String(id) === req.user.id)) return res.json({ ok: true, already: true });
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'PAID_MESSAGE', amount: to.dmPolicy.pricePoints, idempotencyKey: `dm:${req.user.id}:${to.id}`, creatorId: to._id, meta: { kind: 'DM_ACCESS' } });
  if (!duplicate) await recordEarning({ creatorId: to._id, sourceTx: tx, gross: to.dmPolicy.pricePoints, label: 'message fee' });
  if (!c) c = await Conversation.create({ participants: [req.user._id, to._id], requestedBy: req.user._id, accepted: true, paid: true, dmPaid: [req.user._id] });
  else { await Conversation.updateOne({ _id: c._id }, { $addToSet: { dmPaid: req.user._id }, paid: true, accepted: true }); }
  res.json({ ok: true });
}));

// Cheap "I have read this" call (no message payload) used while a chat is open and new messages arrive.
r.post('/:id/read', asyncHandler(async (req, res) => {
  const c = await convFor(req.params.id, req.user._id);
  if (unreadOf(c, req.user._id) > 0) { c.unread.set(String(req.user._id), 0); await c.save(); }
  emitToUser(other(c, req.user._id), 'conversation:read', { conversationId: c.id, by: req.user.id }); res.json({ ok: true });
}));
r.get('/:conversationId', asyncHandler(async (req, res) => {
  const c = await convFor(req.params.conversationId, req.user._id);
  if (!req.query.before) { c.unread.set(String(req.user._id), 0); await c.save(); emitToUser(other(c, req.user._id), 'conversation:read', { conversationId: c.id, by: req.user.id }); }
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const rows = await Message.find({ conversationId: c._id, ...(before && !isNaN(before) ? { createdAt: { $lt: before } } : {}) }).sort('-createdAt').limit(41).lean();
  const hasMore = rows.length > 40; if (hasMore) rows.pop(); rows.reverse(); // newest 40, oldest first
  res.json({ messages: rows.map((m) => shapeMsg(m, req.user._id)), accepted: c.accepted, hasMore });
}));

const send = z.object({ toUserId: z.string(), text: z.string().min(1).max(4000), clientId: z.string().optional(), replyTo: z.string().optional() });
r.post('/', asyncHandler(async (req, res) => {
  const b = send.parse(req.body); const c = await getOrCreateConv(req.user, b.toUserId);
  const m = await Message.create({ conversationId: c._id, senderId: req.user._id, text: b.text, replyTo: b.replyTo });
  res.status(201).json(await deliver(c, m, req.user, b.clientId));
}));

// Attachments: image / video / voice. Duration is verified server-side with ffprobe. Optional price makes it a paid message (creators only).
const up = multer({ dest: os.tmpdir() }).single('file');
r.post('/attachment', up, asyncHandler(async (req, res) => {
  const f = req.file; try {
    if (!f) throw new ApiError(400, 'No file');
    const b = z.object({ toUserId: z.string(), clientId: z.string().optional(), replyTo: z.string().optional(), price: z.coerce.number().int().min(0).default(0), caption: z.string().max(500).optional() }).parse(req.body);
    const kind = MIME[f.mimetype]; if (!kind) throw new ApiError(415, 'Unsupported file type');
    const max = kind[0] === 'IMAGE' ? 10 * 1024 * 1024 : await getSetting('maxUploadBytes'); if (f.size > max) throw new ApiError(413, 'File too large');
    if (b.price > 0 && req.user.accountMode !== 'CREATOR') throw new ApiError(403, 'Only creators can send paid messages');
    const c = await getOrCreateConv(req.user, b.toUserId);
    let durationSec;
    if (kind[0] === 'VIDEO') durationSec = await assertVideoAllowed(f.path, req.user.creatorPlan);
    if (kind[0] === 'VOICE') { durationSec = await probeDuration(f.path); const lim = await getSetting('voiceMaxSec'); if (durationSec > lim + 0.5) throw new ApiError(422, `Voice messages can be up to ${lim}s`, 'VOICE_TOO_LONG'); }
    const key = storePrivate(f.path, kind[1]);
    const a = await MediaAsset.create({ ownerId: req.user._id, storageKey: key, mediaType: kind[0] === 'VOICE' ? 'AUDIO' : kind[0], mimeType: f.mimetype, size: f.size, durationSec });
    const m = await Message.create({ conversationId: c._id, senderId: req.user._id, type: kind[0], mediaType: kind[0], mediaId: a._id, text: b.caption, replyTo: b.replyTo, price: b.price });
    res.status(201).json(await deliver(c, m, req.user, b.clientId));
  } finally { if (f && fs.existsSync(f.path)) fs.unlinkSync(f.path); }
}));

// Paid text offer ("pay to read")
r.post('/paid', asyncHandler(async (req, res) => {
  if (req.user.accountMode !== 'CREATOR') throw new ApiError(403, 'Only creators can send paid messages');
  const b = z.object({ toUserId: z.string(), teaser: z.string().max(200).default('Paid message'), paidText: z.string().min(1).max(4000), price: z.number().int().min(1), clientId: z.string().optional() }).parse(req.body);
  const c = await getOrCreateConv(req.user, b.toUserId);
  const m = await Message.create({ conversationId: c._id, senderId: req.user._id, type: 'OFFER', text: b.teaser, paidText: b.paidText, price: b.price });
  res.status(201).json(await deliver(c, m, req.user, b.clientId));
}));
r.post('/message/:messageId/unlock', asyncHandler(async (req, res) => {
  const m = await Message.findById(req.params.messageId); if (!m || !(m.price > 0)) throw new ApiError(404, 'Not found');
  const c = await convFor(m.conversationId, req.user._id);
  if (String(m.senderId) === req.user.id) throw new ApiError(400, 'This is your message');
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'PAID_MESSAGE', amount: m.price, idempotencyKey: `pm:${req.user.id}:${m.id}`, creatorId: m.senderId, relatedId: m._id });
  if (!duplicate) { await Message.updateOne({ _id: m._id }, { $addToSet: { unlockedBy: req.user._id } }); await recordEarning({ creatorId: m.senderId, sourceTx: tx, gross: m.price, label: 'paid message' }); }
  else await Message.updateOne({ _id: m._id }, { $addToSet: { unlockedBy: req.user._id } });
  const fresh = await Message.findById(m._id); const out = shapeMsg(fresh, req.user._id);
  emitToUser(m.senderId, 'message:update', { message: { _id: m.id, unlockedByOther: true }, conversationId: c.id });
  res.json(out);
}));
// Signed, short-lived URL for a message's media. Only conversation participants; paid media only after unlock.
r.get('/message/:messageId/media', asyncHandler(async (req, res) => {
  const m = await Message.findById(req.params.messageId); if (!m?.mediaId) throw new ApiError(404, 'Not found');
  await convFor(m.conversationId, req.user._id);
  const s = shapeMsg(m, req.user._id); if (s.locked) throw new ApiError(403, 'Locked', 'LOCKED');
  res.json({ url: signUrl(m.mediaId, req.user.id, 300) });
}));
r.post('/message/:messageId/react', asyncHandler(async (req, res) => {
  const { emoji } = z.object({ emoji: z.enum(['❤️', '👍', '😂', '😮', '🔥']) }).parse(req.body);
  const m = await Message.findById(req.params.messageId); if (!m) throw new ApiError(404, 'Not found');
  const c = await convFor(m.conversationId, req.user._id);
  m.reactions = m.reactions.filter((x) => String(x.userId) !== req.user.id); if (!req.body.remove) m.reactions.push({ userId: req.user._id, emoji }); await m.save();
  for (const p of c.participants) emitToUser(p, 'message:update', { message: { _id: m.id, reactions: m.reactions }, conversationId: c.id });
  res.json({ reactions: m.reactions });
}));
r.post('/:id/accept', asyncHandler(async (req, res) => { const c = await convFor(req.params.id, req.user._id); c.accepted = true; await c.save(); res.json({ ok: true }); }));
r.post('/:id/archive', asyncHandler(async (req, res) => { const c = await convFor(req.params.id, req.user._id); await Conversation.updateOne({ _id: c._id }, { $addToSet: { archivedBy: req.user._id } }); res.json({ ok: true }); }));
export default r;
