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
/** Cut a video to [start, end] seconds (the person chose the part they want in the app). Re-encodes to MP4 so the cut is frame-accurate.
 *  Returns the new temp file path (the caller owns and deletes it), or null when no valid trim was asked for. */
export function parseTrim(body = {}) {
  const s = Number(body.trimStart), e = Number(body.trimEnd);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e - s < 0.5 || e > 60 * 60 * 3) return null;
  return { start: s, end: e };
}
export function trimVideo(file, { start, end }) {
  return new Promise((resolve, reject) => {
    const out = `${file}.trim.mp4`;
    const args = ['-v', 'error', '-y', '-ss', String(start), '-i', file, '-t', String(end - start), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out];
    let p; try { p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args); } catch { return reject(new ApiError(503, 'Video editing is unavailable right now')); }
    p.on('error', () => reject(new ApiError(503, 'Video editing is unavailable right now')));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new ApiError(422, 'Could not trim this video. Try another file or post it untrimmed.'))));
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
// `locked: true` marks paid / subscriber-only media (exclusive content). Its link is served as inline-only, never cached, and refuses to open as a page
// or download (see the /:id/stream route). The flag is part of the signature, so nobody can strip it off the link to get a downloadable copy.
export const signUrl = (assetId, userId, ttlSec = 300, locked = false) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', env.mediaSecret).update(`${assetId}.${userId}.${exp}${locked ? '.x' : ''}`).digest('hex');
  return `${env.backendUrl}/api/media/${assetId}/stream?uid=${userId}&exp=${exp}&sig=${sig}${locked ? '&x=1' : ''}`;
};
export function verifySig(assetId, uid, exp, sig, locked = false) {
  if (Number(exp) < Date.now() / 1000) return false;
  const h = crypto.createHmac('sha256', env.mediaSecret).update(`${assetId}.${uid}.${exp}${locked ? '.x' : ''}`).digest('hex');
  const s = String(sig);
  return h.length === s.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s));
}
