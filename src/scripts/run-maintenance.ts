import 'dotenv/config';
import { connectDb, disconnectDb } from '../services/db';
import { runTopicMaintenance } from '../services/maintenance';

async function main(): Promise<void> {
  await connectDb();
  await runTopicMaintenance();
  await disconnectDb();
  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});