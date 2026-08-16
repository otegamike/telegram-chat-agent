import { TelegramClient } from 'telegram';

let client: TelegramClient | null = null;

export function registerClient(telegramClient: TelegramClient): void {
  client = telegramClient;
}

export async function sendAsUser(chatId: string, message: string): Promise<void> {
  if (!client) {
    throw new Error('Telegram client not registered — cannot send as user');
  }
  await client.sendMessage(chatId, { message });
}

export async function markChatAsRead(chatId: string): Promise<void> {
  if (!client) {
    throw new Error('Telegram client not registered — cannot mark chat as read');
  }
  await client.markAsRead(chatId);
}