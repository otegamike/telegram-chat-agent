import 'dotenv/config';
import crypto from 'node:crypto';
import Groq from 'groq-sdk';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export interface DraftPrompt {
  systemPrompt: string;
  fewShotExamples: { trigger: string; reply: string }[];
  correctionsBlock?: string | null;
}

interface DraftChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface TopicEntry {
  topicId?: string | null;
  label: string;
  summary: string;
  lastMentioned: Date;
  archived: boolean;
}

export interface FoldedMessage {
  role: 'them' | 'me';
  text: string;
  timestamp?: Date | null;
}

let groq: Groq | null = null;

function getGroq(): Groq {
  if (!groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set in .env');
    }
    groq = new Groq({ apiKey });
  }
  return groq;
}

export function buildSystemMessage(prompt: DraftPrompt): string {
  const examplesBlock = prompt.fewShotExamples
    .map((e) => `- Incoming: ${e.trigger}\n  Reply: ${e.reply}`)
    .join('\n');

  const correctionsBlock = prompt.correctionsBlock
    ? `\n\nRecent corrections Mike made in the review bot (original -> final). Prefer the corrected phrasing:\n${prompt.correctionsBlock}`
    : '';

  return `${prompt.systemPrompt}

Few-shot examples (incoming -> Mike's reply). Imitate the style but never copy these word-for-word:
${examplesBlock}${correctionsBlock}`;
}

export function buildUserMessage(incomingMessage: string, conversationContext: string): string {
  const contextBlock = conversationContext.trim() ? conversationContext : '(no prior context)';
  return `Conversation context (recent history):
${contextBlock}

Draft Mike's reply to this incoming message:
${incomingMessage}`;
}

export async function generateDraft(
  incomingMessage: string,
  conversationContext: string,
  prompt: DraftPrompt
): Promise<string> {
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const messages: DraftChatMessage[] = [
    { role: 'system', content: buildSystemMessage(prompt) },
    { role: 'user', content: buildUserMessage(incomingMessage, conversationContext) },
  ];

  const completion = await getGroq().chat.completions.create({
    model,
    messages,
    temperature: 0.8,
    max_completion_tokens: 500,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned an empty draft');
  }
  return content.trim();
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeTopic(
  raw: unknown
): TopicEntry | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const label = typeof obj.label === 'string' ? obj.label.trim() : '';
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!label || !summary) {
    return null;
  }
  const lastMentioned = new Date(typeof obj.lastMentioned === 'string' ? obj.lastMentioned : Date.now());
  return {
    label,
    summary,
    lastMentioned: Number.isNaN(lastMentioned.getTime()) ? new Date() : lastMentioned,
    archived: obj.archived === true,
  };
}

function parseTopicJson(raw: string): TopicEntry[] {
  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = null;
  }
  let list: unknown = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    list = (parsed as Record<string, unknown>).topics;
  }
  if (!Array.isArray(list) && typeof parsed === 'string') {
    const start = parsed.indexOf('[');
    const end = parsed.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        list = JSON.parse(parsed.slice(start, end + 1));
      } catch {
        list = null;
      }
    }
  }
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map(normalizeTopic).filter((t): t is TopicEntry => t !== null);
}

function mergeArchivedFlags(
  topics: TopicEntry[],
  previous: TopicEntry[]
): TopicEntry[] {
  const byLabel = new Map(previous.map((t) => [t.label.toLowerCase(), t]));
  return topics.map((t) => {
    const old = byLabel.get(t.label.toLowerCase());
    const archived = old ? old.archived : t.archived;
    const topicId = old?.topicId || t.topicId || crypto.randomUUID();
    return { ...t, topicId, archived };
  });
}

export async function foldTopicsIntoHistory(
  topics: TopicEntry[],
  foldedMessages: FoldedMessage[]
): Promise<TopicEntry[]> {
  const messagesBlock = foldedMessages
    .map((m) => `${m.role === 'me' ? 'Me' : 'Them'}: ${m.text}`)
    .join('\n');
  const topicsBlock =
    topics.length === 0
      ? '(none yet)'
      : topics
          .map((t) => `- ${t.label}: ${t.summary} (last mentioned ${t.lastMentioned.toISOString()}, archived: ${t.archived})`)
          .join('\n');

  const system =
    'You maintain a compact topic memory for a Telegram chat. Given the existing topics and a batch of ' +
    'old messages being evicted from the rolling window, return a NEW topics array as raw JSON only ' +
    '(no prose, no code fences).\n' +
    'Rules:\n' +
    '- For each message, either update an existing topic that clearly continues the same subject, or ' +
    'create a new topic entry if it matches nothing.\n' +
    '- When updating a topic, refresh lastMentioned to the latest message time and RE-WRITE its summary ' +
    'to incorporate the new message. Keep every summary to a few lines — condense rather than append so ' +
    'entries never grow without bound.\n' +
    '- New entries: archived must be false.\n' +
    '- Preserve archived status on existing topics that appear unchanged.\n' +
    '- Output format: {"topics": [{"label": string, "summary": string, "lastMentioned": "ISO datetime string", "archived": boolean}]}';

  const user = `Existing topics:\n${topicsBlock}\n\nEvicted messages:\n${messagesBlock}\n\nReturn the updated topics JSON array.`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned an empty topic fold');
  }
  const parsed = parseTopicJson(content);
  if (parsed.length === 0 && topics.length > 0) {
    throw new Error('Groq returned unparseable topics during fold');
  }
  return mergeArchivedFlags(parsed, topics);
}

export async function mergeDuplicateTopics(topics: TopicEntry[]): Promise<TopicEntry[]> {
  const topicsBlock =
    topics.length === 0
      ? '(none)'
      : topics
          .map((t) => `- ${t.label}: ${t.summary} (last mentioned ${t.lastMentioned.toISOString()}, archived: ${t.archived})`)
          .join('\n');

  const system =
    'You maintain a compact topic memory for a Telegram chat. Review the provided topic entries and ' +
    'merge any near-duplicates that describe the same underlying subject under different labels. ' +
    'Rules:\n' +
    '- Merge into a single entry: pick the clearest label, combine the summaries into a few concise lines, ' +
    'keep the most recent lastMentioned, and archived = true if any merged entry was archived.\n' +
    '- Leave distinct topics untouched.\n' +
    '- Return the resulting array as raw JSON only (no prose, no code fences): ' +
    '{"topics": [{"label": string, "summary": string, "lastMentioned": "ISO datetime string", "archived": boolean}]}';

  if (topics.length < 2) {
    return topics;
  }

  const user = `Current topics:\n${topicsBlock}\n\nReturn the merged topics JSON array.`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned an empty topic merge');
  }
  const parsed = parseTopicJson(content);
  if (parsed.length === 0) {
    throw new Error('Groq returned unparseable topics during merge');
  }
  return mergeArchivedFlags(parsed, topics);
}