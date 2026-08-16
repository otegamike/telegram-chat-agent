import { TopicEntry } from './llm';

export interface SelectTopicsOptions {
  floor?: number;
  cap?: number;
  minTokenLength?: number;
}

const DEFAULT_FLOOR = 3;
const DEFAULT_CAP = 8;
const DEFAULT_MIN_TOKEN_LENGTH = 3;

function tokens(value: string, minLength: number): string[] {
  const seen = new Set<string>();
  for (const raw of value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (raw.length >= minLength) {
      seen.add(raw);
    }
  }
  return Array.from(seen);
}

function overlaps(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  return b.some((token) => setA.has(token));
}

export function selectTopicsForContext(
  topics: TopicEntry[],
  incomingText: string,
  options: SelectTopicsOptions = {}
): TopicEntry[] {
  const floor = options.floor ?? DEFAULT_FLOOR;
  const cap = options.cap ?? DEFAULT_CAP;
  const minTokenLength = options.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH;

  const active = topics.filter((t) => !t.archived);
  if (active.length === 0) {
    return [];
  }

  const recencySorted = [...active].sort(
    (a, b) => b.lastMentioned.getTime() - a.lastMentioned.getTime()
  );

  const selected: TopicEntry[] = recencySorted.slice(0, floor);
  const selectedKeys = new Set(selected.map((t) => t.label.toLowerCase()));

  const incomingTokens = tokens(incomingText, minTokenLength);

  for (const topic of recencySorted.slice(floor)) {
    if (selected.length >= cap) {
      break;
    }
    const key = topic.label.toLowerCase();
    if (selectedKeys.has(key)) {
      continue;
    }
    if (incomingTokens.length === 0) {
      continue;
    }
    const topicTokens = tokens(`${topic.label} ${topic.summary}`, minTokenLength);
    if (topicTokens.length > 0 && overlaps(topicTokens, incomingTokens)) {
      selected.push(topic);
      selectedKeys.add(key);
    }
  }

  console.log(
    `[topics] selected for draft: ${selected.map((t) => t.label).join(', ') || '(none)'}`
  );
  return selected;
}