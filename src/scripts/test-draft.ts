import 'dotenv/config';
import { connectDb, disconnectDb } from '../services/db';
import { resolveMasterPrompt } from '../services/master-prompt';
import { generateDraft } from '../services/llm';

const SAMPLE_INCOMING = 'hey are u free for a football match saturday?';
const SAMPLE_CONTEXT = 'them: whats up?\nme: not much, just working\n';

async function main(): Promise<void> {
  await connectDb();

  const prompt = await resolveMasterPrompt('test-chat-1');
  console.log(`Using master prompt: "${prompt.name}" (chatId: ${prompt.chatId ?? 'global default'})`);

  const draft = await generateDraft(SAMPLE_INCOMING, SAMPLE_CONTEXT, prompt);

  console.log('Incoming:', SAMPLE_INCOMING);
  console.log('Context:');
  console.log(SAMPLE_CONTEXT);
  console.log('\n--- DRAFT ---');
  console.log(draft);

  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});