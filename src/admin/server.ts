import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { connectDb } from '../services/db';
import { AdminUserModel } from '../models/AdminUser';
import { MasterPromptModel, MasterPrompt } from '../models/MasterPrompt';
import { ChatConfigModel, ChatConfig } from '../models/ChatConfig';
import { TelegramChatModel } from '../models/TelegramChat';
import { ConversationModel } from '../models/Conversation';
import { DraftModel } from '../models/Draft';
import { ensureDefaultMasterPrompt } from '../services/master-prompt';
import { getSettings, updateSettings } from '../services/settings';

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

function serializeDraft(doc: Record<string, unknown> & { _id: unknown }): Record<string, unknown> {
  return {
    id: String(doc._id),
    chatId: doc.chatId,
    incomingMessage: doc.incomingMessage,
    draftText: doc.draftText,
    finalText: doc.finalText ?? null,
    status: doc.status,
    wasEdited: doc.wasEdited,
    createdAt: doc.createdAt,
  };
}

function serializeTopic(t: Record<string, unknown>): Record<string, unknown> {
  return {
    topicId: t.topicId ?? null,
    label: t.label,
    summary: t.summary,
    lastMentioned: t.lastMentioned,
    archived: !!t.archived,
  };
}

async function loadTopicConversation(
  chatId: string
): Promise<InstanceType<typeof ConversationModel>> {
  let doc = await ConversationModel.findOne({ chatId }).exec();
  if (!doc) {
    const config = await ChatConfigModel.findOne({ chatId }).lean().exec();
    doc = await ConversationModel.create({
      chatId,
      peerUsername: config?.peerUsername ?? '',
      messages: [],
    });
  }
  return doc;
}

