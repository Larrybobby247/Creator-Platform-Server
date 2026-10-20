import { Router } from 'express';
import auth from './auth.js';
import dashboard from './dashboard.js';
import people from './people.js';
import finance from './finance.js';
import ops from './ops.js';
import config from './config.js';
import { adminAuthenticate } from '../../middleware/adminAuth.js';

const r = Router();
r.use((_q, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
r.use('/auth', auth);
r.use(adminAuthenticate); // everything below needs a valid ADMIN session; each route then checks its own permission
r.use(dashboard); r.use(people); r.use(finance); r.use(ops); r.use(config);
export default r;
