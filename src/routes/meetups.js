import { Router } from 'express';
import { z } from 'zod';
import { MeetupBooking } from '../models/Extra.js';
import { PointTransaction } from '../models/Finance.js';
import { User } from '../models/User.js';
import { isIdentityVerified } from '../services/verification.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { spend, reverse } from '../services/pointLedger.js';
import { recordEarning } from '../services/earnings.js';
import { getSetting } from '../services/settings.js';
import { notify } from '../services/notify.js';

const r = Router();
r.use(authenticate);

/** Every status change goes through here: atomic, validates the current state, records history. */
export async function transition(id, from, to, extra = {}, by) {
  return MeetupBooking.findOneAndUpdate({ _id: id, status: { $in: from } }, { status: to, ...extra, $push: { history: { status: to, at: new Date(), by } } }, { new: true });
}
export async function refundBooking(b, { includeTransport }) {
  if (b.feeTxId) await reverse(b.feeTxId, 'meetup refund').catch(() => {});
  if (includeTransport && b.transportTxId) await reverse(b.transportTxId, 'Innercircle invitation fee refund').catch(() => {});
}
export async function releaseBooking(b) {
  const done = await transition(b._id, ['COMPLETED'], 'EARNINGS_RELEASED', {}, null);
  if (!done) return null;
  const tx = await PointTransaction.findById(b.feeTxId);
  await recordEarning({ creatorId: b.creatorId, sourceTx: tx, gross: b.feePoints, label: 'meetup' });
  return done;
}

r.post('/', asyncHandler(async (req, res) => {
  const b = z.object({ creatorId: z.string(), slotAt: z.coerce.date(), idempotencyKey: z.string().min(8) }).parse(req.body);
  const c = await User.findOne({ _id: b.creatorId, accountMode: 'CREATOR' });
  if (!c || c.id === req.user.id || !c.meetup?.enabled) throw new ApiError(400, 'Innercircle is not available for this creator');
  if (!(await isIdentityVerified(c._id))) throw new ApiError(403, 'Creator is not verified'); // re-checked at booking time
  if (b.slotAt.getTime() < Date.now() + c.meetup.noticeHours * 36e5) throw new ApiError(400, `Needs at least ${c.meetup.noticeHours}h notice`);
  const booking = await MeetupBooking.create({ userId: req.user._id, creatorId: c._id, slotAt: b.slotAt, durationMin: c.meetup.durationMin, area: c.meetup.area, feePoints: c.meetup.pricePoints, transportPoints: c.meetup.transportPoints, history: [{ status: 'REQUESTED', at: new Date(), by: req.user._id }] });
  try {
    const fee = await spend({ userId: req.user._id, type: 'MEETUP_RESERVATION', amount: booking.feePoints, idempotencyKey: `meet:${booking.id}:fee`, creatorId: c._id, relatedId: booking._id, meta: { kind: 'MEETUP_FEE' } });
    booking.feeTxId = fee.tx._id;
    if (booking.transportPoints > 0) { const t = await spend({ userId: req.user._id, type: 'MEETUP_RESERVATION', amount: booking.transportPoints, idempotencyKey: `meet:${booking.id}:transport`, relatedId: booking._id, meta: { kind: 'TRANSPORT_FEE' } }); booking.transportTxId = t.tx._id; }
    booking.expiresAt = new Date(Date.now() + (await getSetting('meetupRequestExpiryHours')) * 36e5);
    await booking.save();
  } catch (e) { await refundBooking(booking, { includeTransport: true }); await booking.deleteOne(); throw e; }
  const out = await transition(booking._id, ['REQUESTED'], 'PAID_AND_RESERVED', {}, req.user._id);
  await notify(c._id, 'MEETUP', `New Innercircle request from ${req.user.username}`, '/studio');
  res.status(201).json(out);
}));

r.get('/me', asyncHandler(async (req, res) => {
  const as = req.query.as === 'creator' ? 'creatorId' : 'userId';
  res.json({ items: await MeetupBooking.find({ [as]: req.user._id }).sort('-createdAt').limit(50).populate('userId creatorId', 'username displayName') });
}));

const OTHER = (b, me) => String(b.userId) === String(me) ? b.creatorId : b.userId;
r.post('/:id/:action', asyncHandler(async (req, res) => {
  const { id, action } = req.params; const me = req.user._id; let out;
  const mine = (field) => ({ _id: id, [field]: me });
  const bk = await MeetupBooking.findOne({ _id: id, $or: [{ userId: me }, { creatorId: me }] });
  if (!bk) throw new ApiError(404, 'Not found');
  const isCreator = String(bk.creatorId) === String(me);
  const need = (cond) => { if (!cond) throw new ApiError(403, 'Not allowed for your role'); };
  switch (action) {
    case 'accept': need(isCreator); out = await transition(id, ['PAID_AND_RESERVED'], 'CREATOR_ACCEPTED', { creatorAcceptedAt: new Date() }, me); break;
    case 'confirm': need(isCreator); out = await transition(id, ['CREATOR_ACCEPTED'], 'MEETUP_PENDING_USER_ACCEPTANCE', {}, me); break;
    case 'reject': need(isCreator); out = await transition(id, ['PAID_AND_RESERVED', 'CREATOR_ACCEPTED'], 'REJECTED', {}, me); if (out) await refundBooking(bk, { includeTransport: true }); break;
    case 'user-accept': need(!isCreator); out = await transition(id, ['MEETUP_PENDING_USER_ACCEPTANCE'], 'USER_ACCEPTED', { userAcceptedAt: new Date() }, me); break;
    case 'cancel': need(!isCreator); out = await transition(id, ['PAID_AND_RESERVED', 'CREATOR_ACCEPTED', 'MEETUP_PENDING_USER_ACCEPTANCE'], 'CANCELLED', {}, me); if (out) await refundBooking(bk, { includeTransport: false }); break; // transport kept per cancellation rule (confirm policy)
    case 'complete': need(isCreator); if (bk.slotAt > new Date()) throw new ApiError(400, 'The booking time has not passed yet');
      out = await transition(id, ['USER_ACCEPTED'], 'COMPLETED', { completedAt: new Date(), releaseAfter: new Date(Date.now() + (await getSetting('meetupDisputeHours')) * 36e5) }, me); break;
    case 'dispute': need(!isCreator); out = await transition(id, ['USER_ACCEPTED', 'COMPLETED'], 'DISPUTED', {}, me); break;
    default: throw new ApiError(404, 'Unknown action');
  }
  if (!out) throw new ApiError(409, `Cannot ${action} from status ${bk.status}`);
  await notify(OTHER(bk, me), 'MEETUP', `Innercircle booking is now ${out.status.replaceAll('_', ' ').toLowerCase()}`, '/meetups');
  res.json(out);
}));
export default r;
