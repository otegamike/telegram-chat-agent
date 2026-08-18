import 'dotenv/config';
import crypto from 'node:crypto';
import Groq from 'groq-sdk';
import { recordAiCall } from './ai-log';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export interface DraftPrompt {
  systemPrompt: string;
  fewShotExamples: { trigger: string; reply: string }[];
  correctionsBlock?: string | null;
  identity?: string | null;
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
    ? `\n\nCorrections & lessons from your edits — prefer the corrected phrasing and follow these rules:\n${prompt.correctionsBlock}`
    : '';

  const identityBlock = prompt.identity ? `${prompt.identity}\n\n` : '';

  return `${identityBlock}${prompt.systemPrompt}

Few-shot examples (incoming -> your reply). Imitate the style but never copy these word-for-word:
${examplesBlock}${correctionsBlock}`;
}

export function buildUserMessage(incomingMessage: string, conversationContext: string): string {
  const contextBlock = conversationContext.trim() ? conversationContext : '(no prior context)';
  return `Conversation context (recent history):
${contextBlock}

Draft a reply to this incoming message:
${incomingMessage}`;
}

export async function generateDraft(
  incomingMessage: string,
  conversationContext: string,
  prompt: DraftPrompt,
  opts: { chatId?: string | null } = {}
): Promise<string> {
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const messages: DraftChatMessage[] = [
    { role: 'system', content: buildSystemMessage(prompt) },
    { role: 'user', content: buildUserMessage(incomingMessage, conversationContext) },
  ];

  const start = Date.now();
  try {
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
    const reply = content.trim();
    recordAiCall({
      kind: 'draft',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: messages[0].content,
      userPrompt: messages[1].content,
      reply,
      durationMs: Date.now() - start,
    });
    return reply;
  } catch (err) {
    recordAiCall({
      kind: 'draft',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: messages[0].content,
      userPrompt: messages[1].content,
      error: String((err as Error)?.message ?? err),
      durationMs: Date.now() - start,
    });
    throw err;
  }
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

export interface FoldRoleLabels {
  me?: string | null;
  them?: string | null;
}

export interface FoldOptions extends FoldRoleLabels {
  chatId?: string | null;
  evictedBufferHint?: boolean;
}

async function callFold(
  system: string,
  user: string,
  temperature: number
): Promise<string> {
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const completion = await getGroq().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    max_completion_tokens: 4096,
    response_format: { type: 'json_object' },
  });
  return completion.choices[0]?.message?.content?.trim() ?? '';
}

export async function foldTopicsIntoHistory(
  topics: TopicEntry[],
  foldedMessages: FoldedMessage[],
  opts: FoldOptions = {}
): Promise<TopicEntry[]> {
  const meLabel = opts.me?.trim() || 'Me';
  const themLabel = opts.them?.trim() || 'Them';
  const messagesBlock = foldedMessages
    .map((m) => `${m.role === 'me' ? meLabel : themLabel}: ${m.text}`)
    .join('\n');
  const topicsBlock =
    topics.length === 0
      ? '(none yet)'
      : topics
          .map((t) => `- ${t.label}: ${t.summary} (last mentioned ${t.lastMentioned.toISOString()}, archived: ${t.archived})`)
          .join('\n');

  const batchHint = opts.evictedBufferHint
    ? '\n- This is a buffered batch of messages that left the rolling window; merge the important context they contain into the existing topics. Do NOT create a topic per message — combine related messages into whatever topic they continue or fold their gist into an existing topic.'
    : '';

  const system =
    'You maintain a compact topic memory for a Telegram chat. Given the existing topics and a batch of ' +
    'old messages being evicted from the rolling window, return a NEW topics array as raw JSON only ' +
    '(no prose, no code fences).\n' +
    'Rules:\n' +
    '- For each message, either update an existing topic that clearly continues the same subject, or ' +
    'create a new topic entry if it matches nothing.\n' +
    '- When updating a topic, refresh lastMentioned to the latest message time and RE-WRITE its summary ' +
    'to incorporate the new messages. Keep every summary to 1-3 short lines — condense and combine ' +
    'related topics rather than appending, so the list never grows without bound.\n' +
    '- New entries: archived must be false.\n' +
    '- Preserve archived status on existing topics that appear unchanged.\n' +
    '- Output must be complete, concise, valid JSON: ' +
    '{"topics": [{"label": string, "summary": string, "lastMentioned": "ISO datetime string", "archived": boolean}]}\n' +
    `- Aim to keep the total topics array compact${batchHint}`;

  const user = `Existing topics:\n${topicsBlock}\n\nEvicted messages:\n${messagesBlock}\n\nReturn the updated topics JSON array.`;

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;

  const parse = (content: string): TopicEntry[] => {
    const parsed = parseTopicJson(content);
    if (parsed.length === 0 && topics.length > 0) {
      throw new Error('Groq returned unparseable topics during fold');
    }
    return parsed;
  };

  const record = (input: {
    reply?: string;
    error?: string;
    durationMs: number;
  }) => {
    recordAiCall({
      kind: 'fold',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: system,
      userPrompt: user,
      reply: input.reply ?? null,
      error: input.error ?? null,
      durationMs: input.durationMs,
    });
  };

  const start = Date.now();
  try {
    const reply = await callFold(system, user, 0.3);
    record({ reply, durationMs: Date.now() - start });
    return mergeArchivedFlags(parse(reply), topics);
  } catch (err) {
    console.warn('[llm] topic fold failed — retrying once with temperature 0');
    try {
      const retry = await callFold(system, user, 0);
      record({ reply: retry, durationMs: Date.now() - start });
      return mergeArchivedFlags(parse(retry), topics);
    } catch (retryErr) {
      record({ error: String((retryErr as Error)?.message ?? retryErr), durationMs: Date.now() - start });
      throw retryErr;
    }
  }
}

