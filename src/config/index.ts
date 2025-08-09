import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export type AppConfig = {
  telegram: {
    api_id: number;
    api_hash: string;
    phone?: string;
    password?: string;
    session_file: string;
  };
  runtime: {
    refresh_groups_interval_minutes: number;
    post_interval_minutes: number;
    groups_only: boolean;
  };
  messages: {
    list: string[];
  };
};

const DEFAULT_CONFIG: AppConfig = {
  telegram: {
    api_id: 0,
    api_hash: '',
    session_file: 'sessions/telegram.session',
  },
  runtime: {
    refresh_groups_interval_minutes: 120,
    post_interval_minutes: 5,
    groups_only: true,
  },
  messages: {
    list: ['Hello from the bot!', 'Automated message', 'Have a great day!'],
  },
};

function readYamlFile(filePath: string): any {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return YAML.parse(content) || {};
  } catch (e) {
    return {};
  }
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [key, value] of Object.entries(override as Record<string, any>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      (result as any)[key] = deepMerge((result as any)[key] || {}, value);
    } else if (value !== undefined) {
      (result as any)[key] = value;
    }
  }
  return result as T;
}

export function loadConfig(): AppConfig {
  const examplePath = path.resolve('config/config.example.yml');
  const configPath = path.resolve('config/config.yml');

  const base = DEFAULT_CONFIG;
  const example = readYamlFile(examplePath);
  const user = readYamlFile(configPath);

  // Merge order: defaults <- example <- user
  let cfg = deepMerge(base, example);
  cfg = deepMerge(cfg, user);

  // ENV overrides
  const envApiId = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined;
  const envApiHash = process.env.TELEGRAM_API_HASH;
  const envPhone = process.env.TELEGRAM_PHONE;
  const envPassword = process.env.TELEGRAM_PASSWORD;

  if (envApiId) cfg.telegram.api_id = envApiId;
  if (envApiHash) cfg.telegram.api_hash = envApiHash;
  if (envPhone) cfg.telegram.phone = envPhone;
  if (envPassword) cfg.telegram.password = envPassword;

  // Normalize types and paths
  cfg.runtime.refresh_groups_interval_minutes = Number(cfg.runtime.refresh_groups_interval_minutes) || DEFAULT_CONFIG.runtime.refresh_groups_interval_minutes;
  cfg.runtime.post_interval_minutes = Number(cfg.runtime.post_interval_minutes) || DEFAULT_CONFIG.runtime.post_interval_minutes;
  cfg.telegram.session_file = path.resolve(cfg.telegram.session_file || DEFAULT_CONFIG.telegram.session_file);

  // Ensure session directory exists
  try {
    const dir = path.dirname(cfg.telegram.session_file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[config] Failed to ensure session directory exists:', e);
  }

  // Basic validation
  if (!cfg.telegram.api_id || !cfg.telegram.api_hash) {
    throw new Error('Telegram API credentials missing. Please set telegram.api_id and telegram.api_hash in config/config.yml or environment variables TELEGRAM_API_ID and TELEGRAM_API_HASH.');
  }

  if (!cfg.messages.list || cfg.messages.list.length === 0) {
    console.warn('[config] messages.list is empty. Using default example messages.');
    cfg.messages.list = DEFAULT_CONFIG.messages.list;
  }

  return cfg;
}
