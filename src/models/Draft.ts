import { Schema, model, InferSchemaType } from 'mongoose';

export const draftSchema = new Schema({
  chatId: { type: String, required: true, index: true },
  incomingMessage: { type: String, required: true },
  draftText: { type: String, required: true },
  finalText: { type: String, default: null },
  status: {
    type: String,
    enum: ['pending', 'sent', 'skipped'],
    required: true,
    default: 'pending',
    index: true,
  },
  wasEdited: { type: Boolean, required: true, default: false },
  createdAt: { type: Date, required: true, default: Date.now },
});

export type Draft = InferSchemaType<typeof draftSchema>;

export const DraftModel = model('Draft', draftSchema);