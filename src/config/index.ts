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


function readYamlFile(filePath: string): any {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return YAML.parse(content) || {};
  } catch (e) {
    return {};
  }
}


export function loadConfig(): AppConfig {
  const configPath = path.resolve('config/config.yml');
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing config/config.yml. Provide a single config.yml with all required fields.');
  }
  const cfg: any = readYamlFile(configPath);

  // ENV overrides
  const envApiId = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined;
  const envApiHash = process.env.TELEGRAM_API_HASH;
  const envPhone = process.env.TELEGRAM_PHONE;
  const envPassword = process.env.TELEGRAM_PASSWORD;

  cfg.telegram = cfg.telegram || {};
  if (envApiId) cfg.telegram.api_id = envApiId;
  if (envApiHash) cfg.telegram.api_hash = envApiHash;
  if (envPhone) cfg.telegram.phone = envPhone;
  if (envPassword) cfg.telegram.password = envPassword;

  // Basic validation and normalization
  if (!cfg.telegram || !cfg.telegram.api_id || !cfg.telegram.api_hash) {
    throw new Error('Telegram API credentials missing. Set telegram.api_id and telegram.api_hash in config/config.yml or environment variables TELEGRAM_API_ID and TELEGRAM_API_HASH.');
  }

  if (!cfg.runtime) throw new Error('Missing runtime section in config/config.yml.');
  cfg.runtime.refresh_groups_interval_minutes = Number(cfg.runtime.refresh_groups_interval_minutes);
  cfg.runtime.post_interval_minutes = Number(cfg.runtime.post_interval_minutes);
  if (!Number.isFinite(cfg.runtime.refresh_groups_interval_minutes) || cfg.runtime.refresh_groups_interval_minutes <= 0) {
    throw new Error('runtime.refresh_groups_interval_minutes must be a positive number in config/config.yml.');
  }
  if (!Number.isFinite(cfg.runtime.post_interval_minutes) || cfg.runtime.post_interval_minutes <= 0) {
    throw new Error('runtime.post_interval_minutes must be a positive number in config/config.yml.');
  }
  if (typeof cfg.runtime.groups_only !== 'boolean') {
    throw new Error('runtime.groups_only must be a boolean in config/config.yml.');
  }

  if (!cfg.telegram.session_file || typeof cfg.telegram.session_file !== 'string') {
    throw new Error('telegram.session_file must be provided in config/config.yml.');
  }
  cfg.telegram.session_file = path.resolve(cfg.telegram.session_file);

  // Ensure session directory exists
  try {
    const dir = path.dirname(cfg.telegram.session_file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[config] Failed to ensure session directory exists:', e);
  }

  if (!cfg.messages || !Array.isArray(cfg.messages.list)) {
    throw new Error('messages.list must be provided as an array in config/config.yml.');
  }

  return cfg as AppConfig;
}
