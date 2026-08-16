import { ConversationModel } from '../models/Conversation';
import { DraftModel } from '../models/Draft';
import { ChatConfigModel } from '../models/ChatConfig';
import { resolveMasterPrompt } from './master-prompt';
import { generateDraft, DraftPrompt, foldTopicsIntoHistory, TopicEntry, FoldedMessage } from './llm';
import { selectTopicsForContext } from './topics';
import { sendDraftNotification } from '../bots/review-bot';

const CONTEXT_WINDOW = 20;

export interface IncomingMessageInfo {
  chatId: string;
  peerUsername: string;
  text: string;
  timestamp: Date;
}

export interface DraftedReply {
  draftId: string;
  draftText: string;
  notificationMessageId: number | null;
}

export interface ChatMessage {
  role: 'them' | 'me';
  text: string;
}

export function buildContext(
  messages: ChatMessage[],
  selectedTopics: TopicEntry[] = []
): string {
  const recent = messages.slice(-CONTEXT_WINDOW);
  const windowBlock = recent
    .map((m) => `${m.role === 'me' ? 'Me' : 'Them'}: ${m.text}`)
    .join('\n');
  if (selectedTopics.length === 0) {
    return windowBlock;
  }
  const topicsBlock = selectedTopics
    .map((t) => `${t.label}: ${t.summary}`)
    .join('\n');
  return `Earlier conversation topics (background context):
${topicsBlock}

Recent messages:
${windowBlock}`;
}

export async function loadOrCreateConversation(
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

export async function appendIncomingMessage(
  chatId: string,
  peerUsername: string,
  text: string,
  timestamp: Date
): Promise<void> {
  const doc = await loadOrCreateConversation(chatId, peerUsername);
  doc.messages.push({ role: 'them', text, timestamp });
  doc.lastUpdated = new Date();
  await trimConversation(doc);
  await doc.save();
}

export async function appendSentMessage(chatId: string, text: string): Promise<void> {
  const doc = await ConversationModel.findOne({ chatId }).exec();
  if (!doc) {
    return;
  }
  doc.messages.push({ role: 'me', text, timestamp: new Date() });
  doc.lastUpdated = new Date();
  await trimConversation(doc);
  await doc.save();
}

async function trimConversation(
  doc: InstanceType<typeof ConversationModel>
): Promise<void> {
  const topics: TopicEntry[] = (doc.topics as unknown as TopicEntry[] | undefined) ?? [];
  while (doc.messages.length > CONTEXT_WINDOW) {
    const over = doc.messages.length - CONTEXT_WINDOW;
    const evicted = doc.messages.splice(0, over) as unknown as FoldedMessage[];
    try {
      const next = await foldTopicsIntoHistory(topics, evicted);
      doc.topics = next as never;
      topics.length = 0;
      topics.push(...next);
    } catch (err) {
      console.error('[pipeline] topic fold failed (messages still pruned):', err);
    }
  }
}

export async function draftReply(
  info: IncomingMessageInfo
): Promise<DraftedReply> {
  const { chatId, peerUsername, text } = info;

  const conversation = await ConversationModel.findOne({ chatId })
    .lean()
    .exec();
  const topics = (conversation?.topics as unknown as TopicEntry[] | undefined) ?? [];
  const selectedTopics = selectTopicsForContext(topics, text);
  const context = buildContext(
    ((conversation?.messages as unknown) as ChatMessage[] | undefined) ?? [],
    selectedTopics
  );

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

  const notificationMessageId = await sendDraftNotification({
    chatId,
    senderName: peerUsername || 'unknown',
    incomingMessage: text,
    draftText,
    draftId: String(draft._id),
  });

  return {
    draftId: String(draft._id),
    draftText,
    notificationMessageId,
  };
}