function findTopicIndex(
  doc: InstanceType<typeof ConversationModel>,
  topicId: string
): number {
  const topics = (doc.topics as unknown as Array<{ topicId?: string | null }> | undefined) ?? [];
  return topics.findIndex((t) => t.topicId === topicId);
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

  app.get('/api/chats', requireAuth, async (_req, res) => {
    const chats = await TelegramChatModel.find().sort({ displayName: 1 }).lean().exec();
    const lastSyncAt = chats.reduce<Date | null>(
      (max, c) => (c.updatedAt && (!max || c.updatedAt > max) ? c.updatedAt : max),
      null
    );
    res.json({
      chats: chats.map((c) => ({
        chatId: c.chatId,
        username: c.username ?? '',
        displayName: c.displayName || c.chatId,
      })),
      lastSyncAt: lastSyncAt?.toISOString() ?? null,
    });
  });

  app.get('/api/chat/:chatId', requireAuth, async (req, res) => {
    const chatId = String(req.params.chatId).trim();
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    const [dir, config] = await Promise.all([
      TelegramChatModel.findOne({ chatId }).lean().exec(),
      ChatConfigModel.findOne({ chatId }).lean().exec(),
    ]);

    const [conversation, drafts, chatPrompt, defaultPrompt] = await Promise.all([
      ConversationModel.findOne({ chatId }).lean().exec(),
      DraftModel.find({ chatId }).sort({ createdAt: -1 }).limit(100).lean().exec(),
      MasterPromptModel.findOne({ chatId, key: { $ne: 'default' } })
        .sort({ updatedAt: -1 })
        .lean()
        .exec(),
      ensureDefaultMasterPrompt(),
    ]);

    res.json({
      chat: dir
        ? {
            chatId: dir.chatId,
            username: dir.username ?? '',
            displayName: dir.displayName || dir.chatId,
          }
        : null,
      config: config
        ? {
            chatId: config.chatId,
            peerUsername: config.peerUsername ?? '',
            autoReplyEnabled: config.autoReplyEnabled,
          }
        : null,
      conversation: conversation
        ? {
            messages: (conversation.messages ?? []).map((m) => ({
              role: m.role,
              text: m.text,
              timestamp: m.timestamp,
            })),
            topics: (conversation.topics ?? []).map((t) => serializeTopic(t as never)),
            lastUpdated: conversation.lastUpdated,
          }
        : null,
      drafts: drafts.map((d) => ({
        id: String(d._id),
        incomingMessage: d.incomingMessage,
        draftText: d.draftText,
        finalText: d.finalText ?? null,
        status: d.status,
        wasEdited: d.wasEdited,
        createdAt: d.createdAt,
      })),
      chatPrompt: chatPrompt ? serializePrompt(chatPrompt as never) : null,
      defaultPrompt: serializePrompt(defaultPrompt.toObject() as never),
    });
  });

  app.get('/api/chat/:chatId/topics', requireAuth, async (req, res) => {
    const chatId = String(req.params.chatId).trim();
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }
    const doc = await ConversationModel.findOne({ chatId }).lean().exec();
    const topics = (doc?.topics as unknown as Array<Record<string, unknown>> | undefined) ?? [];
    res.json({ topics: topics.map((t) => serializeTopic(t)) });
  });

  app.post('/api/chat/:chatId/topics', requireAuth, async (req, res) => {
    const chatId = String(req.params.chatId).trim();
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const summary = typeof req.body?.summary === 'string' ? req.body.summary.trim() : '';
    if (!label || !summary) {
      res.status(400).json({ error: 'label and summary are required' });
      return;
    }

    const doc = await loadTopicConversation(chatId);
    const topic = {
      topicId: crypto.randomUUID(),
      label,
      summary,
      lastMentioned: new Date(),
      archived: false,
    };
    (doc.topics as unknown as Record<string, unknown>[]).push(topic);
    doc.lastUpdated = new Date();
    await doc.save();
    res.status(201).json(serializeTopic(topic as never));
  });

  app.put('/api/chat/:chatId/topics/:topicId', requireAuth, async (req, res) => {
    const chatId = String(req.params.chatId).trim();
    const topicId = String(req.params.topicId).trim();
    if (!chatId || !topicId) {
      res.status(400).json({ error: 'chatId and topicId are required' });
      return;
    }

    const doc = await ConversationModel.findOne({ chatId }).exec();
    if (!doc) {
      res.status(404).json({ error: 'No conversation found for this chat' });
      return;
    }
    const idx = findTopicIndex(doc, topicId);
    if (idx === -1) {
      res.status(404).json({ error: 'Topic not found' });
      return;
    }

    const topic = (doc.topics as unknown as Array<Record<string, unknown>>)[idx];
    if (typeof req.body?.label === 'string') {
      topic.label = req.body.label.trim() || String(topic.label);
    }
    if (typeof req.body?.summary === 'string') {
      topic.summary = req.body.summary.trim() || String(topic.summary);
    }
    if (typeof req.body?.archived === 'boolean') {
      topic.archived = req.body.archived;
    }
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(serializeTopic(topic));
  });

  app.delete('/api/chat/:chatId/topics/:topicId', requireAuth, async (req, res) => {
    const chatId = String(req.params.chatId).trim();
    const topicId = String(req.params.topicId).trim();
    if (!chatId || !topicId) {
      res.status(400).json({ error: 'chatId and topicId are required' });
      return;
    }

    const doc = await ConversationModel.findOne({ chatId }).exec();
    if (!doc) {
      res.status(404).json({ error: 'No conversation found for this chat' });
      return;
    }
    const idx = findTopicIndex(doc, topicId);
    if (idx === -1) {
      res.status(404).json({ error: 'Topic not found' });
      return;
    }

    (doc.topics as unknown as unknown[]).splice(idx, 1);
    doc.lastUpdated = new Date();
    await doc.save();
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

  app.post('/api/drafts', requireAuth, async (req, res) => {
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
    const incomingMessage =
      typeof req.body?.incomingMessage === 'string' ? req.body.incomingMessage.trim() : '';
    const draftText = typeof req.body?.draftText === 'string' ? req.body.draftText.trim() : '';
    const rawFinalText = typeof req.body?.finalText === 'string' ? req.body.finalText.trim() : '';
    const finalText = rawFinalText || null;
    const rawStatus = req.body?.status;
    const status = rawStatus === 'sent' || rawStatus === 'skipped' ? rawStatus : 'skipped';

    if (!chatId || !incomingMessage || !draftText) {
      res.status(400).json({ error: 'chatId, incomingMessage and draftText are required' });
      return;
    }

    const draft = await DraftModel.create({
      chatId,
      incomingMessage,
      draftText,
      finalText,
      status,
      wasEdited: !!finalText && finalText !== draftText,
    });
    res.status(201).json(serializeDraft(draft.toObject() as never));
  });

  app.put('/api/drafts/:id', requireAuth, async (req, res) => {
    const draft = await DraftModel.findById(req.params.id).exec();
    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }

    if (typeof req.body?.incomingMessage === 'string') {
      draft.incomingMessage = req.body.incomingMessage.trim();
    }
    if (typeof req.body?.draftText === 'string') {
      draft.draftText = req.body.draftText.trim();
    }
    if ('finalText' in req.body) {
      const rawFinalText = typeof req.body.finalText === 'string' ? req.body.finalText.trim() : '';
      draft.finalText = rawFinalText || null;
    }
    if (req.body?.status === 'sent' || req.body?.status === 'skipped') {
      draft.status = req.body.status;
    }
    draft.wasEdited = !!draft.finalText && draft.finalText !== draft.draftText;

    await draft.save();
    res.json(serializeDraft(draft.toObject() as never));
  });

  app.delete('/api/drafts/:id', requireAuth, async (req, res) => {
    const draft = await DraftModel.findById(req.params.id).exec();
    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }
    await draft.deleteOne();
    res.json({ ok: true });
  });

  app.get('/api/settings', requireAuth, async (_req, res) => {
    const settings = await getSettings();
    res.json(settings);
  });

  app.put('/api/settings', requireAuth, async (req, res) => {
    const raw = req.body?.autoSendDelayMs;
    const autoSendDelayMs = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(autoSendDelayMs) || autoSendDelayMs < 0) {
      res.status(400).json({ error: 'autoSendDelayMs must be a non-negative number (0 disables auto-send)' });
      return;
    }
    const settings = await updateSettings({ autoSendDelayMs });
    res.json(settings);
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