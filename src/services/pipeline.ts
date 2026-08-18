import { ConversationModel } from '../models/Conversation';
import { DraftModel } from '../models/Draft';
import { ChatConfigModel } from '../models/ChatConfig';
import { resolveMasterPrompt } from './master-prompt';
import { generateDraft, DraftPrompt, foldTopicsIntoHistory, TopicEntry, FoldedMessage } from './llm';
import { selectTopicsForContext } from './topics';
import { sendDraftNotification } from '../bots/review-bot';
import { getSettings } from './settings';

const CONTEXT_WINDOW = 20;

const EVICTION_BATCH =
  Number.isFinite(Number(process.env.EVICTION_BATCH_SIZE)) &&
  Number(process.env.EVICTION_BATCH_SIZE) > 0
    ? Math.floor(Number(process.env.EVICTION_BATCH_SIZE))
    : 20;

let contextFoldQueue: Promise<void> = Promise.resolve();

function enqueueContextFold(chatId: string): void {
  contextFoldQueue = contextFoldQueue
    .then(() => runContextFold(chatId))
    .catch((err) => {
      console.error(`[pipeline] chat=${chatId} buffered context fold failed (swallowed):`, err);
    });
}

export function flushPendingContextFolds(): Promise<void> {
  return contextFoldQueue;
}

export async function drainAllEvictedBuffers(): Promise<number> {
  const docs = await ConversationModel.find({ evicted: { $exists: true, $ne: [] } })
    .select('chatId')
    .lean()
    .exec();
  let queued = 0;
  for (const doc of docs) {
    enqueueContextFold(doc.chatId);
    queued += 1;
  }
  await flushPendingContextFolds();
  return queued;
}

async function runContextFold(chatId: string): Promise<void> {
  const doc = await ConversationModel.findOne({ chatId }).lean().exec();
  if (!doc) {
    return;
  }
  const evicted = (doc.evicted as unknown as FoldedMessage[] | undefined) ?? [];
  if (evicted.length === 0) {
    return;
  }
  const topics: TopicEntry[] = (doc.topics as unknown as TopicEntry[] | undefined) ?? [];
  const [settings, chatConfig] = await Promise.all([
    getSettings(),
    ChatConfigModel.findOne({ chatId }).lean().exec(),
  ]);
  const roleNames = {
    me: settings.name?.trim() || undefined,
    them: (chatConfig?.contactName || '').trim() || undefined,
  };
  try {
    const next = await foldTopicsIntoHistory(topics, evicted, {
      ...roleNames,
      chatId,
      evictedBufferHint: true,
    });
    await ConversationModel.updateOne(
      { chatId },
      {
        $set: { topics: next, evicted: [], lastUpdated: new Date() },
      }
    ).exec();
    console.log(
      `[pipeline] chat=${chatId} folded ${evicted.length} buffered evicted message(s) into topics`
    );
  } catch (err) {
    console.error(
      `[pipeline] chat=${chatId} buffered context fold failed (buffer kept for next pass):`,
      err
    );
  }
}

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
  correctedFrom?: string | null;
}

export function buildContext(
  messages: ChatMessage[],
  selectedTopics: TopicEntry[] = [],
  roleNames: { me?: string | null; them?: string | null } = {}
): string {
  const meLabel = roleNames.me?.trim() || 'Me';
  const themLabel = roleNames.them?.trim() || 'Them';
  const recent = messages.slice(-CONTEXT_WINDOW);
  const windowBlock = recent
    .map((m) => {
      const label = m.role === 'me' ? meLabel : themLabel;
      const corrected =
        m.role === 'me' && m.correctedFrom
          ? ` [was drafted as: "${m.correctedFrom}"]`
          : '';
      return `${label}: ${m.text}${corrected}`;
    })
    .join('\n');
  const hasCorrections = recent.some((m) => m.role === 'me' && m.correctedFrom);
  const correctionNote = hasCorrections
    ? `\nNote: Me messages marked [was drafted as: "..."] are corrections the owner made. Prefer the corrected phrasing — never write like the original draft.`
    : '';
  if (selectedTopics.length === 0) {
    return windowBlock + correctionNote;
  }
  const topicsBlock = selectedTopics
    .map((t) => `${t.label}: ${t.summary}`)
    .join('\n');
  return `Earlier conversation topics (background context):
${topicsBlock}

Recent messages:
${windowBlock}${correctionNote}`;
}

