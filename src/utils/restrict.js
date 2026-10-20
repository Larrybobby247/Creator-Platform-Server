import { ApiError } from './ApiError.js';
// Restricted accounts can browse and log in but cannot post, comment, message or spend until an admin restores them.
export const assertCanInteract = (u) => { if (u.accountStatus === 'RESTRICTED') throw new ApiError(403, 'Your account is restricted. Contact support.', 'ACCOUNT_RESTRICTED'); };
