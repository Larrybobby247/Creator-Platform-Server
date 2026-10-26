// Optional integrations: if keys/packages are absent these quietly do nothing.
import { env } from '../config/env.js';
import { PushSub } from '../models/Extra.js';
let wp;
async function webpush() { if (wp !== undefined) return wp; try { wp = (await import('web-push')).default; wp.setVapidDetails(env.vapidSubject, env.vapidPublic, env.vapidPrivate); } catch { wp = null; } return wp; }
export async function sendPush(userId, payload) {
  if (!env.vapidPublic || !env.vapidPrivate) return;
  const w = await webpush(); if (!w) return;
  for (const s of await PushSub.find({ userId })) {
    try { await w.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await s.deleteOne(); }
  }
}
// Email moved to Resend (services/email.js). Re-exported so existing imports keep working.
export { sendEmail, testOutbox } from './email.js';
