import { ZodError } from 'zod';
export const recentErrors = []; // last 20 server errors (path + message only) for the admin System Health page
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
  const status = err.status || 500;
  if (status >= 500) { console.error(err.message); recentErrors.unshift({ at: new Date(), path: req.path, message: String(err.message).slice(0, 200) }); recentErrors.length = Math.min(recentErrors.length, 20); }
  res.status(status).json({ error: status >= 500 && !err.code ? 'Server error' : err.message, code: err.code, attemptsLeft: err.attemptsLeft, extra: err.extra });
}
