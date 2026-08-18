import { SettingsModel } from '../models/Settings';

const SETTINGS_KEY = 'global';
const DEFAULT_DELAY_MS = 240000;

export interface AppSettings {
  autoSendDelayMs: number;
  name: string;
  gender: '' | 'male' | 'female' | 'they';
}

const GENDERS: AppSettings['gender'][] = ['', 'male', 'female', 'they'];

function delayFromEnv(): number {
  const raw = process.env.AUTO_SEND_DELAY_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_DELAY_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DELAY_MS;
}

function normalizeGender(raw: unknown): AppSettings['gender'] {
  return GENDERS.includes(raw as AppSettings['gender']) ? (raw as AppSettings['gender']) : '';
}

export async function ensureSettings(): Promise<AppSettings> {
  let doc = await SettingsModel.findOne({ key: SETTINGS_KEY }).exec();
  if (!doc) {
    doc = await SettingsModel.create({
      key: SETTINGS_KEY,
      autoSendDelayMs: delayFromEnv(),
    });
  }
  return {
    autoSendDelayMs: doc.autoSendDelayMs,
    name: doc.name || '',
    gender: normalizeGender(doc.gender),
  };
}

export async function getSettings(): Promise<AppSettings> {
  return ensureSettings();
}

export async function updateSettings(patch: {
  autoSendDelayMs?: number;
  name?: string;
  gender?: AppSettings['gender'];
}): Promise<AppSettings> {
  const current = await ensureSettings();
  const next: AppSettings = {
    autoSendDelayMs:
      patch.autoSendDelayMs !== undefined && Number.isFinite(patch.autoSendDelayMs)
        ? Math.max(0, Math.floor(patch.autoSendDelayMs))
        : current.autoSendDelayMs,
    name:
      typeof patch.name === 'string' ? patch.name.trim() : current.name,
    gender: patch.gender !== undefined ? normalizeGender(patch.gender) : current.gender,
  };
  await SettingsModel.updateOne(
    { key: SETTINGS_KEY },
    { $set: { ...next, updatedAt: new Date() } },
    { upsert: true }
  );
  return next;
}
