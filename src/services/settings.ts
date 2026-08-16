import { SettingsModel } from '../models/Settings';

const SETTINGS_KEY = 'global';
const DEFAULT_DELAY_MS = 240000;

let cached: { autoSendDelayMs: number } | null = null;

function delayFromEnv(): number {
  const raw = process.env.AUTO_SEND_DELAY_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_DELAY_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DELAY_MS;
}

export async function ensureSettings(): Promise<{ autoSendDelayMs: number }> {
  if (cached) {
    return cached;
  }
  let doc = await SettingsModel.findOne({ key: SETTINGS_KEY }).exec();
  if (!doc) {
    doc = await SettingsModel.create({
      key: SETTINGS_KEY,
      autoSendDelayMs: delayFromEnv(),
    });
  }
  cached = { autoSendDelayMs: doc.autoSendDelayMs };
  return cached;
}

export async function getSettings(): Promise<{ autoSendDelayMs: number }> {
  return ensureSettings();
}

export async function updateSettings(patch: {
  autoSendDelayMs?: number;
}): Promise<{ autoSendDelayMs: number }> {
  const current = await ensureSettings();
  const next = {
    autoSendDelayMs:
      patch.autoSendDelayMs !== undefined && Number.isFinite(patch.autoSendDelayMs)
        ? Math.max(0, Math.floor(patch.autoSendDelayMs))
        : current.autoSendDelayMs,
  };
  await SettingsModel.updateOne(
    { key: SETTINGS_KEY },
    { $set: { ...next, updatedAt: new Date() } },
    { upsert: true }
  );
  cached = next;
  return next;
}