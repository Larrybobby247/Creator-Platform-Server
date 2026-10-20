// Pure (no imports) so it is trivially testable. Chooses endpoint + credentials from the environment.
// Production NEVER falls back to sandbox, and there is no mock mode anywhere.
export function resolveDojahConfig(e = process.env) {
  const prod = e.NODE_ENV === 'production';
  const requested = String(e.DOJAH_ENV || (prod ? 'production' : 'sandbox')).toLowerCase();
  if (requested !== 'sandbox' && requested !== 'production') return { ok: false, reason: 'INVALID_DOJAH_ENV' };
  if (prod && requested !== 'production') return { ok: false, reason: 'SANDBOX_NOT_ALLOWED_IN_PRODUCTION' };
  const sandbox = requested === 'sandbox';
  const appId = (sandbox ? e.DOJAH_SANDBOX_APP_ID : e.DOJAH_APP_ID) || '';
  const secret = (sandbox ? e.DOJAH_SANDBOX_SECRET_KEY : e.DOJAH_SECRET_KEY) || '';
  if (!appId || !secret) return { ok: false, reason: 'MISSING_CREDENTIALS', environment: requested };
  const t = Number(e.DOJAH_TIMEOUT_MS); // Base URLs per https://docs.dojah.io/api-reference/get-started/environments
  return { ok: true, environment: requested, baseUrl: sandbox ? 'https://sandbox.dojah.io' : 'https://api.dojah.io', appId, secret, timeoutMs: Number.isFinite(t) && t >= 1000 ? t : 10000 };
}
