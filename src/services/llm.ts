import 'dotenv/config';
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