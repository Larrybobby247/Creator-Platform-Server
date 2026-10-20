// Dojah "Validate BVN": GET /api/v1/kyc/bvn  (https://docs.dojah.io/api-reference/individual-verification/nigeria/validate-bvn)
// Headers: `AppId` and `Authorization: <secret key>` (sent as-is, NOT "Bearer").
// Errors deliberately carry no URL, BVN or credentials, so nothing sensitive can reach logs.
export class DojahError extends Error {
  constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
}

export async function validateBvn(cfg, { bvn, firstName, lastName, dob }, fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams({ bvn });
  if (firstName) params.set('first_name', firstName);
  if (lastName) params.set('last_name', lastName);
  if (dob) params.set('dob', dob); // yyyy-mm-dd
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res;
  try { res = await fetchImpl(`${cfg.baseUrl}/api/v1/kyc/bvn?${params}`, { method: 'GET', headers: { Authorization: cfg.secret, AppId: cfg.appId }, signal: ctl.signal }); }
  catch (e) { throw new DojahError(e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); }
  finally { clearTimeout(timer); }
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 200) { if (!body || typeof body !== 'object') throw new DojahError('BAD_RESPONSE', 200); return body; }
  const msg = String(body?.error || '');
  if (res.status === 404 || (res.status === 400 && /not found/i.test(msg))) throw new DojahError('NOT_FOUND', res.status); // documented: unknown BVN => 400 "BVN not found"
  if (res.status === 400) throw new DojahError('BAD_REQUEST', 400);
  if (res.status === 401) throw new DojahError('UNAUTHORIZED', 401);   // our credentials are wrong: operator problem
  if (res.status === 402) throw new DojahError('INSUFFICIENT_FUNDS', 402); // wallet empty: operator problem
  if (res.status === 429) throw new DojahError('RATE_LIMITED', 429);
  if (res.status === 424 || res.status >= 500) throw new DojahError('UPSTREAM_UNAVAILABLE', res.status);
  throw new DojahError('BAD_RESPONSE', res.status);
}

/** Decide from a 200 response whether the identity genuinely matched. Anything unexpected is a failure, never a success. */
export function evaluateBvnValidation(body, { minConfidence = 90 } = {}) {
  const e = body?.entity;
  if (!e || typeof e !== 'object') return { verified: false, reason: 'MALFORMED_RESPONSE' };
  if (e.bvn?.status !== true) return { verified: false, reason: 'BVN_INVALID' };
  const scores = {};
  for (const [key, label] of [['first_name', 'firstName'], ['last_name', 'lastName']]) {
    const f = e[key];
    if (!f || f.status !== true || typeof f.confidence_value !== 'number' || f.confidence_value < minConfidence) return { verified: false, reason: 'NAME_MISMATCH' };
    scores[label] = f.confidence_value;
  }
  // Dojah documents `dob` as a request parameter but not its response shape; if it is reported and false, fail.
  if (e.dob && e.dob.status === false) return { verified: false, reason: 'DOB_MISMATCH' };
  return { verified: true, scores };
}
