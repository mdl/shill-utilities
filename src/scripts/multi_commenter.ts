import path from 'path';
import { TelegramClient, Api, errors, Logger } from 'telegram';
import { StoreSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { loadMultiConfig, MultiUserConfig } from '../config/multi';
import { prompt } from '../utils/prompt';

// Utilities
function minutes(n: number) { return Math.max(1, Math.floor(n)) * 60 * 1000; }
function sleep(ms: number) { return new Promise((res) => setTimeout(res, ms)); }
function sanitizeForFs(name: string) { return name.replace(/[^0-9A-Za-z_.-]/g, '_'); }
function pickRandom<T>(arr: T[]): T | undefined { if (!arr || arr.length === 0) return undefined; return arr[Math.floor(Math.random() * arr.length)]; }

// Helper to stringify peer id similar to TelegramService
function peerIdString(entity: any): string {
  try {
    if (entity instanceof Api.Channel) return `channel_${entity.id.toString()}`;
    if (entity instanceof Api.Chat) return `chat_${entity.id.toString()}`;
    if (entity instanceof Api.User) return `user_${entity.id.toString()}`;
  } catch {}
  return 'peer_unknown';
}

// Types for per-client state
type ClientState = {
  client: TelegramClient;
  phone: string;
  selfId?: string; // current user's id string
  writablePeers: Map<string, { title: string; input: Api.TypeInputPeer }>; // key = peerIdString
};

async function loginClient(client: TelegramClient, phone: string, password?: string) {
  const phoneNumber = phone || (await prompt('Enter phone number (E.164): '));
  await client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => await prompt('Enter the code you received: '),
    password: async () => password ?? (await prompt('Enter your 2FA password (if any): ', { mask: true })),
    onError: (err) => console.error(`[telegram:${phoneNumber}] start() error:`, err),
  });
  await new Promise((res) => setTimeout(res, 5000));
}

async function getWritablePeers(client: TelegramClient, groupsOnly: boolean): Promise<Map<string, { title: string; input: Api.TypeInputPeer }>> {
  const dialogs = await client.getDialogs({});
  const map = new Map<string, { title: string; input: Api.TypeInputPeer }>();
  for (const d of dialogs) {
    try {
      const title = (d as any).title || (d as any).name || 'Unknown';
      const input = (d as any).inputEntity as Api.TypeInputPeer;
      const entity = (d as any).entity as any;
      const isGroup = (d as any).isGroup === true;
      const isUser = (d as any).isUser === true;
      if (!input || !entity) continue;
      if (groupsOnly) {
        if (!isGroup) continue;
      } else {
        if (!(isGroup || isUser)) continue;
      }
      if (entity instanceof Api.Channel) {
        if (entity.left) continue;
        if (entity.broadcast) continue; // skip broadcast channels (read-only)
        if (entity.megagroup !== true) continue;
        const br: any = (entity as any).bannedRights;
        if (br && br.send_messages) continue;
      } else if (entity instanceof Api.Chat) {
        if ((entity as any).deactivated) continue;
        if ((entity as any).left) continue;
        const dbr: any = (entity as any).defaultBannedRights;
        if (dbr && dbr.send_messages) continue;
      } else if (entity instanceof Api.User) {
        if (groupsOnly) continue;
        if ((entity as any).bot) continue;
      }
      const id = peerIdString(entity);
      map.set(id, { title, input });
    } catch (e) {
      console.warn('[multi] Skipping dialog due to parse error:', e);
    }
  }
  return map;
}

async function fetchCommentTemplates(client: TelegramClient, source: string, limit: number): Promise<string[]> {
  try {
    const entity = await client.getEntity(source as any);
    const res: any = await client.getMessages(entity as any, { limit: Math.max(1, Math.min(500, limit)) });
    const texts: string[] = [];
    for (const m of res) {
      try {
        const txt = (m as any).message || (m as any).text || '';
        const clean = String(txt || '').trim();
        if (clean) texts.push(clean);
      } catch {}
    }
    return texts;
  } catch (e: any) {
    console.error('[multi] Failed to fetch comments from source:', e?.message || e);
    return [];
  }
}

