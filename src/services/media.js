import { spawn } from 'child_process';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { getSetting } from './settings.js';

/** Real duration from file metadata (ffprobe), never from the client. */
export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(env.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let out = ''; p.stdout.on('data', (d) => (out += d));
    p.on('error', () => reject(new ApiError(503, 'Media processor unavailable')));
    p.on('close', (c) => { const n = parseFloat(out); if (c === 0 && Number.isFinite(n)) return resolve(n); probeByPackets(file).then(resolve, () => reject(new ApiError(422, 'Unreadable media file'))); });
  });
}
// Browser recordings (webm) often lack a container duration; derive it from packet timestamps instead.
function probeByPackets(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(env.ffprobe, ['-v', 'error', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]);
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('error', reject);
    p.on('close', () => { const t = out.split('\n').map(parseFloat).filter(Number.isFinite); t.length ? resolve(Math.max(...t)) : reject(new Error('no packets')); });
  });
}
/** A tiny (about 32px wide) JPEG of an image, or of a frame of a video, returned as a data URL. Used to show a very blurry teaser of paid chat media:
 *  the real picture is never sent to someone who has not paid, only this thumbnail, which is too small to recognise even without the blur. Returns null if ffmpeg is missing. */
export function makeBlurPreview(file, isVideo, durationSec = 0) {
  return new Promise((resolve) => {
    const at = isVideo ? Math.max(0, Math.min(1, (durationSec || 0) / 2)) : 0;
    const args = ['-v', 'error', ...(isVideo ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=32:-2', '-q:v', '10', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
    let p; try { p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args); } catch { return resolve(null); }
    const chunks = []; p.stdout.on('data', (d) => chunks.push(d)); p.on('error', () => resolve(null));
    p.on('close', (c) => { const b = Buffer.concat(chunks); resolve(c === 0 && b.length > 100 && b.length < 20000 ? `data:image/jpeg;base64,${b.toString('base64')}` : null); });
  });
}
export async function assertVideoAllowed(file, plan, maxOverride) {
  const limits = await getSetting('videoLimitSec');
  const max = Math.min(maxOverride ?? Infinity, limits[plan] ?? limits.DEFAULT);
  const dur = await probeDuration(file);
  if (dur > max + 0.25) throw new ApiError(422, `Video is ${Math.round(dur)}s. Your plan allows up to ${max}s.`, 'VIDEO_TOO_LONG');
  return dur;
}
export { storePrivate } from './storage.js'; // Cloudinary (authenticated) in production, local private folder as dev fallback
export const signUrl = (assetId, userId, ttlSec = 300) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', env.mediaSecret).update(`${assetId}.${userId}.${exp}`).digest('hex');
  return `${env.backendUrl}/api/media/${assetId}/stream?uid=${userId}&exp=${exp}&sig=${sig}`;
};
export function verifySig(assetId, uid, exp, sig) {
  if (Number(exp) < Date.now() / 1000) return false;
  const h = crypto.createHmac('sha256', env.mediaSecret).update(`${assetId}.${uid}.${exp}`).digest('hex');
  const s = String(sig);
  return h.length === s.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s));
}
