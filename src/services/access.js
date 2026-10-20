import { PointTransaction } from '../models/Finance.js';
import { Subscription } from '../models/Extra.js';
export async function hasAccess(user, post) {
  if (post.access === 'PUBLIC' || String(post.authorId) === String(user._id)) return true;
  if (post.access === 'EXCLUSIVE') return !!(await PointTransaction.exists({ userId: user._id, type: 'EXCLUSIVE_CONTENT_UNLOCK', relatedId: post._id, status: 'COMPLETED' }));
  if (post.access === 'SUBSCRIBERS') return !!(await Subscription.exists({ subscriberId: user._id, creatorId: post.authorId, status: 'ACTIVE', expiresAt: { $gt: new Date() } }));
  return false;
}
