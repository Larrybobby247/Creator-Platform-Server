import { AuditLog } from '../models/Finance.js';
// Never pass passwords, tokens, BVNs or full account numbers in before/after/meta.
export const audit = (req, action, target, { reason, before, after, meta } = {}) =>
  AuditLog.create({ actorId: req.admin?._id, action, target: target ? String(target) : undefined, reason, before, after, meta, ip: req.ip });
