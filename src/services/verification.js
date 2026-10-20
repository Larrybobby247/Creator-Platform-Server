import crypto from 'crypto';
import { VerificationRecord } from '../models/Extra.js';
import { env } from '../config/env.js';
// The ONLY place the app decides whether a creator counts as identity-verified.
export async function isIdentityVerified(userId) {
  const q = { userId, status: 'VERIFIED', provider: 'dojah' };
  q.providerEnv = env.prod ? 'production' : { $in: ['sandbox', 'production', 'seed'] }; // sandbox/seed results never count in production
  return !!(await VerificationRecord.exists(q));
}
// One-way keyed hash used only to stop one BVN being linked to many accounts. The BVN itself is never stored.
export function bvnFingerprint(bvn) {
  const pepper = process.env.BVN_HASH_PEPPER || (env.prod ? '' : env.jwtSecret);
  if (!pepper) return null;
  return crypto.createHmac('sha256', pepper).update(bvn).digest('hex');
}
