import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { connectDb } from '../services/db';
import { AdminUserModel } from '../models/AdminUser';
import { MasterPromptModel, MasterPrompt } from '../models/MasterPrompt';
import { ChatConfigModel, ChatConfig } from '../models/ChatConfig';

const COOKIE_NAME = 'adtoken';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// SESSION_SECRET must be stable across restarts to keep sessions valid.
const sessionSecret =
  process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.ADMIN_SESSION_SECRET) {
  console.warn(
    '[admin] ADMIN_SESSION_SECRET not set in .env - using a random secret. ' +
      'Sessions will not survive server restarts.'
  );
}

interface AdminSession {
  username: string;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function createToken(username: string): string {
  const payload = base64UrlEncode(
    JSON.stringify({ username, exp: Date.now() + SESSION_TTL_MS })
  );
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): AdminSession | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, sig] = parts;
  const expected = sign(payload);
  if (!safeEqual(sig, expected)) {
    return null;
  }
  let data: { username: string; exp: number };
  try {
    data = JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }
  if (!data.username || typeof data.exp !== 'number' || data.exp < Date.now()) {
    return null;
  }
  return { username: data.username };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

interface AuthedRequest extends Request {
  adminUser?: AdminSession;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const cookieToken = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const session = cookieToken ? verifyToken(cookieToken) : null;
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  req.adminUser = session;
  next();
}

function serializePrompt(doc: Record<string, unknown> & { _id: unknown }): Record<string, unknown> {
  return {
    id: String(doc._id),
    key: doc.key,
    name: doc.name,
    chatId: doc.chatId ?? null,
    systemPrompt: doc.systemPrompt,
    fewShotExamples: doc.fewShotExamples ?? [],
    correctionsBlock: doc.correctionsBlock ?? null,
    enabled: doc.enabled,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function serializeChatConfig(doc: Record<string, unknown> & { _id: unknown }): Record<string, unknown> {
  return {
    id: String(doc._id),
    chatId: doc.chatId,
    peerUsername: doc.peerUsername ?? '',
    autoReplyEnabled: doc.autoReplyEnabled,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function normalizeChatId(raw: unknown): string | null {
  if (!raw) {
    return null;
  }
  const value = String(raw).trim();
  return value ? value : null;
}

function normalizeFewShot(raw: unknown): { trigger: string; reply: string }[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (item): item is { trigger: string; reply: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { trigger?: unknown }).trigger === 'string' &&
        typeof (item as { reply?: unknown }).reply === 'string'
    )
    .map((item) => ({ trigger: item.trigger.trim(), reply: item.reply.trim() }))
    .filter((item) => item.trigger && item.reply);
}

export async function startAdminServer(): Promise<void> {
  await connectDb();

  const port = Number(process.env.ADMIN_PORT || 8080);
  const app = express();
  app.use(express.json());

  const publicDir = path.resolve(process.cwd(), 'public');
  app.use(express.static(publicDir));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.post('/api/login', async (req: AuthedRequest, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const admin = await AdminUserModel.findOne({ username }).exec();
    if (!admin) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    res.cookie(COOKIE_NAME, createToken(username), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    res.json({ username });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ username: req.adminUser!.username });
  });

  app.get('/api/prompts', requireAuth, async (_req, res) => {
    const prompts = await MasterPromptModel.find().sort({ chatId: -1, updatedAt: -1 }).lean().exec();
    res.json(prompts.map((p) => serializePrompt(p as never)));
  });

  app.post('/api/prompts', requireAuth, async (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key || !/^[a-z0-9-_]+$/.test(key)) {
      res.status(400).json({ error: 'key is required (lowercase letters, numbers, - and _ only)' });
      return;
    }
    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : key;
    const chatId = normalizeChatId(req.body?.chatId);
    const systemPrompt = typeof req.body?.systemPrompt === 'string' ? req.body.systemPrompt : '';
    if (!systemPrompt) {
      res.status(400).json({ error: 'systemPrompt is required' });
      return;
    }
    const fewShotExamples = normalizeFewShot(req.body?.fewShotExamples);
    const enabled = req.body?.enabled !== false;

    try {
      const created = await MasterPromptModel.create({
        key,
        name,
        chatId,
        systemPrompt,
        fewShotExamples,
        enabled,
      });
      res.status(201).json(serializePrompt(created.toObject() as never));
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: `A prompt with key "${key}" already exists` });
        return;
      }
      throw err;
    }
  });

  app.put('/api/prompts/:id', requireAuth, async (req, res) => {
    const prompt = await MasterPromptModel.findById(req.params.id).exec();
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    if (typeof req.body?.name === 'string') {
      prompt.name = req.body.name.trim() || prompt.name;
    }
    if ('chatId' in req.body) {
      prompt.chatId = normalizeChatId(req.body.chatId);
    }
    if (typeof req.body?.systemPrompt === 'string') {
      prompt.systemPrompt = req.body.systemPrompt;
    }
    if ('fewShotExamples' in req.body) {
      prompt.fewShotExamples = normalizeFewShot(req.body.fewShotExamples) as never;
    }
    if (typeof req.body?.correctionsBlock === 'string') {
      prompt.correctionsBlock = req.body.correctionsBlock;
    }
    if (typeof req.body?.enabled === 'boolean') {
      prompt.enabled = req.body.enabled;
    }

    prompt.updatedAt = new Date();
    await prompt.save();
    res.json(serializePrompt(prompt.toObject() as never));
  });

  app.delete('/api/prompts/:id', requireAuth, async (req, res) => {
    const prompt = await MasterPromptModel.findById(req.params.id).exec();
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    if (prompt.key === 'default') {
      res.status(403).json({ error: 'The default prompt cannot be deleted' });
      return;
    }
    await prompt.deleteOne();
    res.json({ ok: true });
  });

  app.get('/api/chat-configs', requireAuth, async (_req, res) => {
    const configs = await ChatConfigModel.find().sort({ chatId: 1 }).lean().exec();
    res.json(configs.map((c) => serializeChatConfig(c as never)));
  });

  app.put('/api/chat-configs/:chatId', requireAuth, async (req, res) => {
    const chatId = String(req.params.chatId).trim();
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.autoReplyEnabled === 'boolean') {
      update.autoReplyEnabled = req.body.autoReplyEnabled;
    }
    if (typeof req.body?.peerUsername === 'string') {
      update.peerUsername = req.body.peerUsername.trim();
    }

    const config = await ChatConfigModel.findOneAndUpdate(
      { chatId },
      { $set: update, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(serializeChatConfig(config.toObject() as never));
  });

  app.delete('/api/chat-configs/:chatId', requireAuth, async (req, res) => {
    await ChatConfigModel.deleteOne({ chatId: String(req.params.chatId) });
    res.json({ ok: true });
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(404).send('Not found');
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[admin] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`[admin] admin UI at http://localhost:${port}/admin`);
  });
}