// Private media storage.
//  - Production: Cloudinary, uploaded as type "authenticated". Such assets have NO public URL: Cloudinary refuses any request
//    that is not signed with our API secret. Only this server can read them, and it only does so after checking the viewer's access
//    (see GET /api/media/:id/stream, which is reached through short-lived, per-user signed links).
//  - Development without Cloudinary keys: the old local folder (MEDIA_DIR) is used so the app still runs.
// storageKey formats:  "cld/<image|video>/<public_id>"  (Cloudinary)   |   "<random>.<ext>"  (local file)
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

let cld;
async function sdk() {
  if (cld) return cld;
  const mod = await import('cloudinary'); const v2 = mod.v2 || mod.default?.v2;
  v2.config({ cloud_name: env.cloudinary.cloudName, api_key: env.cloudinary.apiKey, api_secret: env.cloudinary.apiSecret, secure: true });
  return (cld = v2);
}
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
// Audio and video both live under Cloudinary's "video" resource type.
const resourceTypeFor = (ext) => (IMAGE_EXT.has(ext) ? 'image' : 'video');
export const isCloudKey = (k = '') => k.startsWith('cld/');

/** Stores a temp upload privately and returns the storageKey. The temp file is always removed. */
export async function storePrivate(tmpPath, ext) {
  try {
    if (env.cloudinaryEnabled) {
      const c = await sdk(); const rt = resourceTypeFor(ext);
      const opts = { resource_type: rt, type: 'authenticated', folder: `${env.cloudinary.folder}/private`, unique_filename: true, use_filename: false, overwrite: false };
      const res = await new Promise((resolve, reject) => {
        const cb = (err, out) => (err ? reject(err) : resolve(out));
        if (rt === 'video') c.uploader.upload_large(tmpPath, { ...opts, chunk_size: 6_000_000 }, cb); else c.uploader.upload(tmpPath, opts, cb);
      }).catch((e) => { console.error('cloudinary upload failed:', e?.message || e); throw new ApiError(502, 'Could not store the file. Please try again.', 'STORAGE_FAILED'); });
      return `cld/${rt}/${res.public_id}`;
    }
    fs.mkdirSync(env.mediaDir, { recursive: true });
    const key = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    fs.copyFileSync(tmpPath, path.join(env.mediaDir, key));
    return key;
  } finally { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }
}

/** Public images (avatars, covers, gift art, logo). Cloudinary "upload" type, or the local public folder as fallback. Returns a URL. */
export async function storePublicImage(tmpPath, ext) {
  try {
    if (env.cloudinaryEnabled) {
      const c = await sdk();
      const res = await c.uploader.upload(tmpPath, { resource_type: 'image', type: 'upload', folder: `${env.cloudinary.folder}/public`, unique_filename: true, overwrite: false }).catch((e) => { console.error('cloudinary upload failed:', e?.message || e); throw new ApiError(502, 'Could not store the image. Please try again.', 'STORAGE_FAILED'); });
      return res.secure_url;
    }
    fs.mkdirSync(env.publicDir, { recursive: true });
    const name = `${crypto.randomBytes(12).toString('hex')}${ext}`;
    fs.copyFileSync(tmpPath, path.join(env.publicDir, name));
    return `/uploads/${name}`;
  } finally { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }
}

/** Streams a stored asset to an Express response, honouring Range (needed for video seeking). */
export async function sendStored(req, res, asset) {
  const key = asset.storageKey || '';
  if (!isCloudKey(key)) return res.type(asset.mimeType).sendFile(path.resolve(env.mediaDir, key)); // sendFile handles Range
  if (!env.cloudinaryEnabled) throw new ApiError(503, 'Media storage is not configured');
  const c = await sdk(); const [, rt, ...rest] = key.split('/'); const publicId = rest.join('/');
  const url = c.url(publicId, { resource_type: rt, type: 'authenticated', sign_url: true, secure: true });
  const up = await fetch(url, { headers: req.headers.range ? { Range: req.headers.range } : {} });
  if (!up.ok && up.status !== 206) throw new ApiError(404, 'Media not found');
  res.status(up.status); res.setHeader('Content-Type', asset.mimeType || up.headers.get('content-type') || 'application/octet-stream');
  for (const h of ['content-length', 'content-range', 'accept-ranges']) { const v = up.headers.get(h); if (v) res.setHeader(h, v); }
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body); req.on('close', () => stream.destroy()); stream.on('error', () => res.end()); stream.pipe(res);
}

export async function deleteStored(key) {
  try {
    if (isCloudKey(key) && env.cloudinaryEnabled) { const c = await sdk(); const [, rt, ...rest] = key.split('/'); await c.uploader.destroy(rest.join('/'), { resource_type: rt, type: 'authenticated', invalidate: true }); }
    else if (key && !isCloudKey(key)) fs.rmSync(path.join(env.mediaDir, key), { force: true });
  } catch (e) { console.error('delete media failed:', e?.message); }
}
