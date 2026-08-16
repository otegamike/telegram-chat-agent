import { Schema, model, InferSchemaType } from 'mongoose';

export const chatConfigSchema = new Schema({
  chatId: { type: String, required: true, unique: true, index: true },
  peerUsername: { type: String, default: '' },
  autoReplyEnabled: { type: Boolean, required: true, default: false },
  lastProcessedMessageId: { type: Number, default: null },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now },
});

export type ChatConfig = InferSchemaType<typeof chatConfigSchema>;

export const ChatConfigModel = model('ChatConfig', chatConfigSchema);