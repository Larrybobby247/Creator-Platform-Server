import { createPendingCredit, completeCredit } from '../services/pointLedger.js';
// Referral rewards are paid as in-app points, once per reward (idempotency key = reward id).
export async function credit_(reward) {
  const tx = await createPendingCredit({ userId: reward.referrerId, type: 'REFERRAL_REWARD', amount: reward.amount, idempotencyKey: `refreward:${reward._id}` });
  await completeCredit(tx._id);
}
