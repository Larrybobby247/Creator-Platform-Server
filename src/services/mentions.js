// @username mentions: find them in text, resolve to real, active accounts and notify them (never the author, never blocked users).
import { User } from '../models/User.js';
import { Block } from '../models/Extra.js';
import { notify } from './notify.js';

export const parseMentions = (text = '') => [...new Set(((String(text).match(/(?:^|[^\w])@([a-z0-9_]{3,24})/gi) || []).map((m) => m.trim().replace(/^[^@]*@/, '').toLowerCase())))].slice(0, 10);

/** Returns the ids of mentioned users that exist. */
export async function resolveMentions(text, authorId) {
  const names = parseMentions(text); if (!names.length) return [];
  const users = await User.find({ username: { $in: names }, accountStatus: { $ne: 'SUSPENDED' }, _id: { $ne: authorId } }).select('_id').lean();
  if (!users.length) return [];
  const blocks = await Block.find({ blockerId: { $in: users.map((u) => u._id) }, blockedId: authorId }).select('blockerId').lean();
  const blocked = new Set(blocks.map((b) => String(b.blockerId)));
  return users.map((u) => u._id).filter((id) => !blocked.has(String(id)));
}
export async function notifyMentions(ids, author, where, link) {
  await Promise.all(ids.map((id) => notify(id, 'MENTION', `${author.username} mentioned you ${where}`, link).catch(() => {})));
}
