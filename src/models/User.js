import mongoose from 'mongoose';
const s = new mongoose.Schema({
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  email: { type: String, unique: true, required: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  displayName: String, bio: String, avatarUrl: String, coverUrl: String,
  role: { type: String, enum: ['USER', 'ADMIN'], default: 'USER' },
  accountMode: { type: String, enum: ['USER', 'CREATOR'], default: 'USER' },
  accountStatus: { type: String, enum: ['ACTIVE', 'RESTRICTED', 'SUSPENDED'], default: 'ACTIVE' }, statusReason: String, statusAt: Date, statusBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  creatorPlan: { type: String, enum: ['DEFAULT', 'PRO'], default: 'DEFAULT' },
  subscriptionPricePoints: { type: Number, default: 0 },
  meetupEnabled: { type: Boolean, default: false },
  termsAcceptedAt: Date, termsVersion: String, googleId: { type: String, sparse: true, unique: true },
  demo: { type: Boolean, default: false }, category: String, location: String,
  meetup: { enabled: { type: Boolean, default: false }, pricePoints: { type: Number, default: 0 }, transportPoints: { type: Number, default: 0 }, durationMin: { type: Number, default: 60 }, area: String, noticeHours: { type: Number, default: 24 }, cancelRule: String },
  prefs: { messages: { type: String, enum: ['EVERYONE','REQUESTS'], default: 'EVERYONE' }, showOnline: { type: Boolean, default: true }, emailNotifs: { type: Boolean, default: true }, push: { type: Boolean, default: false }, promoNotifs: { type: Boolean, default: true } },
  emailVerified: { type: Boolean, default: false }, emailVerifyHash: String, emailVerifyExpires: Date, emailVerifySentAt: Date,
  resetHash: String, resetExpires: Date, gender: { type: String, enum: ['MALE', 'FEMALE', 'OTHER'] }, age: { type: Number, min: 18, max: 120 }, usernameChangedAt: Date, creatorSince: Date, lastActiveAt: Date,
  dmPolicy: { mode: { type: String, enum: ['OPEN', 'PAID', 'SUBSCRIBERS'], default: 'OPEN' }, pricePoints: { type: Number, default: 0 } },
  requestSettings: { enabled: { type: Boolean, default: true }, minPricePoints: { type: Number, default: 1 }, instructions: String, turnaroundDays: { type: Number, default: 7 } },
  adminRole: { type: String, enum: ['SUPER_ADMIN', 'FINANCE', 'MODERATOR', 'SUPPORT', 'VERIFICATION'] }, adminPermissions: [String],
  adminNotes: [{ text: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: Date }],
  proExpiresAt: Date, profileViews: { type: Number, default: 0 },
  // Creator application (private: legal name / date of birth / phone are for verification only and are never returned by public endpoints)
  creatorApplication: { type: new mongoose.Schema({ legalName: String, dob: Date, phone: String, country: { type: String, default: 'Nigeria' }, contentCategory: String, guidelinesAcceptedAt: Date, guidelinesVersion: String, submittedAt: Date }, { _id: false }), select: false },
  // Which paid features the creator switched on. Each can be turned on later; none is forced. { key: { enabled, pricePoints? } }
  services: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Verified payout bank account. The full number goes only to the payment provider; we keep the last 4 digits and the provider's recipient code.
  payoutAccount: { bankName: String, bankCode: String, accountLast4: String, accountName: String, recipientCode: String, verifiedAt: Date },
  showGiftSenders: { type: Boolean, default: false },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
export const User = mongoose.model('User', s);
