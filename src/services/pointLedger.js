import crypto from 'crypto';
import { Wallet, PointTransaction } from '../models/Finance.js';
import { ApiError } from '../utils/ApiError.js';
import { getSetting } from './settings.js';

const ref = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

async function insertTx(doc) {
  try { return { tx: await PointTransaction.create(doc), duplicate: false }; }
  catch (e) {
    if (e.code === 11000 && doc.idempotencyKey) {
      return { tx: await PointTransaction.findOne({ idempotencyKey: doc.idempotencyKey }), duplicate: true };
    }
    throw e;
  }
}

/** Atomically debit points. Idempotent on idempotencyKey. Never allows a negative balance. */
export async function spend({ userId, type, amount, idempotencyKey, creatorId, relatedId, meta }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new ApiError(400, 'Invalid amount');
  if (!idempotencyKey) throw new ApiError(400, 'idempotencyKey required');
  const doc = { reference: ref('TX'), userId, type, direction: 'DEBIT', amount, idempotencyKey, creatorId, relatedId, meta, nairaPerPointAtTime: await getSetting('nairaPerPoint') };
  let { tx, duplicate } = await insertTx(doc);
  // An earlier attempt that failed for lack of points must not block a retry after the user tops up.
  if (duplicate && tx?.status === 'FAILED') { await PointTransaction.deleteOne({ _id: tx._id, status: 'FAILED' }); ({ tx, duplicate } = await insertTx({ ...doc, reference: ref('TX') })); }
  if (duplicate) return { tx, duplicate };
  const w = await Wallet.findOneAndUpdate({ userId, availablePoints: { $gte: amount } }, { $inc: { availablePoints: -amount } }, { new: true });
  if (!w) { tx.status = 'FAILED'; await tx.save(); throw new ApiError(402, 'Insufficient points', 'INSUFFICIENT_POINTS'); }
  tx.status = 'COMPLETED'; tx.completedAt = new Date(); await tx.save();
  return { tx, duplicate: false, wallet: w };
}

/** Create a PENDING credit (e.g. point purchase awaiting Paystack verification). */
export async function createPendingCredit({ userId, type, amount, idempotencyKey, nairaAmount, meta }) {
  const { tx } = await insertTx({
    reference: ref('PUR'), userId, type, direction: 'CREDIT', amount, idempotencyKey, nairaAmount, meta,
    nairaPerPointAtTime: await getSetting('nairaPerPoint'),
  });
  return tx;
}

/** Complete a pending credit exactly once (atomic PENDING -> COMPLETED claim, then wallet credit). */
export async function completeCredit(txId) {
  const claimed = await PointTransaction.findOneAndUpdate({ _id: txId, status: 'PENDING', direction: 'CREDIT' }, { status: 'COMPLETED', completedAt: new Date() }, { new: true });
  if (!claimed) return { tx: await PointTransaction.findById(txId), duplicate: true };
  await Wallet.updateOne({ userId: claimed.userId }, { $inc: { availablePoints: claimed.amount } }, { upsert: true });
  return { tx: claimed, duplicate: false };
}

/** Refund/correction: new reversal record; original flagged REVERSED, never edited silently. */
export async function reverse(originalId, reason) {
  const orig = await PointTransaction.findOneAndUpdate({ _id: originalId, status: 'COMPLETED' }, { status: 'REVERSED' }, { new: true });
  if (!orig) throw new ApiError(409, 'Transaction not reversible');
  if (orig.direction === 'DEBIT') await Wallet.updateOne({ userId: orig.userId }, { $inc: { availablePoints: orig.amount } });
  return PointTransaction.create({
    reference: ref('RV'), userId: orig.userId, type: 'REVERSAL', direction: orig.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
    amount: orig.amount, status: 'COMPLETED', completedAt: new Date(), reversalOf: orig._id, idempotencyKey: `rev:${orig._id}`, meta: { reason },
  });
}
