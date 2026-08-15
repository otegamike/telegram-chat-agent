import { startAdminServer } from './server';

startAdminServer().catch((err) => {
  console.error('[admin] failed to start:', err);
  process.exit(1);
});