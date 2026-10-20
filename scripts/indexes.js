// Builds/updates all indexes. Run at deploy time:  npm run indexes   (safe to repeat; builds in the background on a live DB)
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import '../src/models/Extra.js';
import { MODELS } from '../src/models/indexes.js';
await mongoose.connect(env.db);
for (const M of MODELS) { await M.createIndexes(); console.log('indexes ok:', M.modelName); }
await mongoose.disconnect();
