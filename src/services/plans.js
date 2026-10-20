import { getSetting } from './settings.js';
// Single source of truth for what each plan allows. Everything here is admin-configurable; the frontend only displays it.
export const planKey = (u) => (u.accountMode === 'CREATOR' ? (u.creatorPlan === 'PRO' ? 'PRO' : 'DEFAULT') : 'USER');
export async function limitsFor(u) {
  const [pl, vid] = await Promise.all([getSetting('planLimits'), getSetting('videoLimitSec')]); const k = planKey(u); const c = k === 'USER' ? 'DEFAULT' : k;
  return { plan: k, videoSec: vid[c], maxUnlockPoints: pl.maxUnlockPoints[c], maxSubscriptionPoints: pl.maxSubscriptionPoints[c], pinnedPosts: pl.pinnedPosts[k] ?? pl.pinnedPosts.DEFAULT, advancedAnalytics: !!pl.advancedAnalytics[c] };
}
export async function proBenefits() {
  const [pl, vid, price, days] = await Promise.all([getSetting('planLimits'), getSetting('videoLimitSec'), getSetting('proPricePoints'), getSetting('proDays')]);
  return { pricePoints: price, days, limits: { DEFAULT: { videoSec: vid.DEFAULT, maxUnlockPoints: pl.maxUnlockPoints.DEFAULT, maxSubscriptionPoints: pl.maxSubscriptionPoints.DEFAULT, pinnedPosts: pl.pinnedPosts.DEFAULT, advancedAnalytics: pl.advancedAnalytics.DEFAULT },
    PRO: { videoSec: vid.PRO, maxUnlockPoints: pl.maxUnlockPoints.PRO, maxSubscriptionPoints: pl.maxSubscriptionPoints.PRO, pinnedPosts: pl.pinnedPosts.PRO, advancedAnalytics: pl.advancedAnalytics.PRO } },
    benefits: [
      `Upload videos up to ${vid.PRO}s (instead of ${vid.DEFAULT}s)`, `Price exclusive content up to ${pl.maxUnlockPoints.PRO} points each (instead of ${pl.maxUnlockPoints.DEFAULT})`,
      `Set subscription prices up to ${pl.maxSubscriptionPoints.PRO} points (instead of ${pl.maxSubscriptionPoints.DEFAULT})`, `Pin up to ${pl.pinnedPosts.PRO} posts on your profile (instead of ${pl.pinnedPosts.DEFAULT})`,
      'Advanced analytics: top supporters and most active supporters', 'Advanced analytics: most popular content', 'Advanced analytics: exclusive content ranked by revenue', 'Advanced analytics: revenue by source and follower growth', 'PRO badge on your profile and posts'] };
}
