import { TelegramClient, Api, errors, Logger } from 'telegram';
import { StoreSession } from 'telegram/sessions';
import type { AppConfig } from '../config';
import { prompt } from '../utils/prompt';

export type WritablePeer = {
  title: string;
  input: Api.TypeInputPeer;
  id: string; // string identifier for logging
};

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export class TelegramService {
  private client!: TelegramClient;
  private config: AppConfig;
  private writablePeers: WritablePeer[] = [];
  private started = false;

  constructor(config: AppConfig) {
    this.config = config;
  }

  public isStarted() {
    return this.started;
  }


  public async init(): Promise<void> {
    // Optional: Reduce GramJS logging noise
    Logger.setLevel('none');

    // Use StoreSession to avoid manual session persistence
    const storeKey = this.config.telegram.session_file || 'telegram_session';
    this.client = new TelegramClient(new StoreSession(storeKey), this.config.telegram.api_id, this.config.telegram.api_hash, {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      floodSleepThreshold: 60,
    });

    try {
      await this.client.connect();
    } catch (e) {
      console.error('[telegram] Connection error during init:', e);
    }

    try {
      if (!(await this.client.checkAuthorization())) {
        await this.loginFlow();
      }
      this.started = true;
      console.log('[telegram] Logged in successfully.');
    } catch (e) {
      console.error('[telegram] Login failed:', e);
      throw e;
    }

    // Initial population of writable groups
    await this.updateWritableGroups();
  }

  private async loginFlow() {
    const cfg = this.config.telegram;
    console.log('[telegram] Starting login flow...');

    const phone = cfg.phone || (await prompt('Enter your phone number (E.164 format): '));

    await this.client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        const code = await prompt('Enter the code you received: ');
        return code;
      },
      password: async () => {
        if (cfg.password) return cfg.password;
        const pwd = await prompt('Enter your 2FA password (if any): ', { mask: true });
        return pwd;
      },
      onError: (err) => console.error('[telegram] start() error:', err),
    });
  }

  public async updateWritableGroups(): Promise<void> {
    if (!this.client) throw new Error('Client not initialized');
    try {
      const dialogs = await this.client.getDialogs({});
      const nextPeers: WritablePeer[] = [];

      for (const d of dialogs) {
        try {
          const title = (d as any).title || (d as any).name || 'Unknown';
          const input = (d as any).inputEntity as Api.TypeInputPeer;
          const entity = (d as any).entity as any;
          const isGroup = (d as any).isGroup === true;
          const isUser = (d as any).isUser === true;

          if (!input || !entity) continue;

          if (this.config.runtime.groups_only) {
            if (!isGroup) continue;
          } else {
            // allow users and groups
            if (!(isGroup || isUser)) continue;
          }

          // Heuristics to detect write permission
          if (entity instanceof Api.Channel) {
            if (entity.left) continue;
            if (entity.broadcast) continue; // broadcast channels are read-only
            if (entity.megagroup !== true) continue; // keep to megagroups only for safety
            // If banned rights are present and send_messages is true, skip
            const br: any = (entity as any).bannedRights;
            if (br && br.send_messages) continue;
          } else if (entity instanceof Api.Chat) {
            if ((entity as any).deactivated) continue;
            if ((entity as any).left) continue;
            const dbr: any = (entity as any).defaultBannedRights;
            if (dbr && dbr.send_messages) continue;
          } else if (entity instanceof Api.User) {
            if (this.config.runtime.groups_only) continue;
            if ((entity as any).bot) continue; // skip bots for DMs
          }

          const id = this.peerIdString(entity);
          nextPeers.push({ title, input, id });
        } catch (inner) {
          console.warn('[telegram] Skipping dialog due to parse error:', inner);
        }
      }

      this.writablePeers = nextPeers;
      console.log(`[telegram] Writable peers updated: ${this.writablePeers.length}`);
    } catch (e) {
      console.error('[telegram] Failed to update writable groups:', e);
    }
  }

  private peerIdString(entity: any): string {
    try {
      if (entity instanceof Api.Channel) {
        return `channel_${entity.id.toString()}`;
      }
      if (entity instanceof Api.Chat) {
        return `chat_${entity.id.toString()}`;
      }
      if (entity instanceof Api.User) {
        return `user_${entity.id.toString()}`;
      }
    } catch {}
    return 'peer_unknown';
  }

  public getWritablePeers(): WritablePeer[] {
    return [...this.writablePeers];
  }

  public pickRandomPeer(): WritablePeer | undefined {
    if (this.writablePeers.length === 0) return undefined;
    const idx = Math.floor(Math.random() * this.writablePeers.length);
    return this.writablePeers[idx];
  }

  public async sendMessageTo(input: Api.TypeInputPeer, message: string): Promise<boolean> {
    try {
      await this.client.sendMessage(input, { message });
      return true;
    } catch (e: any) {
      if (e instanceof errors.FloodWaitError) {
        const seconds = (e as any).seconds || 0;
        console.warn(`[telegram] Flood wait for ${seconds}s. Waiting...`);
        // Wait once then return false to let scheduler try next time
        if (seconds > 0 && seconds < 3600) {
          await sleep((seconds + 1) * 1000);
        }
        return false;
      }
      const msg = (e && e.message) ? String(e.message) : String(e);
      console.error('[telegram] sendMessage error:', msg);
      // Remove peer on certain errors
      if (/CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL|PEER_ID_INVALID|YOU_BLOCKED_USER/i.test(msg)) {
        // try to remove by matching input id
        this.writablePeers = this.writablePeers.filter((p) => p.input !== input);
      }
      return false;
    }
  }

  public async sendRandomMessage(text: string): Promise<boolean> {
    const peer = this.pickRandomPeer();
    if (!peer) {
      console.warn('[telegram] No writable peers available to send message.');
      return false;
    }
    console.log(`[telegram] Sending to "${peer.title}" (${peer.id})`);
    const ok = await this.sendMessageTo(peer.input, text);
    if (!ok) console.warn(`[telegram] Failed to send to "${peer.title}".`);
    return ok;
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.client) {
        await this.client.disconnect();
      }
    } catch (e) {
      console.error('[telegram] Error during disconnect:', e);
    }
  }
}
