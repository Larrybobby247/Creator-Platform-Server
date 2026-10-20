import { Server } from 'socket.io';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { env } from './config/env.js';
import { Conversation } from './models/Social.js';

let io; const online = new Map();
export const isOnline = (id) => (online.get(String(id)) || 0) > 0;
export const emitToUser = (id, ev, data) => io?.to(`user:${id}`).emit(ev, data);

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.frontendUrl, credentials: true } });
  io.use((socket, next) => {
    try { // identity comes from the signed cookie, never from client-supplied ids
      const token = cookie.parse(socket.handshake.headers.cookie || '').token;
      socket.userId = jwt.verify(token, env.jwtSecret).sub; next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', (socket) => {
    const id = socket.userId; socket.join(`user:${id}`);
    online.set(id, (online.get(id) || 0) + 1);
    socket.on('typing', async ({ conversationId }) => {
      const c = await Conversation.findOne({ _id: conversationId, participants: id }).select('participants');
      if (c) c.participants.filter((p) => String(p) !== id).forEach((p) => emitToUser(p, 'typing', { conversationId, userId: id }));
    });
    socket.on('disconnect', () => { online.set(id, Math.max(0, (online.get(id) || 1) - 1)); });
  });
}
