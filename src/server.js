import http from 'http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { app } from './app.js';
import { initRealtime } from './realtime.js';
import { startJobs } from './jobs/index.js';
import { resolveDojahConfig } from './services/dojahConfig.js';
await import('./models/Extra.js'); await import('./models/indexes.js');
// One connection pool for the whole process. autoIndex only in development; in production run `npm run indexes` at deploy time.
await mongoose.connect(env.db, { maxPoolSize: Number(process.env.DB_POOL_MAX) || 20, minPoolSize: 2, serverSelectionTimeoutMS: 8000, autoIndex: !env.prod });
const dj = resolveDojahConfig(); if (!dj.ok) console.warn(`[startup] BVN verification disabled: ${dj.reason}`); else console.log(`[startup] Dojah BVN verification: ${dj.environment}`);
const server = http.createServer(app);
initRealtime(server);
startJobs();
server.listen(env.port, () => console.log(`API + realtime on :${env.port} (payments: ${env.paymentProvider})`));
