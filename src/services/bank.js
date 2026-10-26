// Bank helpers for creator payouts: list banks, look up the account holder's name, and save a verified payout account.
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import * as provider from './paymentProvider.js';

let cache = { at: 0, banks: [] };
export async function listBanks() {
  if (env.paymentProvider !== 'paystack') return { banks: [{ name: 'Test Bank (dev)', code: '000' }], dev: true };
  if (Date.now() - cache.at > 6 * 3600e3 || !cache.banks.length) cache = { at: Date.now(), banks: (await provider.listBanks()).map((b) => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name)) };
  return { banks: cache.banks };
}
const norm = (s = '') => String(s).toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
export const sameName = (a, b) => norm(a) === norm(b);
export const namesOverlap = (a, b) => { const A = new Set(norm(a).split(' ').filter((t) => t.length > 1)); return norm(b).split(' ').some((t) => A.has(t)); };

/** Asks the bank who owns this account. The creator must see and confirm this name before the account is saved. */
export async function resolveName({ accountNumber, bankCode }) {
  if (!/^\d{10}$/.test(accountNumber || '')) throw new ApiError(400, 'An account number has 10 digits');
  if (!bankCode) throw new ApiError(400, 'Choose your bank');
  if (env.paymentProvider !== 'paystack') return 'TEST ACCOUNT HOLDER'; // dev only
  try { return (await provider.resolveAccount({ accountNumber, bankCode })).account_name; }
  catch (e) { if (e.status === 503) throw e; throw new ApiError(422, 'We could not find an account with those details. Check the bank and the account number.', 'ACCOUNT_NOT_FOUND'); }
}

/** Re-checks the name with the bank (never trusts the client), registers the transfer recipient and stores a masked copy on the user. */
export async function saveVerifiedAccount(user, { bankCode, bankName, accountNumber, confirmedName }) {
  const accountName = await resolveName({ accountNumber, bankCode });
  if (!sameName(accountName, confirmedName)) throw new ApiError(409, 'The account name changed. Please verify it again.', 'NAME_MISMATCH');
  let recipientCode;
  if (env.paymentProvider === 'paystack') recipientCode = (await provider.createRecipient({ name: accountName, accountNumber, bankCode })).recipient_code;
  user.payoutAccount = { bankName, bankCode, accountLast4: accountNumber.slice(-4), accountName, recipientCode, verifiedAt: new Date() };
  await user.save();
  return maskedAccount(user);
}
export const maskedAccount = (u) => (u.payoutAccount?.accountLast4 ? { bankName: u.payoutAccount.bankName, accountLast4: u.payoutAccount.accountLast4, accountName: u.payoutAccount.accountName, verifiedAt: u.payoutAccount.verifiedAt } : null);
