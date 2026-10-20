import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { effectivePermissions } from '../services/rbac.js';
export const ADMIN_COOKIE = 'admin_token';
export const adminSecret = () => `${env.jwtSecret}:admin`; // different key from the public app, so a public session can never be an admin session
export const signAdmin = (u) => jwt.sign({ sub: u.id, aud: 'admin' }, adminSecret(), { expiresIn: '8h' });
const allowedOrigins = () => [env.adminUrl].filter(Boolean);

export async function adminAuthenticate(req, _res, next) {
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { const o = req.headers.origin; if (o && !allowedOrigins().includes(o)) throw new ApiError(403, 'Origin not allowed', 'BAD_ORIGIN'); } // CSRF defence on top of SameSite=Strict
    const token = req.cookies?.[ADMIN_COOKIE]; if (!token) throw new ApiError(401, 'Please sign in', 'UNAUTHENTICATED');
    const { sub } = jwt.verify(token, adminSecret(), { audience: 'admin' });
    const u = await User.findById(sub);
    if (!u || u.role !== 'ADMIN' || !u.adminRole || u.accountStatus !== 'ACTIVE') throw new ApiError(401, 'Session no longer valid', 'UNAUTHENTICATED');
    req.admin = u; req.perms = effectivePermissions(u); next();
  } catch (e) { next(e.status ? e : new ApiError(401, 'Session expired. Please sign in again.', 'UNAUTHENTICATED')); }
}
