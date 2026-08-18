import { foldCorrections, CorrectionInput } from './llm';
import { resolveMasterPrompt } from './master-prompt';

let queue: Promise<void> = Promise.resolve();

export interface CorrectionLearningInput extends CorrectionInput {
  chatId: string;
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((err) => {
    console.error('[corrections] learning task failed (swallowed, non-blocking):', err);
  });
}

export function learnFromCorrection(input: CorrectionLearningInput): void {
  void (async () => {
    enqueue(async () => {
      const prompt = await resolveMasterPrompt(input.chatId);
      const updated = await foldCorrections(
        prompt.correctionsBlock ?? '',
        {
          incomingMessage: input.incomingMessage,
          draftText: input.draftText,
          correctedText: input.correctedText,
        },
        { chatId: input.chatId }
      );
      if (!updated) {
        return;
      }
      prompt.correctionsBlock = updated;
      prompt.updatedAt = new Date();
      await prompt.save();
      console.log(
        `[corrections] chat=${input.chatId} folded correction into prompt "${prompt.key}"`
      );
    });
  })();
}
