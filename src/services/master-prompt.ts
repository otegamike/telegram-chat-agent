import { MasterPromptModel, MasterPrompt } from '../models/MasterPrompt';
import { DEFAULT_MASTER_PROMPT_SEED, DEFAULT_PROMPT_KEY } from '../prompts/master-prompt';

type MasterPromptDoc = InstanceType<typeof MasterPromptModel>;

export async function ensureDefaultMasterPrompt(): Promise<MasterPromptDoc> {
  const existing = await MasterPromptModel.findOne({ key: DEFAULT_PROMPT_KEY });
  if (existing) {
    const migrated =
      existing.$isDefault('name') || existing.$isDefault('chatId') || existing.$isDefault('enabled');
    if (migrated) {
      existing.name = existing.$isDefault('name') ? DEFAULT_MASTER_PROMPT_SEED.name : existing.name;
      existing.chatId = existing.$isDefault('chatId') ? DEFAULT_MASTER_PROMPT_SEED.chatId : existing.chatId;
      existing.enabled = existing.$isDefault('enabled')
        ? DEFAULT_MASTER_PROMPT_SEED.enabled
        : existing.enabled;
      existing.updatedAt = new Date();
      await existing.save();
    }
    return existing;
  }
  return MasterPromptModel.create(DEFAULT_MASTER_PROMPT_SEED);
}

export async function getMasterPromptByChat(chatId: string): Promise<MasterPrompt | null> {
  return MasterPromptModel.findOne({ chatId, enabled: true })
    .sort({ updatedAt: -1 })
    .lean()
    .exec();
}

export async function getDefaultMasterPrompt(): Promise<MasterPromptDoc> {
  return ensureDefaultMasterPrompt();
}

export async function resolveMasterPrompt(chatId: string): Promise<MasterPromptDoc> {
  const chatPrompt = await MasterPromptModel.findOne({
    chatId,
    enabled: true,
    key: { $ne: DEFAULT_PROMPT_KEY },
  })
    .sort({ updatedAt: -1 })
    .exec();
  if (chatPrompt) {
    return chatPrompt;
  }
  return ensureDefaultMasterPrompt();
}