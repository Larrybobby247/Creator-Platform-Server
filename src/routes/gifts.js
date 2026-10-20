import { Router } from 'express';
import { z } from 'zod';
import { Gift, GiftTransaction } from '../models/Social.js';
import { recordEarning } from '../services/earnings.js';
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
r.get('/catalogue', asyncHandler(async (_q, res) => { res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300'); res.json({ gifts: await Gift.find({ active: true }).sort('order').select('name description imageUrl pricePoints').lean() }); }));

r.post('/send', authenticate, asyncHandler(async (req, res) => {
  const b = z.object({ giftId: z.string(), creatorId: z.string(), quantity: z.number().int().min(1).max(50).default(1), idempotencyKey: z.string().min(8).max(100) }).parse(req.body);
  const [gift, creator] = await Promise.all([Gift.findOne({ _id: b.giftId, active: true }), User.findOne({ _id: b.creatorId, accountMode: 'CREATOR' })]);
  if (!gift || !creator) throw new ApiError(404, 'Gift or creator not found');
  if (creator.id === req.user.id) throw new ApiError(400, 'You cannot gift yourself');
  const gross = gift.pricePoints * b.quantity; // price comes from DB, never the client
  const { tx, duplicate } = await spend({ userId: req.user._id, type: 'CREATOR_GIFT', amount: gross, idempotencyKey: `gift:${req.user.id}:${b.idempotencyKey}`, creatorId: creator._id, relatedId: gift._id });
  if (duplicate) return res.json({ ok: true, duplicate: true });
  try {
    const { commission, net } = splitCommission(gross, await getSetting('commissionBps'));
    await GiftTransaction.create({ senderId: req.user._id, recipientId: creator._id, giftId: gift._id, quantity: b.quantity, grossPoints: gross, commissionPoints: commission, netPoints: net, transactionId: tx._id });
    await recordEarning({ creatorId: creator._id, sourceTx: tx, gross, label: 'gift' });
    await notify(creator._id, 'GIFT', `${req.user.username} sent you ${b.quantity}× ${gift.name}`, '/studio');
  } catch (e) { await reverse(tx._id, 'gift record failed'); throw e; }
  res.json({ ok: true, spent: gross });
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
