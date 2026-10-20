import { ApiError } from '../utils/ApiError.js';
export const requireCreator = (req, _res, next) =>
  req.user.accountMode === 'CREATOR' ? next() : next(new ApiError(403, 'Creator account required'));
export const requireAdmin = (req, _res, next) =>
  req.user.role === 'ADMIN' ? next() : next(new ApiError(403, 'Admin only'));
