import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { User } from '../models/User.js';

export async function authenticate(req, _res, next) {
  try {
    const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) throw new ApiError(401, 'Authentication required');
    const { sub } = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(sub);
    if (!user || user.accountStatus === 'SUSPENDED') throw new ApiError(401, 'Account unavailable');
    if (!user.lastActiveAt || Date.now() - user.lastActiveAt > 10 * 60e3) User.updateOne({ _id: user._id }, { lastActiveAt: new Date() }).catch(() => {});
    if (!user.emailVerified) throw new ApiError(403, 'Please verify your email address first', 'EMAIL_NOT_VERIFIED');
    req.user = user;
    next();
  } catch (e) { next(e.status ? e : new ApiError(401, 'Invalid session')); }
}
