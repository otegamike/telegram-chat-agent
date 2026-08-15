import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';

const STATIC_REPLY = 'Review bot online. Drafted replies will show up here for approval.';

let bot: TelegramBot | null = null;
let ownerChatId: number | null = null;

export interface DraftNotification {
  chatId: string;
  senderName: string;
  incomingMessage: string;
  draftText: string;
  draftId: string;
}

export function sendDraftNotification(notification: DraftNotification): void {
  if (!bot || !ownerChatId) {
    throw new Error('Review bot not started — cannot send draft notification');
  }

  const text = [
    `@${notification.senderName} (${notification.chatId})`,
    '',
    `Incoming:`,
    `"${notification.incomingMessage}"`,
    '',
    `Draft:`,
    `"${notification.draftText}"`,
  ].join('\n');

  bot
    .sendMessage(ownerChatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '\u2705 Send', callback_data: `send:${notification.draftId}` },
            { text: '\u270f\ufe0f Edit', callback_data: `edit:${notification.draftId}` },
            { text: '\u274c Skip', callback_data: `skip:${notification.draftId}` },
          ],
        ],
      },
    })
    .catch((err) => {
      console.error('[review-bot] failed to send draft notification:', err);
    });
}

export function startReviewBot(): void {
  const token = process.env.REVIEW_BOT_TOKEN;
  const ownerChatIdRaw = process.env.REVIEW_BOT_OWNER_CHAT_ID;

  if (!token) {
    throw new Error('REVIEW_BOT_TOKEN is not set in .env');
  }
  if (!ownerChatIdRaw || !/^\d+$/.test(ownerChatIdRaw)) {
    throw new Error('REVIEW_BOT_OWNER_CHAT_ID must be a numeric chat id in .env');
  }
  ownerChatId = Number(ownerChatIdRaw);

  bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    const senderId = msg.from?.id;
    const senderName =
      msg.from?.username ?? msg.from?.first_name ?? msg.from?.last_name ?? 'unknown';
    console.log(
      `[review-bot] message from ${senderName} (id=${senderId}): "${msg.text ?? '(non-text)'}"`
    );

    if (senderId !== ownerChatId) {
      return;
    }

    if (msg.text?.trim() === '/start') {
      try {
        await bot!.sendMessage(ownerChatId, STATIC_REPLY);
        console.log('[review-bot] message sent to owner');
      } catch (err) {
        console.error('[review-bot] failed to reply to /start:', err);
      }
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[review-bot] polling_error:', err.message ?? err);
  });

  bot.on('error', (err) => {
    console.error('[review-bot] error:', err.message ?? err);
  });

  console.log('[review-bot] started in polling mode, waiting for messages...');
}