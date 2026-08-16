import { DraftModel } from '../models/Draft';
import { ChatConfigModel } from '../models/ChatConfig';
import { setReviewHandlers, editDraftNotification, ReviewAction } from '../bots/review-bot';
import { appendIncomingMessage, appendSentMessage, draftReply, IncomingMessageInfo } from './pipeline';
import { getSettings } from './settings';
import { sendAsUser, markChatAsRead } from './telegram-sender';

type FlowStatus = 'idle' | 'drafting' | 'awaiting' | 'editing';

interface ChatFlow {
  chatId: string;
  peerUsername: string;
  status: FlowStatus;
  pendingDraftId: string | null;
  pendingNotificationMessageId: number | null;
  timer: NodeJS.Timeout | null;
  queuedLatest: { text: string; timestamp: Date } | null;
}

const flows = new Map<string, ChatFlow>();
let editingChatId: string | null = null;
let managerInitialized = false;

function getFlow(chatId: string, peerUsername: string): ChatFlow {
  let flow = flows.get(chatId);
  if (!flow) {
    flow = {
      chatId,
      peerUsername,
      status: 'idle',
      pendingDraftId: null,
      pendingNotificationMessageId: null,
      timer: null,
      queuedLatest: null,
    };
    flows.set(chatId, flow);
  }
  return flow;
}

function findFlowForDraft(draftId: string): ChatFlow | null {
  for (const flow of flows.values()) {
    if (flow.pendingDraftId === draftId) {
      return flow;
    }
  }
  return null;
}

function clearTimer(flow: ChatFlow): void {
  if (flow.timer) {
    clearTimeout(flow.timer);
    flow.timer = null;
  }
}

async function isAllowedChat(chatId: string): Promise<boolean> {
  const config = await ChatConfigModel.findOne({ chatId }).lean().exec();
  return !!config && !!config.autoReplyEnabled;
}

async function scheduleAutoSend(flow: ChatFlow): Promise<void> {
  clearTimer(flow);
  const { autoSendDelayMs } = await getSettings();
  if (autoSendDelayMs <= 0) {
    return;
  }
  flow.timer = setTimeout(() => {
    void autoSendPending(flow);
  }, autoSendDelayMs);
}

async function autoSendPending(flow: ChatFlow): Promise<void> {
  flow.timer = null;
  if (flow.status !== 'awaiting' || !flow.pendingDraftId) {
    return;
  }
  const draft = await DraftModel.findById(flow.pendingDraftId).exec();
  if (!draft || draft.status !== 'pending') {
    return;
  }
  await completeSend(flow, String(draft._id), null, 'auto');
}

async function draftNext(flow: ChatFlow): Promise<void> {
  if (!flow.queuedLatest) {
    flow.status = 'idle';
    flow.pendingDraftId = null;
    flow.pendingNotificationMessageId = null;
    return;
  }
  const queued = flow.queuedLatest;
  flow.queuedLatest = null;
  flow.status = 'drafting';
  try {
    const drafted = await draftReply({
      chatId: flow.chatId,
      peerUsername: flow.peerUsername,
      text: queued.text,
      timestamp: queued.timestamp,
    });
    flow.pendingDraftId = drafted.draftId;
    flow.pendingNotificationMessageId = drafted.notificationMessageId;
    flow.status = 'awaiting';
    await scheduleAutoSend(flow);
  } catch (err) {
    console.error(`[review-manager] chat=${flow.chatId} queued draft failed:`, err);
    flow.status = 'idle';
    flow.pendingDraftId = null;
    flow.pendingNotificationMessageId = null;
  }
}

