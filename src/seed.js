// Dev-only demo data. `npm run seed` adds it, `npm run seed:clear` removes ALL of it (users flagged demo:true and everything they own).
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from './config/env.js';
import { User } from './models/User.js';
import { Wallet, PointTransaction, CreatorEarning } from './models/Finance.js';
import { Post, Gift, GiftTransaction, Conversation, Message, ConversationNote } from './models/Social.js';
import * as X from './models/Extra.js';
import { CreatorEarning as _CE } from './models/Finance.js';

if (env.prod) { console.error('Refusing to touch demo data in production.'); process.exit(1); }
await mongoose.connect(env.db);

if (process.argv.includes('--clear')) {
  const ids = (await User.find({ demo: true }).select('_id')).map((u) => u._id);
  const by = (f) => ({ [f]: { $in: ids } });
  const convs = await Conversation.find({ participants: { $in: ids } }).select('_id');
  await Promise.all([
    Message.deleteMany({ conversationId: { $in: convs.map((c) => c._id) } }), Conversation.deleteMany({ _id: { $in: convs.map((c) => c._id) } }),
    Wallet.deleteMany(by('userId')), PointTransaction.deleteMany(by('userId')), CreatorEarning.deleteMany(by('creatorId')), Post.deleteMany(by('authorId')),
    GiftTransaction.deleteMany({ $or: [by('senderId'), by('recipientId')] }), ConversationNote.deleteMany(by('authorId')),
    X.Notification.deleteMany(by('recipientId')), X.Follow.deleteMany({ $or: [by('followerId'), by('followeeId')] }), X.Like.deleteMany(by('userId')), X.Comment.deleteMany(by('userId')),
    X.Subscription.deleteMany({ $or: [by('subscriberId'), by('creatorId')] }), X.Community.deleteMany(by('ownerId')), X.CommunityMember.deleteMany(by('userId')),
    X.SpecialRequest.deleteMany({ $or: [by('userId'), by('creatorId')] }), X.Rating.deleteMany(by('creatorId')), X.ReferralReward.deleteMany(by('referrerId')),
    X.Promotion.deleteMany(by('ownerId')), X.MeetupBooking.deleteMany({ $or: [by('userId'), by('creatorId')] }), X.VerificationRecord.deleteMany(by('userId')),
    X.Payout.deleteMany(by('creatorId')), X.Report.deleteMany(by('reporterId')), X.Story.deleteMany(by('authorId')), X.StoryView.deleteMany(by('userId')), X.CommentLike.deleteMany(by('userId')), X.PostView.deleteMany(by('userId')), X.ConversationLabel.deleteMany(by('ownerId')), X.Block.deleteMany({ $or: [by('blockerId'), by('blockedId')] }),
  ]);
  await User.deleteMany({ demo: true });
  console.log(`Cleared demo data (${ids.length} demo users and their records).`); process.exit(0);
}

if (await User.exists({ demo: true })) { console.log('Demo data already present. Run `npm run seed:clear` first.'); process.exit(0); }

const gifts = [['Heart', 1], ['Rose', 2], ['Star', 5], ['Diamond', 10], ['Crown', 25], ['Trophy', 50], ['Premium Gift', 100]];
if (!(await Gift.countDocuments())) await Gift.insertMany(gifts.map(([name, pricePoints], order) => ({ name, pricePoints, order, description: `${name} gift`, active: true })));
const catalogue = await Gift.find().sort('order');

