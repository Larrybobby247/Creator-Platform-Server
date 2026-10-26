// Idempotent periodic workers. For multi-instance production use a queue (BullMQ) or a single scheduler.
import { Promotion, Subscription, MeetupBooking, ReferralReward } from '../models/Extra.js';
import { PointTransaction } from '../models/Finance.js';
import { credit_ } from './helpers.js';
import { transition, refundBooking, releaseBooking } from '../routes/meetups.js';
import { notify } from '../services/notify.js';
import { User } from '../models/User.js';

export const jobStatus = {}; // read by the admin System Health page
const safe = (name, fn) => async () => { const s = (jobStatus[name] ||= { runs: 0 }); try { await fn(); s.lastOkAt = new Date(); s.lastError = null; } catch (e) { s.lastError = String(e.message).slice(0, 200); s.lastErrorAt = new Date(); console.error(`job ${name} failed:`, e.message); } finally { s.runs++; s.lastRunAt = new Date(); } };

const expirePromotions = async () => {
  const due = await Promotion.find({ status: 'ACTIVE', expiresAt: { $lte: new Date() } });
  for (const p of due) if (await Promotion.findOneAndUpdate({ _id: p._id, status: 'ACTIVE' }, { status: 'COMPLETED' })) await notify(p.ownerId, 'PROMOTION', 'Your promotion has ended', '/studio');
};
const expireSubscriptions = async () => {
  const due = await Subscription.find({ status: 'ACTIVE', expiresAt: { $lte: new Date() } });
  for (const s of due) if (await Subscription.findOneAndUpdate({ _id: s._id, status: 'ACTIVE' }, { status: 'EXPIRED' })) await notify(s.subscriberId, 'SUBSCRIPTION', 'A subscription expired', '/subscriptions');
};
const expireMeetups = async () => {
  const due = await MeetupBooking.find({ status: { $in: ['PAID_AND_RESERVED', 'CREATOR_ACCEPTED', 'MEETUP_PENDING_USER_ACCEPTANCE'] }, expiresAt: { $lte: new Date() } });
  for (const b of due) { const o = await transition(b._id, ['PAID_AND_RESERVED', 'CREATOR_ACCEPTED', 'MEETUP_PENDING_USER_ACCEPTANCE'], 'EXPIRED', {}, null); if (o) { await refundBooking(b, { includeTransport: true }); await notify(b.userId, 'MEETUP', 'An Innercircle request expired and was refunded', '/meetups'); } }
};
const expirePro = async () => {
  const due = await User.find({ creatorPlan: 'PRO', proExpiresAt: { $lte: new Date() } });
  for (const u of due) if (await User.findOneAndUpdate({ _id: u._id, creatorPlan: 'PRO', proExpiresAt: { $lte: new Date() } }, { creatorPlan: 'DEFAULT', $unset: { proExpiresAt: 1 } })) await notify(u._id, 'PLAN', 'Your Pro plan has ended', '/studio');
};
const releaseMeetups = async () => { // only after completion + dispute window, never on creator acceptance alone
  const due = await MeetupBooking.find({ status: 'COMPLETED', releaseAfter: { $lte: new Date() } });
  for (const b of due) await releaseBooking(b);
};
const approveReferrals = async () => {
  const due = await ReferralReward.find({ status: 'PENDING', approveAfter: { $lte: new Date() } });
  for (const rw of due) {
    const src = await PointTransaction.findById(rw.sourceTransactionId);
    const claimed = await ReferralReward.findOneAndUpdate({ _id: rw._id, status: 'PENDING' }, { status: src?.status === 'COMPLETED' ? 'APPROVED' : 'REJECTED' }, { new: true });
    if (claimed?.status === 'APPROVED') { await credit_(claimed); await notify(claimed.referrerId, 'REFERRAL', `Referral reward: +${claimed.amount} pts`, '/referrals'); }
  }
};

export function startJobs() {
  const every = (ms, name, fn) => setInterval(safe(name, fn), ms).unref();
  every(60e3, 'promotions', expirePromotions); every(5 * 60e3, 'pro-plan', expirePro); every(60e3, 'subscriptions', expireSubscriptions);
  every(60e3, 'meetup-expiry', expireMeetups); every(60e3, 'meetup-release', releaseMeetups); every(5 * 60e3, 'referrals', approveReferrals);
}
