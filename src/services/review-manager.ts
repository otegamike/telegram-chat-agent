import { DraftModel } from '../models/Draft';
import { ChatConfigModel } from '../models/ChatConfig';
import { setReviewHandlers, editDraftNotification, sendEditPrompt, sendDraftNotification, ReviewAction } from '../bots/review-bot';
import { appendIncomingMessage, appendSentMessage, draftReply, IncomingMessageInfo } from './pipeline';
import { getSettings } from './settings';
import { learnFromCorrection } from './corrections';
import { sendAsUser, markChatAsRead } from './telegram-sender';

type FlowStatus = 'idle' | 'drafting' | 'awaiting' | 'editing';

const EDIT_TIMEOUT_MS =
  Number.isFinite(Number(process.env.EDIT_TIMEOUT_MS)) && Number(process.env.EDIT_TIMEOUT_MS) > 0
    ? Number(process.env.EDIT_TIMEOUT_MS)
    : 180000;

interface ChatFlow {
  chatId: string;
  peerUsername: string;
  status: FlowStatus;
  pendingDraftId: string | null;
  pendingNotificationMessageId: number | null;
  timer: NodeJS.Timeout | null;
  editTimer: NodeJS.Timeout | null;
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
      editTimer: null,
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

function clearEditTimer(flow: ChatFlow): void {
  if (flow.editTimer) {
    clearTimeout(flow.editTimer);
    flow.editTimer = null;
  }
}

function isEditingThisChat(flow: ChatFlow): boolean {
  return flow.status === 'editing' && editingChatId === flow.chatId;
}

function releaseEditing(flow: ChatFlow): void {
  clearEditTimer(flow);
  if (editingChatId === flow.chatId) {
    editingChatId = null;
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

async function recycleFlow(flow: ChatFlow): Promise<void> {
  releaseEditing(flow);
  clearTimer(flow);
  flow.status = 'idle';
  flow.pendingDraftId = null;
  flow.pendingNotificationMessageId = null;
  await draftNext(flow);
}

async function completeSend(
  flow: ChatFlow,
  draftId: string,
  editedText: string | null,
  source: 'send' | 'edit' | 'auto'
): Promise<void> {
  const draft = await DraftModel.findById(draftId).exec();
  if (!draft || draft.status !== 'pending') {
    console.log(`[review-manager] chat=${flow.chatId} draft ${draftId} not pending — ${source} aborted`);
    if (isEditingThisChat(flow) || flow.pendingDraftId === draftId) {
      await recycleFlow(flow);
    }
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
  await appendSentMessage(flow.chatId, finalText, {
    correctedFrom: editedText !== null ? draft.draftText : null,
  });
  if (editedText !== null) {
    learnFromCorrection({
      chatId: flow.chatId,
      incomingMessage: draft.incomingMessage,
      draftText: draft.draftText,
      correctedText: finalText,
    });
  }

  releaseEditing(flow);
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
    console.log(`[review-manager] chat=${flow.chatId} draft ${draftId} not pending — skip aborted`);
    if (isEditingThisChat(flow) || flow.pendingDraftId === draftId) {
      await recycleFlow(flow);
    }
    return;
  }
  draft.status = 'skipped';
  await draft.save();
  releaseEditing(flow);
  clearTimer(flow);
  if (flow.pendingNotificationMessageId !== null) {
    await editDraftNotification(flow.pendingNotificationMessageId, `[Skipped] ${draft.draftText}`);
  }
  console.log(`[review-manager] chat=${flow.chatId} draft ${draftId} skipped`);
  await draftNext(flow);
}

async function enterEditing(flow: ChatFlow, draftId: string): Promise<void> {
  const draft = await DraftModel.findById(draftId).exec();
  if (!draft || draft.status !== 'pending') {
    console.log(`[review-manager] chat=${flow.chatId} edit aborted — draft ${draftId} not pending`);
    await recycleFlow(flow);
    return;
  }
  clearTimer(flow);
  flow.status = 'editing';
  editingChatId = flow.chatId;
  flow.pendingDraftId = draftId;
  if (flow.pendingNotificationMessageId !== null) {
    await editDraftNotification(
      flow.pendingNotificationMessageId,
      `[Editing] Auto-send paused. Send your corrected text (or /skip to move on).`
    );
  }
  await sendEditPrompt(
    `Editing draft for chat @${flow.peerUsername || flow.chatId}:\n\n"${draft.draftText}"\n\nReply with your corrected text, or send /skip to move on.`,
    flow.pendingNotificationMessageId
  );
  console.log(`[review-manager] chat=${flow.chatId} editing draft ${draftId} — awaiting corrected text`);
  clearEditTimer(flow);
  flow.editTimer = setTimeout(() => {
    void editTimedOut(flow);
  }, EDIT_TIMEOUT_MS);
}

async function editTimedOut(flow: ChatFlow): Promise<void> {
  flow.editTimer = null;
  if (flow.status !== 'editing') {
    return;
  }
  console.log(
    `[review-manager] chat=${flow.chatId} edit timed out after ${EDIT_TIMEOUT_MS}ms — skipping pending draft`
  );
  const draftId = flow.pendingDraftId;
  if (draftId) {
    await completeSkip(flow, draftId);
  } else {
    await recycleFlow(flow);
  }
}

async function handleCallback(action: ReviewAction, draftId: string): Promise<void> {
  const flow = findFlowForDraft(draftId);
  if (!flow || flow.pendingDraftId !== draftId || flow.status !== 'awaiting') {
    console.log(`[review-manager] action ${action} for stale draft ${draftId} ignored`);
    return;
  }

  if (action === 'edit') {
    if (editingChatId !== null) {
      if (editingChatId === flow.chatId) {
        console.log(`[review-manager] chat=${flow.chatId} edit clicked again — already editing`);
      } else {
        console.log(
          `[review-manager] edit refused for chat=${flow.chatId} — already editing in chat ${editingChatId}`
        );
      }
      return;
    }
    await enterEditing(flow, draftId);
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
  if (!flow || flow.status !== 'editing' || !flow.pendingDraftId) {
    editingChatId = null;
    return;
  }

  if (text.trim().toLowerCase() === '/skip') {
    console.log(`[review-manager] chat=${flow.chatId} owner requested skip while editing`);
    const draftId = flow.pendingDraftId;
    await completeSkip(flow, draftId);
    return;
  }

  const draftId = flow.pendingDraftId;
  await completeSend(flow, draftId, text, 'edit');
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

export async function resumePendingDrafts(): Promise<number> {
  const raw = process.env.RESUME_PENDING_DRAFTS;
  if (raw === '0' || raw === 'false' || raw === 'False') {
    console.log('[review-manager] pending-draft resume disabled via RESUME_PENDING_DRAFTS');
    return 0;
  }

  const drafts = await DraftModel.find({ status: 'pending' })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  if (drafts.length === 0) {
    return 0;
  }

  const newestByChat = new Map<string, (typeof drafts)[number]>();
  const superseded: string[] = [];
  for (const d of drafts) {
    const existing = newestByChat.get(d.chatId);
    if (!existing) {
      newestByChat.set(d.chatId, d);
    } else {
      superseded.push(String(d._id));
    }
  }

  if (superseded.length > 0) {
    await DraftModel.updateMany(
      { _id: { $in: superseded }, status: 'pending' },
      { $set: { status: 'skipped' } }
    ).exec();
    console.log(`[review-manager] marked ${superseded.length} superseded pending draft(s) as skipped`);
  }

  let resumed = 0;
  for (const draft of newestByChat.values()) {
    const chatId = draft.chatId;
    const config = await ChatConfigModel.findOne({ chatId }).lean().exec();
    if (!config || !config.autoReplyEnabled) {
      await DraftModel.updateOne(
        { _id: draft._id },
        { $set: { status: 'skipped' } }
      ).exec();
      console.log(`[review-manager] pending draft ${draft._id} skipped — chat ${chatId} not in allow-list`);
      continue;
    }

    const peerUsername = config.peerUsername || '';
    const flow = getFlow(chatId, peerUsername);
    flow.status = 'awaiting';
    flow.pendingDraftId = String(draft._id);
    flow.pendingNotificationMessageId = null;

    try {
      const notificationMessageId = await sendDraftNotification({
        chatId,
        senderName: peerUsername || chatId,
        incomingMessage: draft.incomingMessage,
        draftText: draft.draftText,
        draftId: String(draft._id),
      });
      flow.pendingNotificationMessageId = notificationMessageId;
      await scheduleAutoSend(flow);
      resumed += 1;
      console.log(
        `[review-manager] resumed pending draft ${draft._id} for chat ${chatId} (${peerUsername || chatId})`
      );
    } catch (err) {
      console.error(`[review-manager] failed to notify resumed draft ${draft._id} (continuing):`, err);
    }
  }

  return resumed;
}
