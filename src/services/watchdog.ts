import { TelegramClient } from 'telegram';
import { Raw } from 'telegram/events';
import { UpdateConnectionState } from 'telegram/network';
import { catchUpUnread } from './catch-up';

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_STUCK_MS = 180000;
const DEFAULT_MAX_RECOVERIES = 10;

export function watchdogIntervalMs(): number {
  const n = Number(process.env.WATCHDOG_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

export function watchdogStuckMs(): number {
  const n = Number(process.env.WATCHDOG_STUCK_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STUCK_MS;
}

function watchdogMaxRecoveries(): number {
  const n = Number(process.env.WATCHDOG_MAX_RECOVERIES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_RECOVERIES;
}

let lastConnectedAt = Date.now();
let lastState = 'unknown';
let consecutiveFailures = 0;
let stopped = false;

export function connectionState(): string {
  return lastState;
}

function didConnect(): void {
  const prev = lastState;
  lastState = 'connected';
  lastConnectedAt = Date.now();
  consecutiveFailures = 0;
  if (prev !== 'connected') {
    console.log(`[watchdog] connection re-established at ${new Date().toISOString()}`);
  }
}

function didDisconnect(): void {
  lastState = 'disconnected';
  console.log(
    `[watchdog] connection: disconnected at ${new Date().toISOString()} (was ${lastState === 'connected' ? 'connected' : 'not connected'})`
  );
}

function didBreak(): void {
  lastState = 'broken';
  console.log(
    `[watchdog] connection: broken at ${new Date().toISOString()} (was ${lastState === 'connected' ? 'connected' : 'not connected'})`
  );
}

export function installConnectionStateHook(client: TelegramClient): void {
  client.addEventHandler((update) => {
    if (!(update instanceof UpdateConnectionState)) {
      return;
    }
    const value = (update as UpdateConnectionState).state;
    if (value === UpdateConnectionState.connected) {
      didConnect();
    } else if (value === UpdateConnectionState.disconnected) {
      didDisconnect();
    } else if (value === UpdateConnectionState.broken) {
      didBreak();
    }
  }, new Raw({ types: [UpdateConnectionState] } as never));
}

async function forceReconnect(client: TelegramClient): Promise<boolean> {
  try {
    console.log('[watchdog] forcing reconnect (disconnect + connect)…');
    await client.disconnect();
    await client.connect();
    if (!(await client.checkAuthorization())) {
      throw new Error('session no longer authorized');
    }
    return true;
  } catch (err) {
    console.error('[watchdog] forced reconnect failed:', err);
    return false;
  }
}

export function startConnectionWatchdog(client: TelegramClient): void {
  stopped = false;
  consecutiveFailures = 0;
  lastConnectedAt = Date.now();
  lastState = 'connected';

  const intervalMs = watchdogIntervalMs();
  const stuckMs = watchdogStuckMs();
  const maxRecoveries = watchdogMaxRecoveries();

  setInterval(async () => {
    if (stopped) {
      return;
    }
    const connectedNow = client.connected;
    if (connectedNow) {
      didConnect();
      return;
    }

    const downMs = Date.now() - lastConnectedAt;
    if (downMs < stuckMs || lastState === 'unknown') {
      return;
    }

    if (consecutiveFailures >= maxRecoveries) {
      if (!stopped) {
        stopped = true;
        console.error(
          `[watchdog] still disconnected after ${consecutiveFailures} recovery attempts at ${new Date().toISOString()} - ` +
            'waiting for manual restart. Restart the service to resume auto-recovery.'
        );
      }
      return;
    }

    const ok = await forceReconnect(client);
    if (ok) {
      consecutiveFailures = 0;
      didConnect();
      console.log('[watchdog] running catch-up after reconnect…');
      try {
        await catchUpUnread(client);
      } catch (err) {
        console.error('[watchdog] catch-up after reconnect failed (continuing):', err);
      }
    } else {
      consecutiveFailures += 1;
      console.error(
        `[watchdog] recovery attempt ${consecutiveFailures}/${maxRecoveries} failed; retrying in ${intervalMs}ms`
      );
    }
  }, intervalMs);

  console.log(
    `[watchdog] monitoring connection every ${intervalMs}ms (stuck threshold ${stuckMs}ms, max recoveries ${maxRecoveries})`
  );
}