// All amounts are integers. Commission uses basis points (1% = 100 bps) with integer math only.
export function splitCommission(grossPoints, commissionBps) {
  if (!Number.isInteger(grossPoints) || grossPoints < 0) throw new Error('gross must be a non-negative integer');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) throw new Error('bad commission bps');
  const commission = Math.floor((grossPoints * commissionBps) / 10000);
  return { gross: grossPoints, commission, net: grossPoints - commission };
}
export const pointsToNaira = (points, nairaPerPoint) => points * nairaPerPoint;
export const nairaToKobo = (naira) => naira * 100;