async function main() {
  // Global error handlers
  process.on('unhandledRejection', (reason: any) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error('[global] Unhandled Rejection:', msg);
  });
  process.on('uncaughtException', (err: any) => {
    console.error('[global] Uncaught Exception:', err?.stack || err?.message || err);
  });

  Logger.setLevel('none');

  // CLI: allow --config path
  const argv = process.argv.slice(2);
  let cfgPath: string | undefined;
  const cfgIdx = argv.indexOf('--config');
  if (cfgIdx >= 0 && argv[cfgIdx + 1]) cfgPath = argv[cfgIdx + 1];

  const config: MultiUserConfig = loadMultiConfig(cfgPath);

  const clients: ClientState[] = [];
  let shuttingDown = false;
  let commentsCache: string[] = [];
  let commentsTimer: NodeJS.Timeout | null = null;

  async function cleanup(code: number = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[multi] Shutting down...');
    try {
      if (commentsTimer) clearInterval(commentsTimer);
      for (const c of clients) {
        try { await c.client.disconnect(); } catch {}
      }
    } finally {
      process.exit(code);
    }
  }
  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));

  // Initialize clients sequentially to simplify login
  for (let i = 0; i < config.users.length; i++) {
    const u = (config.users as any)[i];
    const phone: string = typeof u === 'string' ? u : u.phone;
    const password: string | undefined = typeof u === 'string' ? undefined : u.password;

    const sessionFile = path.join(config.telegram.session_dir, `${sanitizeForFs(phone)}.session`);
    const client = new TelegramClient(new StoreSession(sessionFile), config.telegram.api_id, config.telegram.api_hash, {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      floodSleepThreshold: 60,
    });

    console.log(`[multi] Connecting client ${i + 1}/${config.users.length} (${phone})...`);
    await client.connect().catch(() => {});
    if (!(await client.checkAuthorization())) {
      console.log(`[multi] Login required for ${phone}.`);
      await loginClient(client, phone, password);
    }

    // resolve self id
    try {
      const me = await client.getMe(false);
      const selfId = (me as any)?.id?.toString?.() || String((me as any)?.id);
      const writablePeers = await getWritablePeers(client, config.runtime.groups_only);
      console.log(`[multi] ${phone}: writable peers ${writablePeers.size}`);
      clients.push({ client, phone, selfId, writablePeers });
    } catch (e) {
      const writablePeers = await getWritablePeers(client, config.runtime.groups_only);
      console.log(`[multi] ${phone}: writable peers ${writablePeers.size}`);
      clients.push({ client, phone, writablePeers });
    }
  }

  if (clients.length === 0) {
    console.error('[multi] No clients initialized. Exiting.');
    await cleanup(1);
    return;
  }

  // Compute intersection of peer ids
  const idSets = clients.map((c) => new Set(Array.from(c.writablePeers.keys())));
  let commonIds: Set<string> = new Set(idSets[0]);
  for (let i = 1; i < idSets.length; i++) {
    const nxt = new Set<string>();
    for (const id of commonIds) { if (idSets[i].has(id)) nxt.add(id); }
    commonIds = nxt;
  }

  if (commonIds.size === 0) {
    console.warn('[multi] No common channels/groups found among all users. The script will idle.');
  } else {
    console.log(`[multi] Common peers across all users: ${commonIds.size}`);
  }

  // Prepare watcher on the first client
  const watcher = clients[0].client;

  // Populate initial comments cache
  commentsCache = await fetchCommentTemplates(watcher, config.runtime.comments_source, config.runtime.max_comment_history || 200);
  if (commentsCache.length === 0) {
    console.warn('[multi] Comment templates are empty. Will try again on the next refresh.');
  } else {
    console.log(`[multi] Loaded ${commentsCache.length} comment templates.`);
  }

  // Periodic refresh of comments
  const refreshMs = minutes(config.runtime.comments_refresh_minutes);
  commentsTimer = setInterval(async () => {
    try {
      const list = await fetchCommentTemplates(watcher, config.runtime.comments_source, config.runtime.max_comment_history || 200);
      if (list.length > 0) {
        commentsCache = list;
        console.log(`[multi] Refreshed comment templates: ${commentsCache.length}`);
      } else {
        console.warn('[multi] Comment templates refresh returned empty list; keeping previous cache.');
      }
    } catch (e) {
      console.error('[multi] Error refreshing comment templates:', e);
    }
  }, refreshMs);
  console.log(`[multi] Scheduled comments refresh every ${Math.round(refreshMs / 60000)} minutes.`);

  // Helper to find per-client input for a peer id
  function getClientInputForPeer(peerId: string, clientState: ClientState): Api.TypeInputPeer | undefined {
    const rec = clientState.writablePeers.get(peerId);
    return rec?.input;
  }

  // Subscribe to new messages and reply probabilistically
  watcher.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const chat = await event.getChat();
      if (!chat) return;
      const pid = peerIdString(chat);
      if (!commonIds.has(pid)) return; // not one of the common peers

      // Skip messages authored by any of our own clients to avoid reply loops
      try {
        const fromId: any = (event.message as any)?.fromId;
        let senderUid: string | undefined;
        if (fromId && fromId.className === 'PeerUser') {
          senderUid = (fromId.userId as any)?.toString?.() || String((fromId as any).userId);
        }
        if (senderUid) {
          for (const c of clients) {
            if (c.selfId && c.selfId === senderUid) return; // authored by one of us
          }
        }
      } catch {}

      // New message in a common peer detected
      const ignore = Math.random() < config.runtime.ignore_probability;
      if (ignore) {
        // console.log('[multi] Ignoring new post due to probability gate.');
        return;
      }

      // Pick comment and client
      let comment = pickRandom(commentsCache) || '';
      if (!comment) {
        // last-resort fetch
        const list = await fetchCommentTemplates(watcher, config.runtime.comments_source, config.runtime.max_comment_history || 200);
        commentsCache = list;
        comment = pickRandom(commentsCache) || '';
      }
      if (!comment) return; // nothing to post

      const chosen = pickRandom(clients);
      if (!chosen) return;
      const inputPeer = getClientInputForPeer(pid, chosen);
      if (!inputPeer) return;

      const msgId = (event.message as any)?.id as number | undefined;

      try {
        await chosen.client.sendMessage(inputPeer, { message: comment, replyTo: msgId });
        console.log(`[multi] Replied in ${pid} as ${chosen.phone}`);
      } catch (e: any) {
        if (e instanceof errors.FloodWaitError) {
          const seconds = (e as any).seconds || 0;
          console.warn(`[multi] Flood wait for ${seconds}s while replying. Skipping this event.`);
          return;
        }
        console.error('[multi] Failed to send comment:', e?.message || e);
      }
    } catch (e) {
      console.error('[multi] Handler error:', e);
    }
  }, new NewMessage({}));

  console.log('[multi] Listening for new posts in common channels/groups...');
}

main().catch((e) => {
  console.error('[multi] Fatal error:', e);
  process.exit(1);
});