export async function mergeDuplicateTopics(
  topics: TopicEntry[],
  opts: { chatId?: string | null } = {}
): Promise<TopicEntry[]> {
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

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const start = Date.now();
  try {
    const completion = await getGroq().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_completion_tokens: 4096,
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
    recordAiCall({
      kind: 'merge',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: system,
      userPrompt: user,
      reply: content.trim(),
      durationMs: Date.now() - start,
    });
    return mergeArchivedFlags(parsed, topics);
  } catch (err) {
    recordAiCall({
      kind: 'merge',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: system,
      userPrompt: user,
      error: String((err as Error)?.message ?? err),
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

export interface CorrectionInput {
  incomingMessage: string;
  draftText: string;
  correctedText: string;
}

export interface FoldCorrectionsOptions {
  chatId?: string | null;
  maxRules?: number;
}

const DEFAULT_MAX_RULES = 15;

export async function foldCorrections(
  existingRules: string,
  correction: CorrectionInput,
  opts: FoldCorrectionsOptions = {}
): Promise<string> {
  const maxRules = opts.maxRules && opts.maxRules > 0 ? opts.maxRules : DEFAULT_MAX_RULES;
  const existingBlock = existingRules.trim()
    ? existingRules.trim()
    : '(no existing rules)';

  const system =
    'You maintain a growing list of style corrections for an AI that replies as a real person on Telegram. ' +
    'The owner reviews AI drafts and sends corrected versions. From a new draft->corrected pair, figure out ' +
    'what was corrected and WHY, then update the existing corrections block.\n' +
    'Rules:\n' +
    '- Preserve the meaning of every existing rule; only drop something if it is clearly redundant with another.\n' +
    `- Fold the new correction in: if it teaches a lesson already covered, RE-EMPHASIZE/STRENGTHEN that rule instead of duplicating it. If it is new, add it as a new bullet.\n` +
    `- Keep the block a concise bullet list of at most ${maxRules} rules. Condense overlapping rules together rather than growing the list.\n` +
    '- Write each bullet as an actionable instruction (e.g. "Do not ...", "Always ...", "Prefer ...").\n' +
    '- Output ONLY the updated bullet list as plain text. No preamble, no explanations, no code fences.';

  const user = `Existing corrections block:\n${existingBlock}

New correction:
Incoming message:
${correction.incomingMessage}

Draft (what the AI wrote):
${correction.draftText}

Corrected (what the owner sent instead):
${correction.correctedText}

Return the updated corrections block.`;

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const start = Date.now();
  try {
    const completion = await getGroq().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_completion_tokens: 800,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Groq returned an empty corrections fold');
    }
    const updated = content.trim();
    recordAiCall({
      kind: 'correction',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: system,
      userPrompt: user,
      reply: updated,
      durationMs: Date.now() - start,
    });
    return updated;
  } catch (err) {
    recordAiCall({
      kind: 'correction',
      chatId: opts.chatId ?? null,
      model,
      systemPrompt: system,
      userPrompt: user,
      error: String((err as Error)?.message ?? err),
      durationMs: Date.now() - start,
    });
    throw err;
  }
}