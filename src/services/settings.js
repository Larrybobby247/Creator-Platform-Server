import { Setting } from '../models/Finance.js';
export const DEFAULTS = {
  nairaPerPoint: 100,                       // 1 point = ₦100 (in-app currency bought with real money)
  commissionBps: 2000,                      // placeholder 20%
  videoLimitSec: { DEFAULT: 30, PRO: 90 },
  maxUploadBytes: 200 * 1024 * 1024,
  pointPackages: [1, 5, 10, 50],
  promoPrices: { DAY1: 2, DAY3: 5, DAY7: 10 },   // placeholder points; admin-configurable
  referralBps: 500, referralDays: 90, referralHoldDays: 7,
  meetupDisputeHours: 24, meetupRequestExpiryHours: 48,
  minPayoutPoints: 5,
  verificationFeeKobo: 0,
  proPricePoints: 20, proDays: 30,          // placeholder Pro plan price
  previewMaxSec: 15, voiceMaxSec: 120, maxPurchasePoints: 10000,
  // Placeholder limits: set your real ones in the admin dashboard (Pricing & Fees).
  planLimits: { maxUnlockPoints: { DEFAULT: 10, PRO: 100 }, maxSubscriptionPoints: { DEFAULT: 10, PRO: 50 }, pinnedPosts: { USER: 1, DEFAULT: 1, PRO: 5 }, advancedAnalytics: { DEFAULT: false, PRO: true } },
  platform: { name: 'Creator', tagline: 'Connect, support and earn.', supportEmail: 'support@example.com', logoUrl: '', currency: 'NGN', timezone: 'Africa/Lagos' },                   // set to provider's real fee
};
export async function getSetting(key) {
  const row = await Setting.findOne({ key });
  return row ? row.value : DEFAULTS[key];
}
export const setSetting = (key, value) => Setting.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
