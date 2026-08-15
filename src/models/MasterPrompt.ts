import { Schema, model, InferSchemaType } from 'mongoose';

export const masterPromptSchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, default: 'Master prompt' },
  chatId: { type: String, default: null },
  systemPrompt: { type: String, required: true },
  fewShotExamples: [
    {
      trigger: { type: String, required: true },
      reply: { type: String, required: true },
    },
  ],
  correctionsBlock: { type: String, default: null },
  enabled: { type: Boolean, required: true, default: true },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now },
});

export type MasterPrompt = InferSchemaType<typeof masterPromptSchema>;

export const MasterPromptModel = model('MasterPrompt', masterPromptSchema);