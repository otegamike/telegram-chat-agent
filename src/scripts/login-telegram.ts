import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

async function main(): Promise<void> {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiIdRaw || !/^\d+$/.test(apiIdRaw)) {
    throw new Error('TELEGRAM_API_ID must be a numeric id in .env');
  }
  const apiId = Number(apiIdRaw);
  if (!apiHash) {
    throw new Error('TELEGRAM_API_HASH is not set in .env');
  }

  const existingSession = process.env.TELEGRAM_SESSION_STRING;
  console.log(
    existingSession
      ? 'Using existing session from TELEGRAM_SESSION_STRING...'
      : 'No session string yet, starting fresh login...'
  );

  const rl = createInterface({ input, output });

  const client = new TelegramClient(
    new StringSession(existingSession ?? ''),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  try {
    await client.start({
      phoneNumber: async () => {
        const answer = await rl.question('Phone number (international format, e.g. +1234567890): ');
        return answer.trim();
      },
      phoneCode: async (isCodeViaApp) => {
        const answer = await rl.question(
          `Code from Telegram (${isCodeViaApp ? 'sent in the app' : 'via SMS'}): `
        );
        return answer.trim();
      },
      password: async (hint) => {
        const answer = await rl.question(
          hint ? `2FA password (hint: "${hint}"): ` : '2FA password: '
        );
        return answer.trim();
      },
      onError: (err) => {
        console.error('[login] error:', err);
      },
    });

    const sessionString = client.session.save();
    console.log('\nLogin OK.');
    console.log('Add this exact value to your .env as TELEGRAM_SESSION_STRING (never commit it):');
    console.log('\n' + sessionString + '\n');
    console.log('Add the same value to the phone .env when you set that up.');

    try {
      await client.sendMessage('me', { message: 'Telegram chat-agent logged in OK via GramJS.' });
      console.log('(Sent a confirmation message to your Saved Messages.)');
    } catch (err) {
      console.error('[login] warning: could not send confirmation message:', err);
    }
  } finally {
    rl.close();
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