const hash = await bcrypt.hash('demo12345', 10);
const mk = (username, extra = {}) => User.create({ username, email: `${username}@demo.test`, passwordHash: hash, displayName: username[0].toUpperCase() + username.slice(1), demo: true, referralCode: `demo${username}`, termsAcceptedAt: new Date(), termsVersion: 'seed', emailVerified: true, ...extra });
const admin = await mk('admin', { role: 'ADMIN', adminRole: 'SUPER_ADMIN' }); await mk('finance', { role: 'ADMIN', adminRole: 'FINANCE' }); await mk('mod', { role: 'ADMIN', adminRole: 'MODERATOR' });
const cats = ['Music', 'Comedy', 'Fashion', 'Fitness', 'Food', 'Tech', 'Art', 'Travel'];
const creators = [];
for (const [i, n] of ['ada', 'tunde', 'chioma', 'emeka', 'bisi', 'kola', 'ngozi', 'seyi'].entries()) {
  creators.push(await mk(n, { creatorSince: new Date(Date.now() - (i + 1) * 5 * 864e5), gender: i % 2 ? 'MALE' : 'FEMALE', age: 22 + i, accountMode: 'CREATOR', category: cats[i], bio: `${cats[i]} creator from Nigeria. Welcome to my page!`, location: ['Lagos', 'Ibadan', 'Abuja', 'Enugu'][i % 4], creatorPlan: i % 3 === 0 ? 'PRO' : 'DEFAULT', subscriptionPricePoints: i % 2 === 0 ? 3 : 0,
    meetup: i < 2 ? { enabled: true, pricePoints: 20, transportPoints: 3, durationMin: 60, area: 'Lagos Island', noticeHours: 24, cancelRule: 'Free cancellation until the creator accepts.' } : {} }));
}
const users = [];
for (const n of ['demo', 'jide', 'amaka', 'musa', 'folake', 'tobi']) users.push(await mk(n, { referredBy: n === 'jide' ? creators[0]._id : undefined }));
const all = [...creators, ...users, admin];
await Wallet.insertMany(all.map((u) => ({ userId: u._id, availablePoints: u.role === 'ADMIN' ? 0 : 200 })));
for (const u of all) await PointTransaction.create({ reference: `SEED_${u.id}`, userId: u._id, type: 'POINT_PURCHASE', direction: 'CREDIT', amount: 200, status: 'COMPLETED', completedAt: new Date(), nairaPerPointAtTime: 100, nairaAmount: 20000, idempotencyKey: `seed:${u.id}` });
await Wallet.updateOne({ userId: users[0]._id }, { availablePoints: 200 });

const pick = (a, i) => a[i % a.length];
await X.Follow.insertMany(users.flatMap((u, i) => creators.slice(0, 3 + (i % 4)).map((c) => ({ followerId: u._id, followeeId: c._id }))));
await X.Follow.insertMany(creators.flatMap((c, i) => [{ followerId: c._id, followeeId: pick(creators, i + 1)._id }]));

const posts = [];
const texts = ['New week, new energy ✨ what are we creating today? #motivation #creators', 'Behind the scenes from yesterday’s shoot 🎬 #bts #lagos', 'Quick tip: consistency beats perfection every time. #creators #tips', 'Throwback to my favourite Lagos sunset 🌅 #lagos #sunset', 'Poll: morning or night sessions? Tell me below! #poll', 'Just hit a new milestone — thank you all 💜 #milestone #afrobeats'];
for (const [i, c] of creators.entries()) {
  for (let k = 0; k < 4; k++) posts.push(await Post.create({ authorId: c._id, content: pick(texts, i + k), status: 'PUBLISHED', access: 'PUBLIC', demo: true, createdAt: new Date(Date.now() - (i * 4 + k) * 36e5 * 3) }));
  posts.push(await Post.create({ authorId: c._id, content: 'Exclusive: full behind-the-scenes breakdown', exclusiveText: `🔓 Unlocked! Here is ${c.displayName}'s full exclusive breakdown, only for supporters.`, access: 'EXCLUSIVE', unlockPricePoints: 2 + (i % 4), status: 'PUBLISHED', demo: true }));
  if (c.subscriptionPricePoints) posts.push(await Post.create({ authorId: c._id, content: 'Subscribers only: monthly Q&A recap', exclusiveText: 'Subscriber-only content', access: 'SUBSCRIBERS', status: 'PUBLISHED', demo: true }));
}
for (const [i, p] of posts.entries()) { for (const u of users.slice(0, 1 + (i % 5))) await X.Like.create({ postId: p._id, userId: u._id }).catch(() => {}); if (i % 3 === 0) await X.Comment.create({ postId: p._id, userId: pick(users, i)._id, text: pick(['Love this! 🔥', 'Amazing work', 'Can’t wait for more', 'Great one 👏'], i) }); }

