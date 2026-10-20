import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { MeetupBooking, Announcement, Notification, VerificationRecord } from '../../models/Extra.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { requirePermission as need } from '../../services/rbac.js';
import { audit } from '../../services/audit.js';
import { paged, rx, isId, dateRange } from '../../services/adminList.js';
import { refundBooking, releaseBooking } from '../meetups.js';
import { isIdentityVerified } from '../../services/verification.js';

const r = Router();
const reason = z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500);
const names = async (q) => (q ? (await User.find({ $or: [{ username: rx(q) }, { email: rx(q) }] }).limit(30).select('_id').lean()).map((u) => u._id) : null);

// ================= meetups & disputes =================
r.get('/meetups', need('meetups.read'), asyncHandler(async (req, res) => {
  const f = {}; if (req.query.status) f.status = String(req.query.status); if (req.query.creator) f.creatorId = { $in: await names(String(req.query.creator)) }; if (req.query.user) f.userId = { $in: await names(String(req.query.user)) }; Object.assign(f, dateRange(req, 'slotAt'));
  res.json(await paged(MeetupBooking, f, req, { sortable: ['createdAt', 'slotAt', 'status'], select: 'userId creatorId slotAt feePoints transportPoints status feeTxId transportTxId createdAt', populate: [['userId', 'username'], ['creatorId', 'username']] }));
}));
r.get('/meetups/:id', need('meetups.read'), asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(400, 'Bad id'); const b = await MeetupBooking.findById(req.params.id).populate('userId creatorId', 'username displayName').populate('history.by', 'username').lean(); if (!b) throw new ApiError(404, 'Not found');
  res.json({ booking: b, creatorVerified: await isIdentityVerified(b.creatorId._id), fundsNote: 'The meetup fee is held by the platform ledger until completion and the dispute window pass. It is not a bank escrow account. The transport fee is a separate payment.' });
}));
r.post('/meetups/:id/resolve', need('meetups.manage'), asyncHandler(async (req, res) => {
  const b = z.object({ outcome: z.enum(['refund', 'release']), reason }).parse(req.body); const m = await MeetupBooking.findOne({ _id: req.params.id, status: 'DISPUTED' }); if (!m) throw new ApiError(409, 'Only disputed bookings can be resolved here');
  if (b.outcome === 'refund') { await MeetupBooking.updateOne({ _id: m._id }, { status: 'REFUNDED', $push: { history: { status: 'REFUNDED', at: new Date(), by: req.admin._id } } }); await refundBooking(m, { includeTransport: true }); }
  else { await MeetupBooking.updateOne({ _id: m._id }, { status: 'COMPLETED', $push: { history: { status: 'COMPLETED', at: new Date(), by: req.admin._id } } }); await releaseBooking(m); }
  await audit(req, `MEETUP_DISPUTE_${b.outcome.toUpperCase()}`, m.id, { reason: b.reason }); res.json({ ok: true });
}));

// ================= announcements (in-app, with a confirm step for the audience size) =================
const audienceFilter = (a) => { const base = { accountStatus: { $ne: 'SUSPENDED' }, emailVerified: true }; return a === 'creators' ? { ...base, accountMode: 'CREATOR' } : a === 'pro' ? { ...base, accountMode: 'CREATOR', creatorPlan: 'PRO' } : base; };
const AUD = z.enum(['all', 'creators', 'pro']);
r.get('/announcements', need('notifications.send'), asyncHandler(async (req, res) => res.json(await paged(Announcement, {}, req, { sortable: ['createdAt'], populate: [['sentBy', 'username']] }))));
r.post('/announcements/preview', need('notifications.send'), asyncHandler(async (req, res) => { const { audience } = z.object({ audience: AUD }).parse(req.body); res.json({ recipients: await User.countDocuments(audienceFilter(audience)) }); }));
r.post('/announcements', need('notifications.send'), asyncHandler(async (req, res) => {
  const b = z.object({ title: z.string().trim().min(3).max(80), message: z.string().trim().min(5).max(400), audience: AUD, confirmRecipients: z.number().int() }).parse(req.body);
  const count = await User.countDocuments(audienceFilter(b.audience)); if (count !== b.confirmRecipients) throw new ApiError(409, `The audience changed (now ${count} people). Review and confirm again.`, 'AUDIENCE_CHANGED');
  const a = await Announcement.create({ title: b.title, message: b.message, audience: b.audience, sentBy: req.admin._id, recipientCount: count });
  let batch = [], sent = 0; const flush = async () => { if (batch.length) { await Notification.insertMany(batch, { ordered: false }); sent += batch.length; batch = []; } };
  for await (const u of User.find(audienceFilter(b.audience)).select('_id').cursor()) { batch.push({ recipientId: u._id, type: 'ANNOUNCEMENT', text: `${b.title}: ${b.message}`, link: '/notifications' }); if (batch.length >= 1000) await flush(); } await flush();
  a.recipientCount = sent; await a.save(); await audit(req, 'ANNOUNCEMENT_SENT', a.id, { meta: { audience: b.audience, recipients: sent } }); res.status(201).json({ ok: true, recipients: sent });
}));
export default r;