async function completeSend(
  flow: ChatFlow,
  draftId: string,
  editedText: string | null,
  source: 'send' | 'edit' | 'auto'
): Promise<void> {
  const draft = await DraftModel.findById(draftId).exec();
  if (!draft || draft.status !== 'pending') {
    return;
  }
  const finalText = editedText ?? draft.draftText;
  await sendAsUser(flow.chatId, finalText);
  try {
    await markChatAsRead(flow.chatId);
  } catch (err) {
    console.error(`[review-manager] chat=${flow.chatId} mark-as-read failed (continuing):`, err);
  }

  draft.status = 'sent';
  draft.finalText = finalText;
  if (editedText !== null) {
    draft.wasEdited = true;
  }
  await draft.save();
  await appendSentMessage(flow.chatId, finalText);

  clearTimer(flow);
  if (flow.pendingNotificationMessageId !== null) {
    const label = source === 'edit' ? 'Edited & sent' : source === 'auto' ? 'Auto-sent' : 'Sent';
    await editDraftNotification(flow.pendingNotificationMessageId, `[${label}] ${finalText}`);
  }
  console.log(`[review-manager] chat=${flow.chatId} draft ${draftId} sent (${source})`);
  await draftNext(flow);
}

async function completeSkip(flow: ChatFlow, draftId: string): Promise<void> {
  const draft = await DraftModel.findById(draftId).exec();
  if (!draft || draft.status !== 'pending') {
    return;
  }
  draft.status = 'skipped';
  await draft.save();
  clearTimer(flow);
  if (flow.pendingNotificationMessageId !== null) {
    await editDraftNotification(flow.pendingNotificationMessageId, `[Skipped] ${draft.draftText}`);
  }
  console.log(`[review-manager] chat=${flow.chatId} draft ${draftId} skipped`);
  await draftNext(flow);
}

async function handleCallback(action: ReviewAction, draftId: string): Promise<void> {
  const flow = findFlowForDraft(draftId);
  if (!flow || flow.pendingDraftId !== draftId || flow.status !== 'awaiting') {
    console.log(`[review-manager] action ${action} for stale draft ${draftId} ignored`);
    return;
  }

  if (action === 'edit') {
    if (editingChatId !== null) {
      console.log(`[review-manager] edit refused — already editing in chat ${editingChatId}`);
      return;
    }
    clearTimer(flow);
    flow.status = 'editing';
    editingChatId = flow.chatId;
    return;
  }

  if (action === 'send') {
    await completeSend(flow, draftId, null, 'send');
  } else if (action === 'skip') {
    await completeSkip(flow, draftId);
  }
}

async function handleOwnerText(text: string): Promise<void> {
  if (!editingChatId) {
    return;
  }
  const flow = flows.get(editingChatId);
  editingChatId = null;
  if (!flow || flow.status !== 'editing' || !flow.pendingDraftId) {
    return;
  }
  await completeSend(flow, flow.pendingDraftId, text, 'edit');
}

export async function handleIncoming(info: IncomingMessageInfo): Promise<void> {
  const flow = getFlow(info.chatId, info.peerUsername);

  if (!(await isAllowedChat(info.chatId))) {
    console.log(`[review-manager] chat=${info.chatId} not in allow-list — ignored`);
    return;
  }

  await appendIncomingMessage(info.chatId, info.peerUsername, info.text, info.timestamp);

  if (flow.status === 'idle') {
    flow.status = 'drafting';
    try {
      const drafted = await draftReply(info);
      flow.pendingDraftId = drafted.draftId;
      flow.pendingNotificationMessageId = drafted.notificationMessageId;
      flow.status = 'awaiting';
      await scheduleAutoSend(flow);
    } catch (err) {
      console.error(`[review-manager] chat=${info.chatId} draft failed:`, err);
      flow.status = 'idle';
      flow.pendingDraftId = null;
      flow.pendingNotificationMessageId = null;
    }
    return;
  }

  flow.queuedLatest = { text: info.text, timestamp: info.timestamp };
  console.log(`[review-manager] chat=${info.chatId} busy (${flow.status}); queued latest message`);
}

export function initReviewManager(): void {
  if (managerInitialized) {
    return;
  }
  managerInitialized = true;
  setReviewHandlers({
    onCallbackQuery: (action, draftId) => handleCallback(action, draftId),
    onOwnerText: (text) => handleOwnerText(text),
  });
  console.log('[review-manager] handlers registered with review bot');
}
