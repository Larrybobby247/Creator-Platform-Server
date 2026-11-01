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
    const p = await Payout.findOneAndUpdate({ reference: new RegExp(`^${String(evt.data.reference).replace(/[^a-z0-9_-]/gi, '')}$`, 'i'), status: { $in: ['PROCESSING', 'PENDING'] } }, { status: st, failReason: evt.data.reason }, { new: true });
    if (p) await notify(p.creatorId, 'PAYOUT', `Your withdrawal is ${st.toLowerCase()}`, '/studio'); // failed/reversed payouts return to available earnings automatically
  }
  await WebhookLog.create({ provider: 'paystack', event: evt.event, reference: evt.data?.reference, ok: true });
  } catch (e) { await WebhookLog.create({ provider: 'paystack', event: evt.event, reference: evt.data?.reference, ok: false, error: String(e.message).slice(0, 200) }); throw e; }
  res.sendStatus(200);
}));

// Paystack only accepts letters, numbers, "-", "." and "=" in a transaction reference (no underscores). Older purchases were created with "pp_...";
// if Paystack stored or returned those with the "_" removed, these helpers still match them up.
const clean = (ref = '') => String(ref).replace(/[^A-Za-z0-9.=-]/g, '');
async function findPurchase(reference) {
  const exact = await PointTransaction.findOne({ idempotencyKey: `purchase:${reference}`, type: 'POINT_PURCHASE' });
  if (exact) return exact;
  const recent = await PointTransaction.find({ type: 'POINT_PURCHASE', status: 'PENDING', createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } }).limit(200);
  return recent.find((t) => clean(String(t.idempotencyKey).replace(/^purchase:/, '')) === clean(reference)) || null;
}
async function verifyAny(refs) { // tries each spelling until Paystack knows the payment
  let last;
  for (const ref of [...new Set(refs.filter(Boolean))]) { try { return { v: await paystack.verify(ref), ref }; } catch (e) { last = e; if (e.providerStatus && e.providerStatus !== 404) break; } }
  throw last;
}
// Asks Paystack (server to server) what happened to this payment and credits the points exactly once. Safe to call any number of times.
// Called from: the webhook, the page the user returns to after paying, the "Check status" button, and a background job that catches missed webhooks.
// Returns { tx, reason } where reason explains (in plain words) why a payment is still pending.
export async function settleDetailed(reference) {
  const tx = await findPurchase(reference);
  if (!tx || tx.status !== 'PENDING') return { tx, reason: null };
  const mine = String(tx.idempotencyKey).replace(/^purchase:/, '');
  let v; try { ({ v } = await verifyAny([mine, reference, clean(mine)])); } catch (e) {
    console.error('[points] could not verify', mine, e.providerStatus || '', e.providerMessage || e.message);
    return { tx, reason: e.providerStatus === 404 ? 'NOT_FOUND' : e.providerStatus === 401 ? 'BAD_KEY' : 'VERIFY_ERROR', detail: e.providerMessage || e.message };
  }
  if (v.status === 'success') {
    const expected = Math.round(nairaToKobo(tx.nairaAmount));
    if (Number(v.amount) !== expected || v.currency !== 'NGN') { console.error('[points] paid amount does not match', mine, { paid: v.amount, expected, currency: v.currency }); return { tx, reason: 'AMOUNT_MISMATCH', detail: `paid ${v.amount} ${v.currency}, expected ${expected} NGN (kobo)` }; }
    const done = await completeCredit(tx._id);
    if (!done.duplicate) await afterPurchase(done.tx);
    return { tx: done.tx, reason: null };
  }
  if (v.status === 'failed' || (v.status === 'abandoned' && Date.now() - new Date(tx.createdAt).getTime() > 24 * 3600e3)) { tx.status = 'FAILED'; await tx.save(); return { tx, reason: null }; } // never leave it "pending" forever
  return { tx, reason: 'NOT_PAID', detail: v.gateway_response || v.status };
}
export const settle = async (reference) => (await settleDetailed(reference)).tx;

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
  const reference = `pp${crypto.randomBytes(10).toString('hex')}`; // letters and numbers only: the only characters Paystack accepts in a transaction reference (besides - . =)
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
  const { tx, reason, detail } = await settleDetailed(req.params.reference);
  if (!tx || String(tx.userId) !== String(req.user._id)) throw new ApiError(404, 'Not found');
  res.json({ status: tx.status, reason, detail: reason ? detail : undefined });
}));
export default r;
