import 'dotenv/config';
import { createTelegramClient, connectWithSession } from '../services/telegram-client';
import { connectDb } from '../services/db';
import { registerClient } from '../services/telegram-sender';
import { catchUpUnread } from '../services/catch-up';

async function main(): Promise<void> {
  await connectDb();
  const client = createTelegramClient();
  try {
    await connectWithSession(client);
    registerClient(client);
    const processed = await catchUpUnread(client);
    console.log(`[run-catch-up] processed ${processed} unread message(s)`);
  } finally {
    await client.disconnect();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[run-catch-up] failed:', err);
  process.exit(1);
});