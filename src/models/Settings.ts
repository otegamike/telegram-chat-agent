import { Schema, model, InferSchemaType } from 'mongoose';

export const settingsSchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  autoSendDelayMs: { type: Number, required: true, default: 240000 },
  name: { type: String, default: '' },
  gender: { type: String, default: '', enum: ['', 'male', 'female', 'they'] },
  updatedAt: { type: Date, required: true, default: Date.now },
});

export type Settings = InferSchemaType<typeof settingsSchema>;

export const SettingsModel = model('Settings', settingsSchema);