import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set in .env');
  }
  await mongoose.connect(uri);
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}