// communities
const comms = await X.Community.insertMany([
  { ownerId: creators[0]._id, name: 'Lagos Creators Hub', description: 'Share tips, collabs and wins.', memberCount: 128 },
  { ownerId: creators[1]._id, name: 'Afrobeats Lounge', description: 'Music lovers unite.', memberCount: 342 },
  { ownerId: creators[3]._id, name: 'Fit Naija (VIP)', description: 'Paid fitness coaching circle.', accessFeePoints: 5, memberCount: 57 },
]);
await X.CommunityMember.create({ communityId: comms[0]._id, userId: users[0]._id });

// chats: one normal, one request, one unread
const chat = async (a, b, lines, extra = {}) => {
  const c = await Conversation.create({ participants: [a._id, b._id], requestedBy: a._id, accepted: true, ...extra });
  for (const [i, [from, text]] of lines.entries()) await Message.create({ conversationId: c._id, senderId: from._id, text, createdAt: new Date(Date.now() - (lines.length - i) * 6e4 * 7) });
  const last = lines.at(-1); c.lastMessageAt = new Date(); c.lastMessageText = last[1]; if (extra.unreadFor) c.unread.set(String(extra.unreadFor), 2); await c.save(); return c;
};
const demo = users[0], ada = creators[0];
const c1 = await chat(demo, ada, [[demo, 'Hi Ada! Love your content.'], [ada, 'Thank you so much! 💜'], [demo, 'Do you do custom requests?'], [ada, 'Yes! Send me the details.']], { unreadFor: demo._id });
await chat(users[1], demo, [[users[1], 'Hey, saw your profile — can we chat?']], { accepted: false, unreadFor: demo._id });
await chat(demo, creators[1], [[demo, 'Hello Tunde'], [creators[1], 'Hey! Check my paid community 🎶']], { paid: true });
await Message.create({ conversationId: c1._id, senderId: ada._id, type: 'OFFER', text: 'Sneak peek of my next project 👀', paidText: 'Here is the full behind-the-scenes plan (demo paid message).', price: 3 });
c1.paid = true; await c1.save();
await ConversationNote.create({ conversationId: c1._id, authorId: demo._id, text: 'Wants a custom shoutout video. Deliver by Friday.' });

// ledger-backed gifts + earnings (so dashboards have real numbers)
let n = 0;
for (const [i, c] of creators.entries()) for (let k = 0; k < 3 + (i % 3); k++) {
  const g = pick(catalogue, i + k), sender = pick(users, i + k), gross = g.pricePoints, commission = Math.floor((gross * 2000) / 10000);
  const tx = await PointTransaction.create({ reference: `SEEDG_${n++}`, userId: sender._id, type: 'CREATOR_GIFT', direction: 'DEBIT', amount: gross, status: 'COMPLETED', completedAt: new Date(), creatorId: c._id, idempotencyKey: `seedgift:${n}`, createdAt: new Date(Date.now() - ((i + k) % 7) * 864e5) });
  await GiftTransaction.create({ senderId: sender._id, recipientId: c._id, giftId: g._id, quantity: 1, grossPoints: gross, commissionPoints: commission, netPoints: gross - commission, transactionId: tx._id, createdAt: tx.createdAt });
  await CreatorEarning.create({ creatorId: c._id, sourceTransactionId: tx._id, gross, commission, net: gross - commission, status: 'AVAILABLE', createdAt: tx.createdAt });
}

// ratings via completed requests
for (const [i, c] of creators.slice(0, 4).entries()) for (const [j, u] of users.slice(0, 3).entries()) {
  const sr = await X.SpecialRequest.create({ userId: u._id, creatorId: c._id, description: 'Custom shoutout (demo)', offerPoints: 3, status: 'COMPLETED' });
  await X.Rating.create({ creatorId: c._id, reviewerId: u._id, qualifyingId: sr._id, qualifyingKind: 'REQUEST', stars: 3 + ((i + j) % 3), text: pick(['Fast and friendly!', 'Delivered exactly what I asked.', 'Great experience, would book again.'], i + j) });
}
await X.SpecialRequest.create({ userId: demo._id, creatorId: ada._id, description: 'Birthday shoutout for my sister', offerPoints: 4, status: 'PENDING' });

