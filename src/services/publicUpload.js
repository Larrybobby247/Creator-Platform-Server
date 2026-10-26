// Public images only (avatars, covers, gift art). Never use this for paid or private media.
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { storePublicImage } from './storage.js';
import { ApiError } from '../utils/ApiError.js';
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const imageUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');
export async function savePublicImage(file) {
  if (!file) throw new ApiError(400, 'No file');
  const ext = EXT[file.mimetype];
  if (!ext) { fs.unlinkSync(file.path); throw new ApiError(415, 'Use a JPG, PNG or WebP image'); }
  return storePublicImage(file.path, ext); // Cloudinary public folder (or local fallback in dev)
}
