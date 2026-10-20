import { CreatorEarning } from '../models/Finance.js';
import { ReferralReward } from '../models/Extra.js';
import { User } from '../models/User.js';
import { getSetting } from './settings.js';
import { splitCommission } from '../utils/money.js';
import { notify } from './notify.js';

/** The single place creator earnings are created (gifts, unlocks, subscriptions, requests, meetups, communities). */
export async function recordEarning({ creatorId, sourceTx, gross, status = 'AVAILABLE', label = 'sale' }) {
  const { commission, net } = splitCommission(gross, await getSetting('commissionBps'));
  const e = await CreatorEarning.create({ creatorId, sourceTransactionId: sourceTx._id, gross, commission, net, status, releasedAt: status === 'AVAILABLE' ? new Date() : undefined });
  if (status === 'AVAILABLE') await notify(creatorId, 'EARNING', `New ${label}: +${net} pts earned`, '/studio');
  await maybeReferral(creatorId, sourceTx._id, net);
  return e;
}

async function maybeReferral(creatorId, sourceTxId, net) {
  const creator = await User.findById(creatorId).select('referredBy createdAt');
  if (!creator?.referredBy || String(creator.referredBy) === String(creatorId)) return;
  const [bps, days, hold] = await Promise.all([getSetting('referralBps'), getSetting('referralDays'), getSetting('referralHoldDays')]);
  if (Date.now() - creator.createdAt > days * 864e5) return;
  const amount = Math.floor((net * bps) / 10000);
  if (amount < 1) return;
  await ReferralReward.create({ referrerId: creator.referredBy, referredId: creatorId, sourceTransactionId: sourceTxId, netBasis: net, bps, amount, approveAfter: new Date(Date.now() + hold * 864e5) }).catch((e) => { if (e.code !== 11000) throw e; });
}
