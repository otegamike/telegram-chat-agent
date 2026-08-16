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

export type ReviewAction = 'send' | 'edit' | 'skip';

export interface ReviewHandlers {
  onCallbackQuery: (action: ReviewAction, draftId: string) => Promise<void>;
  onOwnerText: (text: string) => Promise<void>;
}

let reviewHandlers: ReviewHandlers | null = null;

export function setReviewHandlers(handlers: ReviewHandlers): void {
  reviewHandlers = handlers;
}

function notificationText(notification: DraftNotification): string {
  return [
    `@${notification.senderName} (${notification.chatId})`,
    '',
    `Incoming:`,
    `"${notification.incomingMessage}"`,
    '',
    `Draft:`,
    `"${notification.draftText}"`,
  ].join('\n');
}

export async function sendDraftNotification(
  notification: DraftNotification
): Promise<number | null> {
  if (!bot || !ownerChatId) {
    throw new Error('Review bot not started — cannot send draft notification');
  }
  const message = await bot.sendMessage(ownerChatId, notificationText(notification), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '\u2705 Send', callback_data: `send:${notification.draftId}` },
          { text: '\u270f\ufe0f Edit', callback_data: `edit:${notification.draftId}` },
          { text: '\u274c Skip', callback_data: `skip:${notification.draftId}` },
        ],
      ],
    },
  });
  return message.message_id ?? null;
}

export async function editDraftNotification(
  messageId: number | null,
  text: string
): Promise<void> {
  if (!bot || !ownerChatId || messageId === null) {
    return;
  }
  try {
    await bot.editMessageText(text, {
      chat_id: ownerChatId,
      message_id: messageId,
    });
  } catch (err) {
    console.error('[review-bot] failed to edit draft notification:', err);
  }
}

export async function sendEditPrompt(
  text: string,
  replyToMessageId: number | null
): Promise<void> {
  if (!bot || !ownerChatId) {
    return;
  }
  try {
    await bot.sendMessage(ownerChatId, text, {
      ...(replyToMessageId !== null ? { reply_to_message_id: replyToMessageId } : {}),
      reply_markup: { force_reply: true },
    });
  } catch (err) {
    console.error('[review-bot] failed to send edit prompt:', err);
  }
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

    const text = msg.text?.trim();
    if (!text) {
      return;
    }

    if (text === '/start') {
      try {
        await bot!.sendMessage(ownerChatId, STATIC_REPLY);
        console.log('[review-bot] message sent to owner');
      } catch (err) {
        console.error('[review-bot] failed to reply to /start:', err);
      }
      return;
    }

    if (reviewHandlers) {
      try {
        await reviewHandlers.onOwnerText(text);
      } catch (err) {
        console.error('[review-bot] onOwnerText handler error:', err);
        try {
          await bot!.sendMessage(ownerChatId, `[error] ${String(err)}`);
        } catch {
          /* ignore */
        }
      }
    }
  });

  bot.on('callback_query', async (query) => {
    const fromId = query.from?.id;
    if (fromId !== ownerChatId) {
      try {
        await bot!.answerCallbackQuery(query.id, { text: 'Not authorized' });
      } catch {
        /* ignore */
      }
      return;
    }

    const data = query.data ?? '';
    const [action, draftId] = data.split(':');
    if (
      (action === 'send' || action === 'edit' || action === 'skip') &&
      draftId
    ) {
      try {
        await bot!.answerCallbackQuery(query.id);
        if (reviewHandlers) {
          await reviewHandlers.onCallbackQuery(action, draftId);
        }
      } catch (err) {
        console.error('[review-bot] callback handler error:', err);
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