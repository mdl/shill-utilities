import { loadConfig } from '../config';
import { TelegramService } from '../telegram/TelegramService';

function minutes(n: number) {
  return Math.max(1, Math.floor(n)) * 60 * 1000;
}

function pickRandom<T>(arr: T[]): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  const i = Math.floor(Math.random() * arr.length);
  return arr[i];
}

async function main() {
  // Global error handlers for 24/7 stability
  process.on('unhandledRejection', (reason: any) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error('[global] Unhandled Rejection:', msg);
  });
  process.on('uncaughtException', (err: any) => {
    console.error('[global] Uncaught Exception:', err?.stack || err?.message || err);
  });

  const config = loadConfig();
  const service = new TelegramService(config);

  let refreshTimer: NodeJS.Timeout | null = null;
  let postTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  async function cleanup(code: number = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[main] Shutting down...');
    try {
      if (refreshTimer) clearInterval(refreshTimer);
      if (postTimer) clearInterval(postTimer);
      await service.disconnect();
    } catch (e) {
      console.error('[main] Error during cleanup:', e);
    } finally {
      process.exit(code);
    }
  }

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));

  try {
    await service.init();
  } catch (e) {
    console.error('[main] Failed to initialize Telegram service:', e);
    await cleanup(1);
    return; // just in case
  }

  // Helper to safely run periodic tasks
  const safeTask = (name: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e: any) {
      console.error(`[task:${name}] error:`, e?.stack || e?.message || e);
    }
  };

  // Initial writable groups fetch already done in init(), but run again to be safe.
  await safeTask('refreshGroups', () => service.updateWritableGroups())();

  // Schedule refresh groups
  const refreshMs = minutes(config.runtime.refresh_groups_interval_minutes);
  refreshTimer = setInterval(safeTask('refreshGroups', () => service.updateWritableGroups()), refreshMs);
  console.log(`[main] Scheduled group refresh every ${Math.round(refreshMs / 60000)} minutes.`);

  // Schedule posting
  const postMs = minutes(config.runtime.post_interval_minutes);
  const postTask = safeTask('postMessage', async () => {
    const list = (config.messages.list || []).map((s) => (s || '').trim()).filter(Boolean);
    if (list.length === 0) {
      console.warn('[main] No messages configured. Skipping post cycle.');
      return;
    }
    const text = pickRandom(list);
    if (!text) return; // should not happen due to filter above

    const ok = await service.sendRandomMessage(text);
    if (!ok) {
      // Peer list might be stale; attempt to refresh in background
      await service.updateWritableGroups();
    }
  });
  postTimer = setInterval(postTask, postMs);
  console.log(`[main] Scheduled posting every ${Math.round(postMs / 60000)} minutes.`);

  // Keep process alive
}

main().catch((e) => {
  console.error('[main] Fatal error:', e);
  process.exit(1);
});
