// Optional integrations: if keys/packages are absent these quietly do nothing.
import { env } from '../config/env.js';
import { PushSub } from '../models/Extra.js';
let wp, mailer;
async function webpush() { if (wp !== undefined) return wp; try { wp = (await import('web-push')).default; wp.setVapidDetails(env.vapidSubject, env.vapidPublic, env.vapidPrivate); } catch { wp = null; } return wp; }
export async function sendPush(userId, payload) {
  if (!env.vapidPublic || !env.vapidPrivate) return;
  const w = await webpush(); if (!w) return;
  for (const s of await PushSub.find({ userId })) {
    try { await w.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await s.deleteOne(); }
  }
}
export const testOutbox = []; // only filled when NODE_ENV=test
export async function sendEmail(to, subject, text) {
  if (process.env.NODE_ENV === 'test') { testOutbox.push({ to, subject, text }); return; }
  if (!env.smtpUrl) return;
  try { if (!mailer) mailer = (await import('nodemailer')).default.createTransport(env.smtpUrl); await mailer.sendMail({ from: env.mailFrom, to, subject, text }); } catch (e) { console.error('email failed:', e.message); }
}
