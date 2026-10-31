import { getSetting } from './settings.js';
import { DEFAULTS } from './settings.js';
// Single source of truth for what each plan allows. Everything here is admin-configurable; the frontend only displays it.
// Creators set ANY price they like on every plan. Pro gives more exclusive posts per month, a lower commission, longer videos, more pins and analytics.
export const planKey = (u) => (u.accountMode === 'CREATOR' ? (u.creatorPlan === 'PRO' ? 'PRO' : 'DEFAULT') : 'USER');
// Default plan: up to 50 exclusive posts. Pro: unlimited (null).
const exclusiveCap = (pl, k) => (k === 'PRO' ? null : (pl.exclusivePostsPerMonth ?? DEFAULTS.planLimits.exclusivePostsPerMonth).DEFAULT);
export async function limitsFor(u) {
  const [pl, vid, c1, c2] = await Promise.all([getSetting('planLimits'), getSetting('videoLimitSec'), getSetting('commissionBps'), getSetting('proCommissionBps')]); const k = planKey(u); const c = k === 'USER' ? 'DEFAULT' : k;
  return { plan: k, videoSec: vid[c], exclusivePostsPerMonth: exclusiveCap(pl, c), commissionBps: c === 'PRO' ? c2 : c1, pinnedPosts: pl.pinnedPosts[k] ?? pl.pinnedPosts.DEFAULT, advancedAnalytics: !!pl.advancedAnalytics[c] };
}
export async function proBenefits() {
  const [pl, vid, price, days, c1, c2] = await Promise.all([getSetting('planLimits'), getSetting('videoLimitSec'), getSetting('proPricePoints'), getSetting('proDays'), getSetting('commissionBps'), getSetting('proCommissionBps')]);
  const pct = (b) => `${(b / 100).toString().replace(/\.0+$/, '')}%`;
  return { pricePoints: price, days, limits: {
      DEFAULT: { videoSec: vid.DEFAULT, exclusivePostsPerMonth: exclusiveCap(pl, 'DEFAULT'), commissionBps: c1, pinnedPosts: pl.pinnedPosts.DEFAULT, advancedAnalytics: pl.advancedAnalytics.DEFAULT },
      PRO: { videoSec: vid.PRO, exclusivePostsPerMonth: exclusiveCap(pl, 'PRO'), commissionBps: c2, pinnedPosts: pl.pinnedPosts.PRO, advancedAnalytics: pl.advancedAnalytics.PRO } },
    benefits: [
      `Post unlimited exclusive content (instead of up to ${exclusiveCap(pl, 'DEFAULT')})`,
      `Lower platform commission: ${pct(c2)} instead of ${pct(c1)} on everything you earn`,
      `Upload videos up to ${vid.PRO}s (instead of ${vid.DEFAULT}s)`, `Pin up to ${pl.pinnedPosts.PRO} posts on your profile (instead of ${pl.pinnedPosts.DEFAULT})`,
      'Advanced analytics: top supporters and most active supporters', 'Advanced analytics: most popular content', 'Advanced analytics: exclusive content ranked by revenue', 'Advanced analytics: revenue by source and follower growth', 'PRO badge on your profile and posts'],
    note: 'Every creator, on every plan, sets their own prices for every service.' };
}
