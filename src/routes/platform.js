import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSetting } from '../services/settings.js';
const r = Router();
// Public: the one place the app reads its name/tagline/support details from (edited in the admin dashboard).
r.get('/platform', asyncHandler(async (_q, res) => { res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600'); res.json(await getSetting('platform')); }));
export default r;
