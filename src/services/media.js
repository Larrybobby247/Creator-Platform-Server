import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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
export async function assertVideoAllowed(file, plan, maxOverride) {
  const limits = await getSetting('videoLimitSec');
  const max = Math.min(maxOverride ?? Infinity, limits[plan] ?? limits.DEFAULT);
  const dur = await probeDuration(file);
  if (dur > max + 0.25) throw new ApiError(422, `Video is ${Math.round(dur)}s. Your plan allows up to ${max}s.`, 'VIDEO_TOO_LONG');
  return dur;
}
export function storePrivate(tmpPath, ext) {
  fs.mkdirSync(env.mediaDir, { recursive: true });
  const key = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.copyFileSync(tmpPath, path.join(env.mediaDir, key)); fs.unlinkSync(tmpPath);
  return key;
}
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
