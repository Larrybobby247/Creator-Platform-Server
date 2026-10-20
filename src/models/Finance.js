import mongoose from 'mongoose';
const { Schema } = mongoose;

export const Wallet = mongoose.model('Wallet', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  availablePoints: { type: Number, default: 0, min: 0 },
  reservedPoints: { type: Number, default: 0, min: 0 },
}, { timestamps: true }));

export const TX_TYPES = ['POINT_PURCHASE','PROMOTIONAL_BONUS','CREATOR_SUBSCRIPTION','EXCLUSIVE_CONTENT_UNLOCK','PAID_MESSAGE','CREATOR_GIFT','COMMUNITY_ACCESS','SPECIAL_REQUEST','MEETUP_RESERVATION','MEETUP_REFUND','REFERRAL_REWARD','PROMOTION_PURCHASE','ADMIN_ADJUSTMENT','PRO_PLAN','REVERSAL'];

const tx = new Schema({
  reference: { type: String, unique: true, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: TX_TYPES, required: true },
  direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['PENDING','COMPLETED','FAILED','REVERSED'], default: 'PENDING' },
  idempotencyKey: { type: String, unique: true, sparse: true },
  creatorId: { type: Schema.Types.ObjectId, ref: 'User' },
  relatedId: { type: Schema.Types.ObjectId },
  nairaPerPointAtTime: Number,
  nairaAmount: Number,
  reversalOf: { type: Schema.Types.ObjectId, ref: 'PointTransaction' },
  completedAt: Date,
  meta: Schema.Types.Mixed,
}, { timestamps: true });
tx.pre('validate', function () { if (!Number.isInteger(this.amount)) throw new Error('amount must be integer'); });
export const PointTransaction = mongoose.model('PointTransaction', tx);

export const CreatorEarning = mongoose.model('CreatorEarning', new Schema({
  creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceTransactionId: { type: Schema.Types.ObjectId, ref: 'PointTransaction', unique: true, required: true },
  gross: Number, commission: Number, net: Number,
  status: { type: String, enum: ['PENDING','AVAILABLE','RESERVED','REVERSED','PAID_OUT'], default: 'AVAILABLE' },
  releasedAt: Date,
}, { timestamps: true }));

export const Setting = mongoose.model('Setting', new Schema({ key: { type: String, unique: true }, value: Schema.Types.Mixed }));
export const AuditLog = mongoose.model('AuditLog', new Schema({
  actorId: Schema.Types.ObjectId, action: String, target: String, reason: String, before: Schema.Types.Mixed, after: Schema.Types.Mixed, ip: String, meta: Schema.Types.Mixed,
}, { timestamps: true }));
