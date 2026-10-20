import { Router } from 'express';
import { z } from 'zod';
import { Conversation, ConversationNote } from '../models/Social.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

const r = Router();
r.use(authenticate);
const body = z.object({ text: z.string().min(1).max(4000) });

async function assertParticipant(convId, userId) {
  const c = await Conversation.findOne({ _id: convId, participants: userId });
  if (!c) throw new ApiError(404, 'Conversation not found');
}
r.get('/conversations/:id/notes', asyncHandler(async (req, res) => {
  await assertParticipant(req.params.id, req.user._id);
  res.json({ notes: await ConversationNote.find({ conversationId: req.params.id, authorId: req.user._id }).sort('-updatedAt') });
}));
r.post('/conversations/:id/notes', asyncHandler(async (req, res) => {
  await assertParticipant(req.params.id, req.user._id);
  res.status(201).json(await ConversationNote.create({ conversationId: req.params.id, authorId: req.user._id, text: body.parse(req.body).text }));
}));
// Ownership enforced in the query itself: someone else's note simply "doesn't exist".
r.patch('/notes/:id', asyncHandler(async (req, res) => {
  const n = await ConversationNote.findOneAndUpdate({ _id: req.params.id, authorId: req.user._id }, { text: body.parse(req.body).text }, { new: true });
  if (!n) throw new ApiError(404, 'Note not found'); res.json(n);
}));
r.delete('/notes/:id', asyncHandler(async (req, res) => {
  const n = await ConversationNote.findOneAndDelete({ _id: req.params.id, authorId: req.user._id });
  if (!n) throw new ApiError(404, 'Note not found'); res.json({ ok: true });
}));
export default r;
