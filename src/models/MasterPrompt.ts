import { Schema, model, InferSchemaType } from 'mongoose';

export const masterPromptSchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  systemPrompt: { type: String, required: true },
  fewShotExamples: [
    {
      trigger: { type: String, required: true },
      reply: { type: String, required: true },
    },
  ],
  correctionsBlock: { type: String, default: null },
  updatedAt: { type: Date, required: true, default: Date.now },
});

export type MasterPrompt = InferSchemaType<typeof masterPromptSchema>;

export const MasterPromptModel = model('MasterPrompt', masterPromptSchema);