// Reusable server-side search / filter / sort / pagination for every admin table.
export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const rx = (s) => new RegExp(esc(String(s).slice(0, 60)), 'i');
export const isId = (s) => /^[0-9a-f]{24}$/i.test(String(s || ''));
export const dateRange = (req, field = 'createdAt') => { const f = req.query.from && new Date(req.query.from), t = req.query.to && new Date(`${req.query.to}T23:59:59.999Z`); const o = {}; if (f && !isNaN(f)) o.$gte = f; if (t && !isNaN(t)) o.$lte = t; return Object.keys(o).length ? { [field]: o } : {}; };
export async function paged(Model, filter, req, { sortable = ['createdAt'], defaultSort = '-createdAt', select, populate = [] } = {}) {
  const page = Math.max(1, Number(req.query.page) || 1), pageSize = Math.min(50, Math.max(5, Number(req.query.pageSize) || 20));
  let sort = defaultSort; const m = String(req.query.sort || '').match(/^(-?)([\w.]+)$/); if (m && sortable.includes(m[2])) sort = `${m[1]}${m[2]}`;
  const noFilter = !Object.keys(filter).length;
  let q = Model.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize); if (select) q = q.select(select); for (const p of populate) q = q.populate(...p);
  const [items, total] = await Promise.all([q.lean(), noFilter ? Model.estimatedDocumentCount() : Model.countDocuments(filter)]);
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
