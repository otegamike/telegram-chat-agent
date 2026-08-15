import 'dotenv/config';
import { createTelegramClient, connectWithSession } from '../services/telegram-client';
import { syncChatDirectory } from '../services/telegram-chats';
import { connectDb, disconnectDb } from '../services/db';

async function main(): Promise<void> {
  await connectDb();
  const client = createTelegramClient();
  try {
    await connectWithSession(client);
    const me = await client.getMe();
    console.log(`Connected as @${(me as { username?: string }).username ?? me.id}`);
    const count = await syncChatDirectory(client);
    console.log(`Synced ${count} private chats into the chat directory.`);
  } finally {
    await client.disconnect();
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});