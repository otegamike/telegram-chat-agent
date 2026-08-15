import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { connectDb, disconnectDb } from '../services/db';
import { AdminUserModel } from '../models/AdminUser';

async function main(): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    const username = (await rl.question('Admin username: ')).trim();
    if (!username) {
      throw new Error('Username cannot be empty');
    }
    const password = await rl.question('Admin password (min 8 chars): ');
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    await connectDb();

    const passwordHash = await bcrypt.hash(password, 10);
    const existing = await AdminUserModel.findOne({ username });
    if (existing) {
      existing.passwordHash = passwordHash;
      await existing.save();
      console.log(`Admin "${username}" password updated.`);
    } else {
      await AdminUserModel.create({ username, passwordHash });
      console.log(`Admin "${username}" created.`);
    }
    console.log('Login at the admin UI (/admin) with these credentials.');
  } finally {
    rl.close();
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});