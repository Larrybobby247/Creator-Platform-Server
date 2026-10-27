import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import auth from './routes/auth.js';
import publicRoutes from './routes/public.js';
import creators from './routes/creators.js';
import studio from './routes/studio.js';
import points from './routes/points.js';
import gifts from './routes/gifts.js';
import notes from './routes/notes.js';
import messages from './routes/messages.js';
import media from './routes/media.js';
import admin from './routes/admin/index.js';
import feed from './routes/feed.js';
import social2 from './routes/social2.js';
import meetups from './routes/meetups.js';
import contact from './routes/contact.js';
import me from './routes/me.js';
import verification from './routes/verification.js';
import platform from './routes/platform.js';
import discover from './routes/discover.js';
import stories from './routes/stories.js';
import insights from './routes/insights.js';

export const app = express();
app.set('trust proxy', 1); // behind Render's proxy: without this every visitor shares one IP, so the rate limits (e.g. 10 sign-ups an hour) were hit by everyone together
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression()); // JSON compresses ~5-10x; hosting-level compression is fine too
app.use((req, res, next) => { // timing: Server-Timing header on every response + log of slow requests (path only, never query strings or bodies)
  const t0 = process.hrtime.bigint(); const wh = res.writeHead.bind(res);
  res.writeHead = (...a) => { if (!res.headersSent) res.setHeader('Server-Timing', `total;dur=${Number(process.hrtime.bigint() - t0) / 1e6 | 0}`); return wh(...a); };
  res.on('finish', () => { const ms = Number(process.hrtime.bigint() - t0) / 1e6; if (ms > 500) console.warn(`[slow] ${req.method} ${req.baseUrl}${req.path} ${ms | 0}ms`); });
  next();
});
// Safe default for API responses: never cached by browsers/proxies (they are per-user). Public endpoints opt in below.
app.use('/api', (_q, res, next) => { res.set('Cache-Control', 'private, no-store'); res.vary('Cookie'); next(); });
app.use(cors({ origin: [env.frontendUrl, env.adminUrl], credentials: true }));
app.use(cookieParser());
app.use('/uploads', express.static(env.publicDir, { maxAge: '365d', immutable: true, index: false })); // random file names => safe to cache forever
app.get('/api/health', (_q, res) => res.json({ ok: true }));
app.use('/api/points/webhook', points); // raw-body route must be mounted before express.json
app.use(express.json({ limit: '100kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, message: { error: 'Too many attempts. Please wait a little and try again.', code: 'RATE_LIMITED' } }), auth);
app.use('/api/public', publicRoutes); // no login needed: shared profile and community pages
app.use('/api/creators', creators);
app.use('/api/studio/verification', verification);
app.use('/api/studio', studio);
app.use('/api/points', points);
app.use('/api/gifts', gifts);
app.use('/api/media', media);
app.use('/api/messages', messages);
app.use('/api/meetups', meetups);
app.use('/api/admin', admin);
app.use('/api', contact); // public
app.use('/api', platform); // public
app.use('/api/stories', stories);
app.use('/api/insights', insights);
app.use('/api', discover);
app.use('/api', me);
app.use('/api', feed);
app.use('/api', social2);
app.use('/api', notes);
app.use(errorHandler);
