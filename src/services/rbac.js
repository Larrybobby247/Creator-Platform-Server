import { ApiError } from '../utils/ApiError.js';
export const PERMISSIONS = ['dashboard.read', 'users.read', 'users.restrict', 'creators.read', 'creators.manage', 'verification.read', 'verification.review', 'content.read', 'content.moderate', 'reports.read', 'reports.manage', 'communities.read', 'communities.moderate', 'ratings.read', 'ratings.moderate',
  'transactions.read', 'refunds.manage', 'packages.manage', 'payouts.read', 'payouts.review', 'subscriptions.read', 'referrals.read', 'referrals.manage', 'promotions.read', 'promotions.manage', 'meetups.read', 'meetups.manage', 'gifts.manage', 'notifications.send', 'settings.read', 'settings.manage', 'admins.manage', 'audit_logs.read', 'health.read'];
export const ROLE_PERMISSIONS = {
  SUPER_ADMIN: PERMISSIONS,
  FINANCE: ['dashboard.read', 'users.read', 'transactions.read', 'refunds.manage', 'packages.manage', 'payouts.read', 'payouts.review', 'subscriptions.read', 'referrals.read', 'promotions.read', 'meetups.read'],
  MODERATOR: ['dashboard.read', 'users.read', 'users.restrict', 'creators.read', 'content.read', 'content.moderate', 'reports.read', 'reports.manage', 'communities.read', 'communities.moderate', 'ratings.read', 'ratings.moderate', 'promotions.read'],
  SUPPORT: ['dashboard.read', 'users.read', 'creators.read', 'transactions.read', 'subscriptions.read', 'meetups.read', 'reports.read', 'payouts.read'],
  VERIFICATION: ['dashboard.read', 'verification.read', 'verification.review', 'users.read', 'creators.read'],
};
export const effectivePermissions = (u) => new Set([...(ROLE_PERMISSIONS[u.adminRole] || []), ...(u.adminPermissions || []).filter((p) => PERMISSIONS.includes(p))]);
// Enforced on the server for every admin endpoint; the UI merely mirrors it.
export const requirePermission = (...perms) => (req, _res, next) => (perms.some((p) => req.perms?.has(p)) ? next() : next(new ApiError(403, 'You do not have permission to do this.', 'FORBIDDEN')));