function genderDesc(g: string): string | null {
  if (g === 'male') return 'a man (he/him)';
  if (g === 'female') return 'a woman (she/her)';
  if (g === 'they') return 'non-binary (they/them)';
  return null;
}

function buildIdentityBlock(info: {
  mainUsername: string;
  meGender: string;
  contactName: string;
  peerGender: string;
}): string | null {
  const lines: string[] = [];
  const meParts: string[] = [];
  if (info.mainUsername) {
    meParts.push(`your name is ${info.mainUsername}`);
  }
  const meDesc = genderDesc(info.meGender);
  if (meDesc) {
    meParts.push(`you identify as ${meDesc}`);
  }
  if (meParts.length) {
    lines.push(`Your identity: ${meParts.join(' and ')}.`);
  }
  if (info.contactName || info.peerGender) {
    const peerName = info.contactName || 'this person';
    const peerDesc = genderDesc(info.peerGender);
    lines.push(
      `The person you're replying to is ${peerName}${peerDesc ? `, who is ${peerDesc}` : ''}.`
    );
  }
  return lines.length ? lines.join('\n') : null;
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
  const needsFold = await trimConversation(doc);
  await doc.save();
  if (needsFold) {
    enqueueContextFold(doc.chatId);
  }
}

export async function appendSentMessage(
  chatId: string,
  text: string,
  opts: { correctedFrom?: string | null } = {}
): Promise<void> {
  const doc = await ConversationModel.findOne({ chatId }).exec();
  if (!doc) {
    return;
  }
  doc.messages.push({
    role: 'me',
    text,
    timestamp: new Date(),
    correctedFrom: opts.correctedFrom && opts.correctedFrom !== text ? opts.correctedFrom : null,
  });
  doc.lastUpdated = new Date();
  const needsFold = await trimConversation(doc);
  await doc.save();
  if (needsFold) {
    enqueueContextFold(doc.chatId);
  }
}

async function trimConversation(
  doc: InstanceType<typeof ConversationModel>
): Promise<boolean> {
  if (doc.messages.length <= CONTEXT_WINDOW) {
    return false;
  }
  const over = doc.messages.length - CONTEXT_WINDOW;
  const evicted = doc.messages.splice(0, over) as unknown as FoldedMessage[];
  const buffer = (doc.evicted as unknown as FoldedMessage[] | undefined) ?? [];
  buffer.push(...evicted);
  doc.evicted = buffer as never;
  return buffer.length >= EVICTION_BATCH;
}

export async function draftReply(
  info: IncomingMessageInfo
): Promise<DraftedReply> {
  const { chatId, peerUsername, text } = info;

  const [conversation, chatConfig, settings] = await Promise.all([
    ConversationModel.findOne({ chatId }).lean().exec(),
    ChatConfigModel.findOne({ chatId }).lean().exec(),
    getSettings(),
  ]);
  const topics = (conversation?.topics as unknown as TopicEntry[] | undefined) ?? [];
  const mainUsername = settings.name?.trim() || '';
  const contactName = (chatConfig?.contactName || '').trim();
  const selectedTopics = selectTopicsForContext(topics, text);
  const context = buildContext(
    ((conversation?.messages as unknown) as ChatMessage[] | undefined) ?? [],
    selectedTopics,
    {
      me: mainUsername || undefined,
      them: contactName || undefined,
    }
  );

  const masterPrompt = await resolveMasterPrompt(chatId);
  const prompt: DraftPrompt = {
    systemPrompt: masterPrompt.systemPrompt,
    fewShotExamples: masterPrompt.fewShotExamples ?? [],
    correctionsBlock: masterPrompt.correctionsBlock ?? null,
    identity: buildIdentityBlock({
      mainUsername,
      meGender: settings.gender || '',
      contactName,
      peerGender: chatConfig?.gender || '',
    }),
  };

  const draftText = await generateDraft(text, context, prompt, { chatId });

  const draft = await DraftModel.create({
    chatId,
    incomingMessage: text,
    draftText,
    status: 'pending',
    wasEdited: false,
  });

  const notificationMessageId = await sendDraftNotification({
    chatId,
    senderName: peerUsername || chatId,
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