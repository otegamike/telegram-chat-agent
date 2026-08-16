import { connectDb, disconnectDb } from '../services/db';
import { ConversationModel } from '../models/Conversation';
import { ensureDefaultMasterPrompt } from '../services/master-prompt';

async function main(): Promise<void> {
  await connectDb();

  const conversation = await ConversationModel.findOneAndUpdate(
    { chatId: 'test-12345' },
    {
      $set: {
        peerUsername: 'test_peer',
        messages: [
          {
            role: 'them',
            text: 'Hey, is the project ready?',
            timestamp: new Date(),
          },
          {
            role: 'me',
            text: 'Almost, wrapping it up today',
            timestamp: new Date(),
          },
        ],
        topics: [],
        lastUpdated: new Date(),
      },
    },
    { returnDocument: 'after', upsert: true }
  );

  const readBack = await ConversationModel.findById(conversation._id).lean();
  console.log('Conversation doc written and read back:');
  console.log(JSON.stringify(readBack, null, 2));

  const masterPrompt = await ensureDefaultMasterPrompt();
  console.log('\nMasterPrompt seeded/loaded from Mongo:');
  console.log(`  key: ${masterPrompt.key}`);
  console.log(`  name: ${masterPrompt.name}`);
  console.log(`  fewShotExamples: ${masterPrompt.fewShotExamples.length}`);
  console.log('  systemPrompt (first 80 chars):');
  console.log('  ' + masterPrompt.systemPrompt.slice(0, 80) + '...');

  await disconnectDb();
  console.log('\nOK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});