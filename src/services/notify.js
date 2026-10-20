import { Notification } from '../models/Extra.js';
import { User } from '../models/User.js';
import { emitToUser } from '../realtime.js';
import { sendPush, sendEmail } from './push.js';
const EMAIL_TYPES = new Set(['PAYMENT', 'EARNING', 'MEETUP', 'PAYOUT', 'REQUEST', 'VERIFICATION', 'REFERRAL']);
const PROMO_TYPES = new Set(['PROMOTION', 'REFERRAL']);
// Persist first, then push in real time. Preferences control push/email; in-app history is always kept.
export async function notify(recipientId, type, text, link = '') {
  const u = await User.findById(recipientId).select('email prefs');
  const n = await Notification.create({ recipientId, type, text, link });
  emitToUser(recipientId, 'notification:new', n);
  const p = u?.prefs || {};
  if (PROMO_TYPES.has(type) && p.promoNotifs === false) return n;
  if (p.push) sendPush(recipientId, { title: 'Creator', body: text, link }).catch(() => {});
  if (p.emailNotifs !== false && EMAIL_TYPES.has(type) && u?.email) sendEmail(u.email, 'Creator notification', `${text}\n\nOpen the app to view details.`).catch(() => {});
  return n;
}
