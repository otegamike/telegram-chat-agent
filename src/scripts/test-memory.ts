import 'dotenv/config';
import { connectDb, disconnectDb } from '../services/db';
import { ConversationModel } from '../models/Conversation';
import { appendIncomingMessage } from '../services/pipeline';
import { selectTopicsForContext } from '../services/topics';
import { maintainConversationTopics } from '../services/maintenance';
import { mergeDuplicateTopics, TopicEntry } from '../services/llm';

const CHAT_ID = `test-memory-${Date.now()}`;
const SCHOOL = 'School project is due next week, can you help me study for the exam soon?';
const FOOTBALL = 'The football match was great yesterday, we won three nil at the stadium.';
const VAGUE = 'did that end up happening?';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

async function main(): Promise<void> {
  await connectDb();

  await ConversationModel.deleteMany({ chatId: { $regex: '^test-memory' } }).exec();

  console.log('[1] append 25 messages alternating school/football (expect cap at 20)...');
  const base = Date.now() - 25 * 60 * 1000;
  for (let i = 0; i < 25; i += 1) {
    const text = i % 3 === 0 ? SCHOOL : FOOTBALL;
    await appendIncomingMessage(CHAT_ID, 'test_memory_peer', text, new Date(base + i * 60 * 1000));
  }

  const conv = await ConversationModel.findOne({ chatId: CHAT_ID }).exec();
  check('messages capped at 20', !!conv && conv.messages.length === 20, `len=${conv?.messages.length}`);
  const topics = ((conv?.topics as unknown as TopicEntry[]) ?? []);
  check('topics has >= 2 distinct entries', topics.length >= 2, `topics=${topics.length}`);
  const blob = topics.map((t) => `${t.label} ${t.summary}`.toLowerCase()).join(' ');
  check('topics cover school subject', blob.includes('school') || blob.includes('study') || blob.includes('exam'), blob);
  check('topics cover football subject', blob.includes('football') || blob.includes('match') || blob.includes('soccer'), blob);
  check('no topic is archived initially', topics.every((t) => !t.archived));

  console.log('[2] recency floor — vague follow-up with no keywords...');
  const selected = selectTopicsForContext(topics, VAGUE);
  const newest = topics.sort((a, b) => b.lastMentioned.getTime() - a.lastMentioned.getTime())[0];
  check(
    'most recent topic selected via recency floor',
    selected.some((t) => t.label === newest.label),
    `selected=${selected.map((t) => t.label).join(', ') || '(none)'}`
  );

  console.log('[3] archival — backdate newest topic 100 days, run maintenance...');
  newest.lastMentioned = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  const before = ((conv!.topics as unknown) as TopicEntry[]).slice();
  conv!.topics = before.map((t) =>
    t.label === newest.label ? { ...t, lastMentioned: newest.lastMentioned } : t
  ) as never;
  await conv!.save();
  const loaded = await ConversationModel.findOne({ chatId: CHAT_ID }).exec();
  const result = await maintainConversationTopics(loaded!, Date.now());
  const after = ((loaded?.topics as unknown) as TopicEntry[]);
  const archived = after.find((t) => t.label === newest.label);
  check('maintenance ran', !(result.merged === undefined), `merged=${result.merged}`);
  check('backdated topic flips archived: true', archived?.archived === true, `archived=${archived?.archived}`);
  const reselect = selectTopicsForContext(after, FOOTBALL);
  check(
    'archived topic excluded from context selection',
    !reselect.some((t) => t.label === newest.label),
    `selected=${reselect.map((t) => t.label).join(', ') || '(none)'}`
  );

  console.log('[4] merge — two near-duplicate topics...');
  const dupeStart: TopicEntry[] = [
    { label: 'football', summary: 'Watching and playing football on weekends.', lastMentioned: new Date(), archived: false },
    { label: 'soccer', summary: 'Soccer games and weekend matches, we won 3-0.', lastMentioned: new Date(), archived: false },
    { label: 'school', summary: 'Helping with study for the school exam.', lastMentioned: new Date(), archived: false },
  ];
  const merged = await mergeDuplicateTopics(dupeStart);
  check(
    'near-duplicates merged into one',
    merged.length === 2,
    `before=3 after=${merged.length}`
  );
  check(
    'merged entry keeps football subject',
    merged.some((t) => /football|soccer|match|sport/i.test(`${t.label} ${t.summary}`)) &&
      merged.some((t) => /school|exam|study/i.test(`${t.label} ${t.summary}`)),
    merged.map((t) => t.label).join(', ')
  );

  await ConversationModel.deleteMany({ chatId: { $regex: '^test-memory' } }).exec();
  await disconnectDb();

  console.log(failures === 0 ? '\nOK — all memory checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});