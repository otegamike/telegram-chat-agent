import { TelegramClient } from 'telegram';
import { TelegramChatModel } from '../models/TelegramChat';
import { isConnected } from './db';

interface ChatUserEntity {
  id: { toString(): string };
  bot?: boolean;
  username?: string;
  firstName?: string;
  lastName?: string;
}

interface ChatDialog {
  isUser?: boolean;
  entity?: ChatUserEntity;
}

const DIALOG_LIMIT = 100;

function displayName(entity: ChatUserEntity, chatId: string): string {
  if (entity.username) {
    return `@${entity.username}`;
  }
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  return name || chatId;
}

export async function syncChatDirectory(client: TelegramClient): Promise<number> {
  if (!isConnected()) {
    throw new Error('MongoDB not connected — cannot sync chat directory');
  }

  const dialogs = (await client.getDialogs({ limit: DIALOG_LIMIT })) as ChatDialog[];
  const now = new Date();
  const ops = dialogs
    .filter((d) => d.isUser === true && d.entity && !d.entity.bot)
    .map((d) => {
      const chatId = d.entity!.id.toString();
      return {
        updateOne: {
          filter: { chatId },
          update: {
            $set: {
              username: d.entity!.username ?? '',
              displayName: displayName(d.entity!, chatId),
              type: 'private',
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          upsert: true,
        },
      };
    });

  if (ops.length === 0) {
    return 0;
  }

  const result = await TelegramChatModel.bulkWrite(ops);
  return result.upsertedCount + result.modifiedCount;
}