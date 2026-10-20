import mongoose from 'mongoose';
const { Schema } = mongoose;
const oid = (ref) => ({ type: Schema.Types.ObjectId, ref });

export const MediaAsset = mongoose.model('MediaAsset', new Schema({
  ownerId: { ...oid('User'), required: true }, storageKey: String, mediaType: { type: String, enum: ['IMAGE','VIDEO','AUDIO'] },
  mimeType: String, size: Number, durationSec: Number,
}, { timestamps: true }));

const postSchema = new Schema({
  authorId: { ...oid('User'), required: true, index: true }, content: String,
  mediaId: oid('MediaAsset'), previewMediaId: oid('MediaAsset'), coverUrl: String,
  access: { type: String, enum: ['PUBLIC','EXCLUSIVE','SUBSCRIBERS'], default: 'PUBLIC' },
  unlockPricePoints: { type: Number, default: 0 }, exclusiveText: String, communityId: { type: Schema.Types.ObjectId, ref: 'Community' }, demo: Boolean,
  status: { type: String, enum: ['DRAFT','PUBLISHED','DELETED'], default: 'DRAFT' }, mediaTypeHint: String,
  tags: [String], pinnedAt: Date, viewCount: { type: Number, default: 0 },
  moderation: { status: { type: String, enum: ['OK','UNDER_REVIEW','RESTRICTED','REMOVED'], default: 'OK' }, reason: String, by: oid('User'), at: Date },
}, { timestamps: true });
// #hashtags in the caption become searchable topics
postSchema.pre('validate', function () {
  if (this.isModified('content')) this.tags = [...new Set(((this.content || '').match(/#[\p{L}\p{N}_]{2,30}/gu) || []).map((t) => t.slice(1).toLowerCase()))].slice(0, 10);
});
export const Post = mongoose.model('Post', postSchema);

export const Gift = mongoose.model('Gift', new Schema({
  name: { type: String, required: true }, description: String, imageUrl: String,
  pricePoints: { type: Number, required: true, min: 1 }, active: { type: Boolean, default: true }, order: { type: Number, default: 0 },
}));
export const GiftTransaction = mongoose.model('GiftTransaction', new Schema({
  senderId: oid('User'), recipientId: oid('User'), giftId: oid('Gift'), quantity: Number,
  grossPoints: Number, commissionPoints: Number, netPoints: Number, transactionId: oid('PointTransaction'),
  status: { type: String, default: 'COMPLETED' },
}, { timestamps: true }));

export const Conversation = mongoose.model('Conversation', new Schema({
  participants: [{ ...oid('User'), index: true }], lastMessageAt: Date, lastMessageText: String,
  unread: { type: Map, of: Number, default: {} },
  accepted: { type: Boolean, default: true }, requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  archivedBy: [oid('User')], paid: { type: Boolean, default: false }, dmPaid: [oid('User')], labels: [{ userId: oid('User'), labelId: oid('ConversationLabel') }],
}, { timestamps: true }));
export const Message = mongoose.model('Message', new Schema({
  conversationId: { ...oid('Conversation'), index: true }, senderId: oid('User'),
  type: { type: String, enum: ['TEXT','IMAGE','VIDEO','VOICE','OFFER'], default: 'TEXT' }, text: String, mediaId: oid('MediaAsset'), replyTo: oid('Message'),
  reactions: [{ userId: oid('User'), emoji: String }], price: { type: Number, default: 0 }, paidText: String, unlockedBy: [oid('User')], mediaType: String,
}, { timestamps: true }));

export const ConversationNote = mongoose.model('ConversationNote', new Schema({
  conversationId: { ...oid('Conversation'), index: true }, authorId: { ...oid('User'), index: true }, text: { type: String, maxlength: 4000 },
}, { timestamps: true }));
