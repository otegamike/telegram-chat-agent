import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export function createTelegramClient(): TelegramClient {
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

  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
}

export async function connectWithSession(client: TelegramClient): Promise<void> {
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error('TELEGRAM_SESSION_STRING is not authorized — re-run `npm run login`');
  }
}