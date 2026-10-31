// Thin Paystack wrapper (/transaction/initialize, /transaction/verify/:reference).
// Confirm Paystack approves your business model before going live.
import crypto from 'crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const call = async (path, opts = {}) => {
  if (!env.paystackSecret) throw new ApiError(503, 'Payment provider not configured');
  const r = await fetch(`https://api.paystack.co${path}`, { ...opts, headers: { Authorization: `Bearer ${env.paystackSecret}`, 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) { console.error('[paystack]', path.split('?')[0], r.status, j.message || ''); throw new ApiError(502, 'Payment provider error'); } // the reason shows in your server logs
  return j.data;
};
export const initialize = ({ email, amountKobo, reference, callbackUrl }) =>
  call('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: amountKobo, reference, callback_url: callbackUrl }) });
export const verify = (reference) => call(`/transaction/verify/${encodeURIComponent(reference)}`);
export function validSignature(rawBody, signature) {
  if (!signature || !env.paystackSecret) return false;
  const h = crypto.createHmac('sha512', env.paystackSecret).update(rawBody).digest('hex');
  const a = Buffer.from(h), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Payouts (Paystack Transfers). Requires Transfers enabled on your account and a funded balance.
export const listBanks = () => call('/bank?country=nigeria&currency=NGN&perPage=100');
export const createRecipient = ({ name, accountNumber, bankCode }) =>
  call('/transferrecipient', { method: 'POST', body: JSON.stringify({ type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' }) });
export const transfer = ({ amountKobo, recipient, reference, reason }) =>
  call('/transfer', { method: 'POST', body: JSON.stringify({ source: 'balance', amount: amountKobo, recipient, reference, reason }) });

// Looks up the account holder's name from the bank (Paystack "resolve account"). The creator must confirm it before the account is saved.
export const resolveAccount = ({ accountNumber, bankCode }) =>
  call(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
