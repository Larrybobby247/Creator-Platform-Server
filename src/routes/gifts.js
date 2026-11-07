import { Router } from 'express';
import { z } from 'zod';
import { Gift, GiftTransaction } from '../models/Social.js';
import { recordEarning, commissionFor } from '../services/earnings.js';
import { notify } from '../services/notify.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireAdmin } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { spend, reverse } from '../services/pointLedger.js';
import { getSetting } from '../services/settings.js';
import { splitCommission } from '../utils/money.js';

const r = Router();
// Icons live on the server so every screen (catalogue, sent confirmation, notifications) shows the same emoji. Custom gifts always get the dragon.
export const GIFT_ICON = { Heart: '❤️', Rose: '🌹', Star: '⭐', Diamond: '💎', Crown: '👑', Trophy: '🏆', 'Premium Gift': '🎁' };
export const CUSTOM_ICON = '🐉'; export const CUSTOM_MIN = 100;
export const iconOf = (name) => GIFT_ICON[name] || '🎁';
r.get('/catalogue', asyncHandler(async (_q, res) => { res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300'); const gifts = await Gift.find({ active: true }).sort('order').select('name description imageUrl pricePoints').lean(); res.json({ gifts: gifts.map((g) => ({ ...g, icon: iconOf(g.name) })), custom: { icon: CUSTOM_ICON, minPoints: CUSTOM_MIN } }); }));

r.post('/send', authenticate, asyncHandler(async (req, res) => {
  // Either a catalogue gift (giftId + quantity) or a custom gift (custom: true + points, never below 100).
  const b = z.object({ giftId: z.string().optional(), custom: z.boolean().optional(), points: z.number().int().optional(), creatorId: z.string(), quantity: z.number().int().min(1).max(50).default(1), idempotencyKey: z.string().min(8).max(100) }).parse(req.body);
  const [gift, creator] = await Promise.all([b.custom ? null : Gift.findOne({ _id: b.giftId, active: true }), User.findOne({ _id: b.creatorId, accountMode: 'CREATOR' })]);
  if (!creator || (!b.custom && !gift)) throw new ApiError(404, 'Gift or creator not found');
  if (b.custom && !(b.points >= CUSTOM_MIN)) throw new ApiError(400, `A custom gift is ${CUSTOM_MIN} points or more.`, 'CUSTOM_TOO_LOW');
  if (b.custom && b.points > 1_000_000) throw new ApiError(400, 'That custom gift is too large.');
  if (creator.id === req.user.id) throw new ApiError(400, 'You cannot gift yourself');
  if (creator.services?.tipsGifts?.enabled === false) throw new ApiError(403, 'This creator is not accepting tips and gifts right now.', 'SERVICE_OFF');
  const quantity = b.custom ? 1 : b.quantity; const gross = b.custom ? b.points : gift.pricePoints * quantity; // price comes from DB (or the checked custom amount), never a client-supplied catalogue price
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'CREATOR_GIFT', amount: gross, idempotencyKey: `gift:${req.user.id}:${b.idempotencyKey}`, creatorId: creator._id, ...(gift ? { relatedId: gift._id } : {}) });
  if (duplicate) return res.json({ ok: true, duplicate: true });
  const icon = b.custom ? CUSTOM_ICON : iconOf(gift.name); const label = b.custom ? `a custom gift (${gross} pts)` : `${quantity}× ${gift.name}`;
  try {
    const { commission, net } = splitCommission(gross, await commissionFor(creator._id));
    await GiftTransaction.create({ senderId: req.user._id, recipientId: creator._id, giftId: gift?._id, custom: !!b.custom, quantity, grossPoints: gross, commissionPoints: commission, netPoints: net, transactionId: tx._id });
    await recordEarning({ creatorId: creator._id, sourceTx: tx, gross, label: b.custom ? 'custom gift' : 'gift' });
    await notify(creator._id, 'GIFT', `${icon} ${req.user.username} sent you ${label}`, '/studio');
  } catch (e) { await reverse(tx._id, 'gift record failed'); throw e; }
  res.json({ ok: true, spent: gross, icon, custom: !!b.custom });
}));

// Admin catalogue management
r.post('/', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string(), description: z.string().optional(), imageUrl: z.string().optional(), pricePoints: z.number().int().min(1), order: z.number().int().optional() }).parse(req.body);
  res.status(201).json(await Gift.create(b));
}));
r.patch('/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const b = z.object({ pricePoints: z.number().int().min(1).optional(), active: z.boolean().optional(), name: z.string().optional(), imageUrl: z.string().optional(), description: z.string().optional(), order: z.number().int().optional() }).parse(req.body);
  res.json(await Gift.findByIdAndUpdate(req.params.id, b, { new: true }));
}));
export default r;
