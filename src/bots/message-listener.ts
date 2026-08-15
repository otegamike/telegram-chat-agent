import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { createTelegramClient, connectWithSession } from '../services/telegram-client';
import { syncChatDirectory } from '../services/telegram-chats';
import { connectDb } from '../services/db';
import { processIncomingMessage } from '../services/pipeline';

interface SenderInfo {
  bot?: boolean;
  username?: string;
  firstName?: string;
  id?: { toString(): string };
}

export async function startMessageListener(): Promise<void> {
  const client = createTelegramClient();

  client.addEventHandler(
    async (event: NewMessageEvent) => {
      if (!event.isPrivate || event.isGroup || event.isChannel) {
        return;
      }

      const sender = (await event.message.getSender()) as SenderInfo | undefined;
      if (sender?.bot) {
        return;
      }

      const chatId = event.chatId?.toString();
      const text = event.message.text;
      if (!chatId || !text) {
        const nonText = text ? text : '(non-text message)';
        console.log(`[listener] chat=${event.chatId?.toString()} (non-draftable message ${nonText}); ignored`);
        return;
      }

      const senderLabel =
        sender?.username ?? sender?.firstName ?? sender?.id?.toString() ?? 'unknown';
      console.log(`[listener] chat=${chatId} sender=${senderLabel}: "${text}"`);

      try {
        await processIncomingMessage({
          chatId,
          peerUsername: sender?.username ?? senderLabel,
          text,
          timestamp: event.message.date ? new Date(event.message.date * 1000) : new Date(),
        });
      } catch (err) {
        console.error('[listener] pipeline error (continuing):', err);
      }
    },
    new NewMessage({ incoming: true })
  );

  try {
    await connectWithSession(client);
    const me = await client.getMe();
    console.log(`[listener] connected as @${(me as { username?: string }).username ?? me.id}`);

    if (process.env.MONGODB_URI) {
      await connectDb();
      try {
        const count = await syncChatDirectory(client);
        console.log(`[listener] synced ${count} chats into the chat directory`);
      } catch (err) {
        console.error('[listener] chat directory sync failed (continuing anyway):', err);
      }
    } else {
      console.warn('[listener] MONGODB_URI not set - skipping chat directory sync');
    }
  } catch (err) {
    console.error('[listener] failed to connect:', err);
    throw err;
  }

  console.log('[listener] listening for private 1-on-1 messages (groups/channels/bots ignored)...');
}