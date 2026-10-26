import { Server } from 'socket.io';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { env } from './config/env.js';
import { Conversation } from './models/Social.js';
import { User } from './models/User.js';

let io; const online = new Map();
export const isOnline = (id) => (online.get(String(id)) || 0) > 0;
export const emitToUser = (id, ev, data) => io?.to(`user:${id}`).emit(ev, data);

// Tell the people this user chats with that they came online / went offline, but only if the user allows showing it (Settings > Privacy).
async function announce(id, isOn) {
  try {
    const u = await User.findById(id).select('prefs.showOnline').lean(); if (u?.prefs?.showOnline === false) return;
    const convs = await Conversation.find({ participants: id }).select('participants').limit(200).lean();
    const peers = new Set(convs.flatMap((c) => c.participants.map(String)).filter((p) => p !== String(id)));
    peers.forEach((p) => emitToUser(p, 'presence', { userId: String(id), online: isOn }));
  } catch { /* presence is best-effort */ }
}

export function initRealtime(httpServer) {
  // Cookies are cross-site in production (frontend and API on different hosts), so the origin must match FRONTEND_URL exactly.
  io = new Server(httpServer, { cors: { origin: [env.frontendUrl, env.adminUrl].filter(Boolean), credentials: true } });
  io.use((socket, next) => {
    try { // identity comes from the signed cookie, never from client-supplied ids
      const token = cookie.parse(socket.handshake.headers.cookie || '').token;
      socket.userId = jwt.verify(token, env.jwtSecret).sub; next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', (socket) => {
    const id = socket.userId; socket.join(`user:${id}`);
    const n = (online.get(id) || 0) + 1; online.set(id, n); if (n === 1) announce(id, true);
    socket.on('typing', async ({ conversationId }) => {
      const c = await Conversation.findOne({ _id: conversationId, participants: id }).select('participants');
      if (c) c.participants.filter((p) => String(p) !== id).forEach((p) => emitToUser(p, 'typing', { conversationId, userId: id }));
    });
    socket.on('disconnect', () => { const left = Math.max(0, (online.get(id) || 1) - 1); online.set(id, left); if (left === 0) setTimeout(() => !isOnline(id) && announce(id, false), 4000); }); // short grace so a page refresh does not flicker
  });
}
