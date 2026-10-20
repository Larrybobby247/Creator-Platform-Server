// Prints how MongoDB executes the hot queries (docs examined vs returned). Run against a realistically sized DB:  npm run explain
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import '../src/models/indexes.js';
import { Post, Conversation, Message } from '../src/models/Social.js';
import { Notification } from '../src/models/Extra.js';
import { PointTransaction } from '../src/models/Finance.js';
await mongoose.connect(env.db);
const some = async (M, f = {}) => (await M.findOne(f).select('_id').lean())?._id;
const user = await some(PointTransaction); const conv = await some(Conversation);
const cases = [
  ['main feed', () => Post.find({ status: 'PUBLISHED', communityId: { $exists: false } }).sort({ createdAt: -1, _id: -1 }).limit(21)],
  ['inbox', () => Conversation.find({ participants: user }).sort('-lastMessageAt').limit(50)],
  ['chat history', () => Message.find({ conversationId: conv }).sort('-createdAt').limit(41)],
  ['notifications', () => Notification.find({ recipientId: user }).sort('-createdAt').limit(30)],
  ['wallet history', () => PointTransaction.find({ userId: user }).sort('-createdAt').limit(20)],
];
for (const [name, q] of cases) { const e = await q().explain('executionStats').catch((x) => ({ error: x.message })); const s = e.executionStats;
  console.log(name.padEnd(16), s ? `returned=${s.nReturned} examined=${s.totalDocsExamined} keys=${s.totalKeysExamined} ms=${s.executionTimeMillis} ${s.totalDocsExamined > Math.max(50, s.nReturned * 5) ? '  <-- SCAN, check indexes' : 'ok'}` : e.error); }
await mongoose.disconnect();
