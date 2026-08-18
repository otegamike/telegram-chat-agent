import { AiLogModel } from '../models/AiLog';

const LOG_LIMIT =
  Number.isFinite(Number(process.env.AI_LOG_LIMIT)) && Number(process.env.AI_LOG_LIMIT) > 0
    ? Math.floor(Number(process.env.AI_LOG_LIMIT))
    : 500;

export interface AiLogInput {
  kind: 'draft' | 'fold' | 'merge' | 'correction';
  chatId?: string | null;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  reply?: string | null;
  error?: string | null;
  durationMs: number;
}

export function recordAiCall(input: AiLogInput): void {
  void (async () => {
    try {
      await AiLogModel.create({
        kind: input.kind,
        chatId: input.chatId ?? null,
        model: input.model,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        reply: input.reply ?? null,
        error: input.error ?? null,
        durationMs: input.durationMs,
        createdAt: new Date(),
      });
      await trimAiLogs();
    } catch (err) {
      console.error('[ai-log] failed to record (swallowed, non-blocking):', err);
    }
  })();
}

async function trimAiLogs(): Promise<void> {
  try {
    const count = await AiLogModel.estimatedDocumentCount();
    if (count <= LOG_LIMIT) {
      return;
    }
    const excess = count - LOG_LIMIT;
    const oldest = await AiLogModel.find()
      .sort({ createdAt: 1 })
      .limit(excess)
      .select('_id')
      .lean()
      .exec();
    if (oldest.length > 0) {
      await AiLogModel.deleteMany({ _id: { $in: oldest.map((d) => d._id) } }).exec();
    }
  } catch (err) {
    console.error('[ai-log] trim failed (swallowed, non-blocking):', err);
  }
}
