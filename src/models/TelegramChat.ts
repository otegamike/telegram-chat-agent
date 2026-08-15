import { Schema, model, InferSchemaType } from 'mongoose';

export const telegramChatSchema = new Schema({
  chatId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
  displayName: { type: String, default: '' },
  type: { type: String, default: 'private' },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now },
});

export type TelegramChat = InferSchemaType<typeof telegramChatSchema>;

export const TelegramChatModel = model('TelegramChat', telegramChatSchema);