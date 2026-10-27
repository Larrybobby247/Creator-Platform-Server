import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
const Contact = mongoose.models.ContactMessage || mongoose.model('ContactMessage', new mongoose.Schema({ name: String, email: String, message: String }, { timestamps: true }));
const r = Router();
r.post('/contact', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, message: { error: 'Too many attempts. Please wait a little and try again.', code: 'RATE_LIMITED' } }), asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().min(2).max(80), email: z.string().email(), message: z.string().min(10).max(3000) }).parse(req.body);
  await Contact.create(b); res.status(201).json({ ok: true });
}));
export default r;
