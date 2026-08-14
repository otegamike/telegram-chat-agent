import { startReviewBot } from './bots/review-bot';
import { startMessageListener } from './bots/message-listener';

startReviewBot();

if (
  process.env.TELEGRAM_API_ID &&
  process.env.TELEGRAM_API_HASH &&
  process.env.TELEGRAM_SESSION_STRING
) {
  startMessageListener().catch((err) => {
    console.error('[index] message listener failed to start:', err);
  });
} else {
  console.warn(
    '[index] TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING not fully set - ' +
      'message listener skipped. Run `npm run login` to set up the session.'
  );
}
