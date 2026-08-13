import { Schema, model, InferSchemaType } from 'mongoose';

export const conversationSchema = new Schema({
  chatId: { type: String, required: true, unique: true, index: true },
  peerUsername: { type: String, required: true },
  messages: [
    {
      role: { type: String, enum: ['them', 'me'], required: true },
      text: { type: String, required: true },
      timestamp: { type: Date, required: true, default: Date.now },
    },
  ],
  summary: { type: String, default: '' },
  lastUpdated: { type: Date, required: true, default: Date.now },
});

export type Conversation = InferSchemaType<typeof conversationSchema>;

export const ConversationModel = model('Conversation', conversationSchema);