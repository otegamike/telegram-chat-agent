import { Schema, model, InferSchemaType } from 'mongoose';

export const aiLogSchema = new Schema({
  kind: { type: String, required: true, enum: ['draft', 'fold', 'merge', 'correction'] },
  chatId: { type: String, default: null },
  model: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  userPrompt: { type: String, required: true },
  reply: { type: String, default: null },
  error: { type: String, default: null },
  durationMs: { type: Number, required: true },
  createdAt: { type: Date, required: true, default: Date.now, index: true },
});

export type AiLog = InferSchemaType<typeof aiLogSchema>;

export const AiLogModel = model('AiLog', aiLogSchema);
