import { ConversationModel } from '../models/Conversation';
import { DraftModel } from '../models/Draft';
import { ChatConfigModel } from '../models/ChatConfig';
import { resolveMasterPrompt } from './master-prompt';
import { generateDraft, DraftPrompt } from './llm';
import { sendDraftNotification } from '../bots/review-bot';

const CONTEXT_WINDOW = 20;

export interface IncomingMessageInfo {
  chatId: string;
  peerUsername: string;
  text: string;
  timestamp: Date;
}

function buildContext(messages: { role: 'them' | 'me'; text: string }[]): string {
  const recent = messages.slice(-CONTEXT_WINDOW);
  return recent.map((m) => `${m.role === 'me' ? 'Me' : 'Them'}: ${m.text}`).join('\n');
}

async function loadOrCreateConversation(
  chatId: string,
  peerUsername: string
): Promise<InstanceType<typeof ConversationModel>> {
  let doc = await ConversationModel.findOne({ chatId }).exec();
  if (!doc) {
    doc = await ConversationModel.create({ chatId, peerUsername, messages: [] });
  } else if (doc.peerUsername !== peerUsername) {
    doc.peerUsername = peerUsername;
    await doc.save();
  }
  return doc;
}

export async function processIncomingMessage(info: IncomingMessageInfo): Promise<void> {
  const { chatId, peerUsername, text, timestamp } = info;

  const config = await ChatConfigModel.findOne({ chatId }).lean().exec();
  if (!config || !config.autoReplyEnabled) {
    console.log(`[pipeline] chat=${chatId} not in allow-list (or disabled) — ignored`);
    return;
  }

  const doc = await loadOrCreateConversation(chatId, peerUsername);
  doc.messages.push({ role: 'them', text, timestamp });
  doc.lastUpdated = new Date();
  await doc.save();

  const context = buildContext(doc.messages as { role: 'them' | 'me'; text: string }[]);

  const masterPrompt = await resolveMasterPrompt(chatId);
  const prompt: DraftPrompt = {
    systemPrompt: masterPrompt.systemPrompt,
    fewShotExamples: masterPrompt.fewShotExamples ?? [],
    correctionsBlock: masterPrompt.correctionsBlock ?? null,
  };

  const draftText = await generateDraft(text, context, prompt);

  const draft = await DraftModel.create({
    chatId,
    incomingMessage: text,
    draftText,
    status: 'pending',
    wasEdited: false,
  });

  sendDraftNotification({
    chatId,
    senderName: peerUsername || 'unknown',
    incomingMessage: text,
    draftText,
    draftId: String(draft._id),
  });

  console.log(`[pipeline] chat=${chatId} drafted (${String(draft._id)})`);
}