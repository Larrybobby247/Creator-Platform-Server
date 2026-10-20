// Spins up an in-memory MongoDB. Returns null (tests skip) if dependencies aren't installed yet.
process.env.DATABASE_URL ||= 'mongodb://unused'; process.env.JWT_SECRET ||= 'test-secret'; process.env.MEDIA_SIGNING_SECRET ||= 'test-media'; process.env.NODE_ENV = 'test';
export async function startDb() {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server'); const mongoose = (await import('mongoose')).default;
    const mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri());
    return { mongoose, stop: async () => { await mongoose.disconnect(); await mongod.stop(); } };
  } catch { return null; }
}

// Boots the real Express app on a random port; `call()` keeps cookies per "browser".
export async function startApp() {
  const { app } = await import('../src/app.js'); const http = await import('node:http');
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const real = globalThis.fetch;
  const client = () => { let cookie = ''; const fn = async (method, path, body, headers = {}) => {
    const r = await real(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; let json = {}; try { json = await r.json(); } catch {} return { status: r.status, json };
  }; fn.cookie = () => cookie; return fn; };
  return { client, real, base, stop: () => new Promise((r) => server.close(r)) };
}
// Replace outbound calls to Dojah only; everything else (our own server) passes through.
export function stubDojah(real, handler) {
  globalThis.fetch = (url, opts) => String(url).includes('dojah.io') ? handler(String(url), opts) : real(url, opts);
  return () => { globalThis.fetch = real; };
}
export const dojahOk = (over = {}) => new Response(JSON.stringify({ entity: { bvn: { value: '2*****89012', status: true }, first_name: { confidence_value: 100, status: true }, last_name: { confidence_value: 100, status: true }, ...over } }), { status: 200 });
