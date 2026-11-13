import { Setting } from '../models/Finance.js';
export const DEFAULTS = {
  usdPerPoint: 1,                           // 1 point = US$1 (the price of a point, in dollars)
  usdToNgn: 1500,                           // exchange rate used to charge cards / pay creators' Nigerian bank accounts in naira. Keep it near the market rate (admin: Pricing and fees)
  // nairaPerPoint is no longer stored: it is worked out as usdPerPoint x usdToNgn (see getSetting), so every place that settles money in naira keeps working.
  commissionBps: 2000,                      // 20% platform commission for the Default plan
  proCommissionBps: 1500,                   // 15% for Pro creators
  videoLimitSec: { DEFAULT: 30, PRO: 90 },
  maxUploadBytes: 200 * 1024 * 1024,
  pointPackages: [1, 5, 10, 50],
  promoPrices: { DAY1: 2, DAY3: 5, DAY7: 10 },   // placeholder points; admin-configurable
  referralBps: 200, referralDays: 90, referralHoldDays: 7,
  meetupDisputeHours: 24, meetupRequestExpiryHours: 48,
  minPayoutPoints: 5,
  verificationFeeKobo: 0,
  proPricePoints: 20, proDays: 30,          // placeholder Pro plan price
  previewMaxSec: 15, voiceMaxSec: 120, maxPurchasePoints: 10000,
  // Placeholder limits: set your real ones in the admin dashboard (Pricing & Fees).
  // Prices are chosen freely by every creator (no price caps). Pro raises how many exclusive posts a creator can publish per month.
  planLimits: { exclusivePostsPerMonth: { DEFAULT: 50, PRO: 0 }, // despite the old key name: total exclusive posts on the Default plan (50). Pro is unlimited (this value is ignored for Pro)
     pinnedPosts: { USER: 1, DEFAULT: 1, PRO: 5 }, advancedAnalytics: { DEFAULT: false, PRO: true } },
  maxPriceCapPoints: 100000,                // sanity ceiling only (protects against typos like an extra zero)
  platform: { name: 'Privy', tagline: 'Connect, support and earn.', supportEmail: 'support@example.com', logoUrl: '', currency: 'NGN', timezone: 'Africa/Lagos' },                   // set to provider's real fee
};
export async function getSetting(key) {
  if (key === 'nairaPerPoint') { const [usd, fx] = await Promise.all([getSetting('usdPerPoint'), getSetting('usdToNgn')]); return Math.max(1, Math.round(usd * fx)); } // derived: the naira price of one point
  const row = await Setting.findOne({ key });
  const v = row ? row.value : DEFAULTS[key];
  if (key === 'referralBps' && v === 500) return 200; // the old 5% default is now 2%
  if (key === 'planLimits' && v?.exclusivePostsPerMonth?.DEFAULT === 10) return { ...v, exclusivePostsPerMonth: { ...v.exclusivePostsPerMonth, DEFAULT: 50 } };
  if (key === 'platform' && v && (v.name === 'Creator' || !v.name)) return { ...v, name: 'Privy' }; // the old default name is shown as Privy too
  return v;
}
export const setSetting = (key, value) => Setting.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
