import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { Wallet, PointTransaction } from '../models/Finance.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { getSetting } from '../services/settings.js';
import { createPendingCredit, completeCredit } from '../services/pointLedger.js';
import * as paystack from '../services/paymentProvider.js';
import { env } from '../config/env.js';
import { nairaToKobo } from '../utils/money.js';
import { notify } from '../services/notify.js';
import { Payout, PointPackage, WebhookLog } from '../models/Extra.js';

const r = Router();
async function packagesList() { const rows = await PointPackage.find({ active: true }).sort({ order: 1, points: 1 }).select('name points bonusPoints').lean(); return rows.length ? rows : (await getSetting('pointPackages')).map((p) => ({ name: `${p} point${p === 1 ? '' : 's'}`, points: p, bonusPoints: 0 })); }
// Credits any promotional bonus once, after the purchase itself completed.
async function afterPurchase(tx) {
  const bonus = tx.meta?.bonus || 0;
  if (bonus > 0) { const b = await createPendingCredit({ userId: tx.userId, type: 'PROMOTIONAL_BONUS', amount: bonus, idempotencyKey: `bonus:${tx._id}`, meta: { source: tx.reference } }); await completeCredit(b._id); }
  await notify(tx.userId, 'PAYMENT', `${tx.amount}${bonus ? ` + ${bonus} bonus` : ''} points added to your wallet`, '/wallet');
}

// Webhook: raw body + HMAC check + server-side re-verification + amount match. Credits exactly once.
r.post('/webhook', express.raw({ type: '*/*' }), asyncHandler(async (req, res) => {
  if (!paystack.validSignature(req.body, req.headers['x-paystack-signature'])) throw new ApiError(401, 'Bad signature');
  const evt = JSON.parse(req.body.toString('utf8'));
  try {
  if (evt.event === 'charge.success') await settle(evt.data.reference);
  if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(evt.event)) {
    const st = { 'transfer.success': 'PAID', 'transfer.failed': 'FAILED', 'transfer.reversed': 'REVERSED' }[evt.event];
    const p = await Payout.findOneAndUpdate({ reference: evt.data.reference, status: { $in: ['PROCESSING', 'PENDING'] } }, { status: st, failReason: evt.data.reason }, { new: true });
    if (p) await notify(p.creatorId, 'PAYOUT', `Your withdrawal is ${st.toLowerCase()}`, '/studio'); // failed/reversed payouts return to available earnings automatically
  }
  await WebhookLog.create({ provider: 'paystack', event: evt.event, reference: evt.data?.reference, ok: true });
  } catch (e) { await WebhookLog.create({ provider: 'paystack', event: evt.event, reference: evt.data?.reference, ok: false, error: String(e.message).slice(0, 200) }); throw e; }
  res.sendStatus(200);
}));

async function settle(reference) {
  const tx = await PointTransaction.findOne({ idempotencyKey: `purchase:${reference}`, type: 'POINT_PURCHASE' });
  if (!tx || tx.status !== 'PENDING') return tx;
  const v = await paystack.verify(reference);
  if (v.status !== 'success' || v.amount !== nairaToKobo(tx.nairaAmount) || v.currency !== 'NGN') return tx;
  const done = await completeCredit(tx._id);
  if (!done.duplicate) await afterPurchase(done.tx);
  return done.tx;
}

r.use(authenticate);
r.get('/wallet', asyncHandler(async (req, res) => {
  const w = (await Wallet.findOne({ userId: req.user._id })) || { availablePoints: 0, reservedPoints: 0 };
  res.json({ availablePoints: w.availablePoints, reservedPoints: w.reservedPoints, nairaPerPoint: await getSetting('nairaPerPoint'), packages: await packagesList(), maxPurchasePoints: await getSetting('maxPurchasePoints') });
}));
r.get('/transactions', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const items = await PointTransaction.find({ userId: req.user._id }).sort('-createdAt').skip((page - 1) * 20).limit(20).select('-meta -__v').lean();
  res.json({ items, page });
}));
r.post('/purchase', asyncHandler(async (req, res) => {
  const maxPts = await getSetting('maxPurchasePoints');
  const { points } = z.object({ points: z.number().int().min(1, 'The minimum is 1 point').max(maxPts, `The maximum is ${maxPts} points per purchase`) }).parse(req.body);
  const pkg = await PointPackage.findOne({ points, active: true }).lean(); const bonus = pkg?.bonusPoints || 0; // optional promotional bonus for matching packages
  const rate = await getSetting('nairaPerPoint');
  const naira = points * rate;
  const reference = `pp_${crypto.randomBytes(10).toString('hex')}`;
  const tx = await createPendingCredit({ userId: req.user._id, type: 'POINT_PURCHASE', amount: points, nairaAmount: naira, idempotencyKey: `purchase:${reference}`, meta: { bonus } });
  if (env.paymentProvider === 'mock') return res.json({ mock: true, reference, points, naira }); // dev only; refused in production
  const init = await paystack.initialize({ email: req.user.email, amountKobo: nairaToKobo(naira), reference, callbackUrl: `${env.frontendUrl}/wallet?ref=${reference}` });
  res.json({ authorizationUrl: init.authorization_url, reference, transactionId: tx.id, points, naira });
}));
// DEV ONLY: simulates the provider confirming a payment. Disabled unless PAYMENT_PROVIDER=mock outside production.
r.post('/purchase/:reference/mock-pay', asyncHandler(async (req, res) => {
  if (env.paymentProvider !== 'mock') throw new ApiError(404, 'Not found');
  const tx = await PointTransaction.findOne({ idempotencyKey: `purchase:${req.params.reference}`, userId: req.user._id });
  if (!tx) throw new ApiError(404, 'Not found');
  const { tx: done, duplicate } = await completeCredit(tx._id);
  if (!duplicate) await afterPurchase(done);
  res.json({ status: done.status });
}));
// Frontend calls this after redirect; it only triggers a SERVER-SIDE verify, never trusts the client.
r.get('/purchase/:reference/status', asyncHandler(async (req, res) => {
  const tx = await settle(req.params.reference);
  if (!tx || String(tx.userId) !== String(req.user._id)) throw new ApiError(404, 'Not found');
  res.json({ status: tx.status });
}));
export default r;
