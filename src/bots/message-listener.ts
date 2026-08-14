import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';

interface SenderInfo {
  bot?: boolean;
  username?: string;
  firstName?: string;
  id?: { toString(): string };
}

export async function startMessageListener(): Promise<void> {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION_STRING;

  if (!apiIdRaw || !/^\d+$/.test(apiIdRaw)) {
    throw new Error('TELEGRAM_API_ID must be a numeric id in .env');
  }
  const apiId = Number(apiIdRaw);
  if (!apiHash) {
    throw new Error('TELEGRAM_API_HASH is not set in .env');
  }
  if (!sessionString) {
    throw new Error('TELEGRAM_SESSION_STRING is not set in .env (run npm run login first)');
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  client.addEventHandler(
    async (event: NewMessageEvent) => {
      if (!event.isPrivate || event.isGroup || event.isChannel) {
        return;
      }

      const sender = (await event.message.getSender()) as SenderInfo | undefined;
      if (sender?.bot) {
        return;
      }

      const senderLabel = sender?.username ?? sender?.firstName ?? sender?.id?.toString() ?? 'unknown';
      const text = event.message.text ?? '(non-text message)';
      console.log(`[listener] chat=${event.chatId?.toString()} sender=${senderLabel}: "${text}"`);
    },
    new NewMessage({ incoming: true })
  );

  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error('TELEGRAM_SESSION_STRING is not authorized — re-run `npm run login`');
  }
  const me = await client.getMe();
  console.log(`[listener] connected as @${(me as { username?: string }).username ?? me.id}`);
  console.log('[listener] listening for private 1-on-1 messages (groups/channels/bots ignored)...');
}
