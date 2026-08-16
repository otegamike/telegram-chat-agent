import cron from 'node-cron';
import { ConversationModel } from '../models/Conversation';
import { mergeDuplicateTopics, TopicEntry } from './llm';

const ARCHIVE_DAYS = 90;
const ARCHIVE_MS = ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
const CRON_SCHEDULE = process.env.MAINTENANCE_CRON || '0 3 * * *';

let running = false;
let scheduled = false;

export function scheduleTopicMaintenance(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  cron.schedule(CRON_SCHEDULE, () => {
    runTopicMaintenance().catch((err) => {
      console.error('[maintenance] scheduled run failed:', err);
    });
  });
  console.log(`[maintenance] scheduled daily topic maintenance (cron: ${CRON_SCHEDULE})`);
}

export async function maintainConversationTopics(
  doc: InstanceType<typeof ConversationModel>,
  now: number = Date.now()
): Promise<{ merged: boolean; archived: boolean }> {
  const topics = (doc.topics as unknown as TopicEntry[] | undefined) ?? [];
  if (topics.length === 0) {
    return { merged: false, archived: false };
  }

  let merged = false;
  let next: TopicEntry[] = topics;
  if (topics.length >= 2) {
    try {
      const result = await mergeDuplicateTopics(topics);
      if (result.length !== topics.length) {
        merged = true;
        next = result;
      }
    } catch (err) {
      console.error('[maintenance] topic merge failed:', err);
    }
  }

  let archived = false;
  const cutoff = now - ARCHIVE_MS;
  next = next.map((t) => {
    if (!t.archived && t.lastMentioned.getTime() < cutoff) {
      archived = true;
      return { ...t, archived: true };
    }
    return t;
  });

  if (merged || archived) {
    doc.topics = next as never;
    doc.lastUpdated = new Date();
    await doc.save();
  }
  return { merged, archived };
}

export async function runTopicMaintenance(): Promise<void> {
  if (running) {
    console.log('[maintenance] already running — skipping this pass');
    return;
  }
  running = true;
  const now = Date.now();
  const docs = await ConversationModel.find().exec();
  let mergedCount = 0;
  let archivedCount = 0;
  try {
    for (const doc of docs) {
      const result = await maintainConversationTopics(doc, now);
      if (result.merged) {
        mergedCount += 1;
      }
      if (result.archived) {
        archivedCount += 1;
      }
    }
    console.log(
      `[maintenance] done — ${docs.length} conversations, ${mergedCount} merged, ${archivedCount} archived`
    );
  } finally {
    running = false;
  }
}