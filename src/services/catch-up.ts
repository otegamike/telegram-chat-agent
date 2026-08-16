import { TelegramClient } from 'telegram';
import { ChatConfigModel } from '../models/ChatConfig';
import { handleIncoming } from './review-manager';
import { isConnected } from './db';

interface MessageLike {
  id?: number;
  out?: boolean;
  message?: string;
  date?: number;
}

interface DialogLike {
  id?: { toString(): string };
  dialog?: { readInboxMaxId?: number; topMessage?: number };
  isUser?: boolean;
  entity?: { bot?: boolean };
  name?: string;
}

const DEFAULT_MESSAGE_LIMIT = 25;
const DEFAULT_MAX_AGE_HOURS = 168;

export function catchUpEnabled(): boolean {
  const raw = process.env.CATCHUP_ENABLED;
  if (raw === undefined || raw === '') {
    return true;
  }
  return raw === '1' || raw === 'true';
}

export function catchUpMessageLimit(): number {
  const n = Number(process.env.CATCHUP_MESSAGE_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MESSAGE_LIMIT;
}

function maxAgeMs(): number | null {
  const n = Number(process.env.CATCHUP_MAX_AGE_HOURS);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n * 60 * 60 * 1000;
}

async function loadAllowedChats(): Promise<Array<{ chatId: string; peerUsername: string }>> {
  const configs = await ChatConfigModel.find({ autoReplyEnabled: true })
    .select('chatId peerUsername')
    .lean()
    .exec();
  return configs.map((c) => ({
    chatId: String(c.chatId),
    peerUsername: c.peerUsername || '',
  }));
}

async function buildReadBoundary(
  client: TelegramClient
): Promise<Map<string, { readInboxMaxId: number; topMessage: number }>> {
  const boundaries = new Map<string, { readInboxMaxId: number; topMessage: number }>();
  const dialogs = (await client.getDialogs({ limit: 200 })) as unknown as DialogLike[];
  for (const d of dialogs) {
    if (!d.isUser || !d.entity || d.entity.bot) {
      continue;
    }
    const chatId = d.id?.toString();
    if (!chatId) {
      continue;
    }
    const readInboxMaxId = d.dialog?.readInboxMaxId;
    const topMessage = d.dialog?.topMessage;
    if (typeof readInboxMaxId === 'number') {
      boundaries.set(chatId, { readInboxMaxId, topMessage: typeof topMessage === 'number' ? topMessage : readInboxMaxId });
    }
  }
  return boundaries;
}

async function recordWatermark(chatId: string, messageId: number): Promise<void> {
  await ChatConfigModel.updateOne(
    { chatId },
    { $max: { lastProcessedMessageId: messageId } }
  ).exec();
}

export async function catchUpUnread(client: TelegramClient): Promise<number> {
  if (!catchUpEnabled()) {
    console.log('[catch-up] disabled via CATCHUP_ENABLED - skipping');
    return 0;
  }
  if (!isConnected()) {
    throw new Error('MongoDB not connected - cannot run catch-up');
  }

  const chats = await loadAllowedChats();
  if (chats.length === 0) {
    console.log('[catch-up] no allow-listed chats with auto-reply enabled - nothing to do');
    return 0;
  }

  const boundaries = await buildReadBoundary(client);
  const limit = catchUpMessageLimit();
  const maxAge = maxAgeMs();
  const cutoff = maxAge !== null ? Date.now() - maxAge : null;
  let processed = 0;

  for (const chat of chats) {
    const boundary = boundaries.get(chat.chatId);
    if (boundary === undefined) {
      console.log(`[catch-up] chat=${chat.chatId} not in dialog list - skipping`);
      continue;
    }

    const config = await ChatConfigModel.findOne({ chatId: chat.chatId }).lean().exec();
    let watermark: number | null = null;
    if (config && typeof config.lastProcessedMessageId === 'number') {
      watermark = config.lastProcessedMessageId;
    }

    let floor: number;
    if (watermark === null) {
      floor = boundary.topMessage;
      await recordWatermark(chat.chatId, boundary.topMessage);
    } else {
      floor = Math.max(watermark, boundary.readInboxMaxId);
    }

    let messages: MessageLike[] = [];
    try {
      messages = (await client.getMessages(chat.chatId, { limit })) as unknown as MessageLike[];
    } catch (err) {
      console.error(`[catch-up] chat=${chat.chatId} getMessages failed (continuing):`, err);
      continue;
    }

    const incoming = messages
      .filter(
        (m) =>
          !m.out &&
          typeof m.message === 'string' &&
          m.message.trim().length > 0 &&
          typeof m.id === 'number' &&
          m.id > floor &&
          (cutoff === null || !m.date || m.date * 1000 >= cutoff)
      )
      .sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0));

    if (incoming.length === 0) {
      continue;
    }

    console.log(
      `[catch-up] chat=${chat.chatId} caught ${incoming.length} unread message(s) >
      watermark=${floor}`
    );

    for (const m of incoming) {
      try {
        await handleIncoming({
          chatId: chat.chatId,
          peerUsername: chat.peerUsername,
          text: m.message!.trim(),
          timestamp: new Date((m.date ?? Date.now() / 1000) * 1000),
        });
        if (typeof m.id === 'number') {
          await recordWatermark(chat.chatId, m.id);
        }
        processed += 1;
      } catch (err) {
        console.error(
          `[catch-up] chat=${chat.chatId} message ${m.id} failed (continuing):`,
          err
        );
      }
    }
  }

  console.log(`[catch-up] done - processed ${processed} unread message(s) across ${chats.length} chat(s)`);
  return processed;
}