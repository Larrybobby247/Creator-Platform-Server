// Transactional email through Resend's HTTP API (no SMTP, no extra package: Node's built-in fetch is enough).
// If RESEND_API_KEY is missing, sending quietly does nothing (dev prints links to the console instead).
import { env } from '../config/env.js';

export const testOutbox = []; // only filled when NODE_ENV=test
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Small branded HTML wrapper. `lines` are plain-text paragraphs; `cta` adds a button. */
export function emailHtml({ title, lines = [], cta }) {
  const body = lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#374151">${esc(l).replace(/\n/g, '<br>')}</p>`).join('');
  const btn = cta ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#8B5CF6;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px;display:inline-block">${esc(cta.label)}</a></p><p style="margin:0;font-size:12px;color:#6b7280;word-break:break-all">If the button does not work, copy this link:<br>${esc(cta.url)}</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:Inter,Arial,sans-serif"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px"><h1 style="margin:0 0 16px;font-size:20px;color:#111827">${esc(title)}</h1>${body}${btn}</div></body></html>`;
}

export async function sendEmail(to, subject, text, opts = {}) {
  if (process.env.NODE_ENV === 'test') { testOutbox.push({ to, subject, text }); return true; }
  if (!env.resendApiKey) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000), body: JSON.stringify({ from: env.mailFrom, to: [to], subject, text, ...(opts.html ? { html: opts.html } : {}) }),
    });
    if (!r.ok) { console.error('email failed (Resend):', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('email failed:', e.message); return false; }
}