// verification, promotions, payouts, notifications, referrals
for (const c of creators.slice(0, 2)) await X.VerificationRecord.create({ userId: c._id, provider: 'dojah', providerEnv: 'seed', status: 'VERIFIED' });
await X.Promotion.create({ ownerId: creators[2]._id, targetType: 'PROFILE', targetId: creators[2]._id, duration: 'DAY7', pricePoints: 10, startsAt: new Date(), expiresAt: new Date(Date.now() + 7 * 864e5), impressions: 842, clicks: 61 });
await X.Promotion.create({ ownerId: creators[0]._id, targetType: 'POST', targetId: posts[0]._id, duration: 'DAY3', pricePoints: 5, startsAt: new Date(), expiresAt: new Date(Date.now() + 3 * 864e5), impressions: 391, clicks: 24 });
await X.Payout.create({ creatorId: ada._id, amountPoints: 5, nairaAmount: 500, bankName: 'GTBank', accountLast4: '1234', accountName: 'Ada Demo', status: 'PAID', reference: 'PO_SEED_1' });
await X.ReferralReward.create({ referrerId: ada._id, referredId: users[1]._id, sourceTransactionId: new mongoose.Types.ObjectId(), netBasis: 40, bps: 500, amount: 2, status: 'PENDING', approveAfter: new Date(Date.now() + 3 * 864e5) });
await X.Subscription.create({ subscriberId: demo._id, creatorId: ada._id, status: 'ACTIVE', expiresAt: new Date(Date.now() + 20 * 864e5), pricePoints: 3 });
await X.Notification.insertMany([
  { recipientId: demo._id, type: 'FOLLOW', text: 'tunde started following you', link: '/u/tunde' }, { recipientId: demo._id, type: 'PAYMENT', text: '200 points added to your wallet', link: '/wallet' },
  { recipientId: ada._id, type: 'GIFT', text: 'jide sent you 1× Rose', link: '/studio' }, { recipientId: ada._id, type: 'REQUEST', text: 'New special request from demo (4 pts)', link: '/requests' },
]);
await X.Report.create({ reporterId: users[2]._id, targetType: 'POST', targetId: posts[3]._id, category: 'SPAM', priority: 'LOW', reason: 'Spam (demo report)', history: [{ status: 'NEW', at: new Date() }] });
await X.Report.create({ reporterId: users[3]._id, targetType: 'USER', targetId: users[1]._id, category: 'HARASSMENT', priority: 'HIGH', reason: 'Sent abusive messages (demo)', history: [{ status: 'NEW', at: new Date() }] });

// statuses, packages, a pinned post, post views
for (const c of creators.slice(0, 3)) await X.Story.create({ authorId: c._id, type: 'TEXT', text: `Good morning from ${c.displayName}! ☀️ #goodvibes`, bg: ['violet', 'pink', 'blue'][creators.indexOf(c) % 3], expiresAt: new Date(Date.now() + 20 * 36e5) });
await X.Story.create({ authorId: users[1]._id, type: 'TEXT', text: 'Weekend plans? 🎉', bg: 'green', expiresAt: new Date(Date.now() + 18 * 36e5) });
if (!(await X.PointPackage.countDocuments())) await X.PointPackage.insertMany([{ name: 'Starter', points: 1, order: 1 }, { name: 'Popular', points: 5, bonusPoints: 0, order: 2 }, { name: 'Value', points: 10, bonusPoints: 1, order: 3 }, { name: 'Power', points: 50, bonusPoints: 10, order: 4 }]);
await Post.updateOne({ authorId: ada._id, access: 'PUBLIC' }, { pinnedAt: new Date() });
for (const p of posts.slice(0, 12)) await Post.updateOne({ _id: p._id }, { viewCount: 20 + Math.floor(Math.random() * 300) });
console.log('Seeded. Logins (password demo12345): demo@demo.test (user) · ada@demo.test (PRO creator, meetups on) · admin@demo.test (Super Admin) · finance@demo.test (Finance) · mod@demo.test (Moderator) — admin dashboard logins');
process.exit(0);
