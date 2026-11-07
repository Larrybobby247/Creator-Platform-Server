import { Notification } from '../models/Extra.js';
import { User } from '../models/User.js';
import { emitToUser } from '../realtime.js';
import { sendPush, sendEmail } from './push.js';
const EMAIL_TYPES = new Set(['PAYMENT', 'EARNING', 'MEETUP', 'PAYOUT', 'REQUEST', 'VERIFICATION', 'REFERRAL']);
const PROMO_TYPES = new Set(['PROMOTION', 'REFERRAL']);
// Persist first, then push in real time. Preferences control push/email; in-app history is always kept.
// opts.title  : title of the phone notification (default "Privy"), e.g. the sender's name for a message
// opts.tag    : phone notifications with the same tag replace each other (one per chat instead of a pile)
// opts.collapse: keep ONE unread notification per (type + link): a newer one replaces the older unread one, so ten messages from the same
//               person are one line in the notification tab, not ten. The emitted payload has `replaced: true` so the unread badge is not bumped twice.
export async function notify(recipientId, type, text, link = '', opts = {}) {
  const u = await User.findById(recipientId).select('email prefs');
  let replaced = false;
  if (opts.collapse) replaced = !!(await Notification.findOneAndDelete({ recipientId, type, link, read: false }));
  const n = await Notification.create({ recipientId, type, text, link });
  emitToUser(recipientId, 'notification:new', { ...n.toObject(), replaced });
  const p = u?.prefs || {};
  if (PROMO_TYPES.has(type) && p.promoNotifs === false) return n;
  if (p.push || type === 'MESSAGE') sendPush(recipientId, { title: opts.title || 'Privy', body: text, link, tag: opts.tag, type }).catch(() => {});
  if (p.emailNotifs !== false && EMAIL_TYPES.has(type) && u?.email) sendEmail(u.email, 'Creator notification', `${text}\n\nOpen the app to view details.`).catch(() => {});
  return n;
}
