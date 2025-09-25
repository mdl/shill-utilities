import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export type MultiUserConfig = {
  telegram: {
    api_id: number;
    api_hash: string;
    session_dir: string;
  };
  users: Array<{
    phone: string;
    password?: string;
  }> | string[];
  runtime: {
    groups_only: boolean; // consider only groups/megagroups for commenting
    comments_source: string; // username or t.me link or id of the channel with comment templates
    comments_refresh_minutes: number; // default 30
    ignore_probability: number; // 0..1 chance to ignore a new post (default 0.5)
    max_comment_history?: number; // how many recent messages to collect from the comments_source (default 200)
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

export function loadMultiConfig(configPath?: string): MultiUserConfig {
  const cfgPath = path.resolve(configPath || 'config/multi_commenter.yml');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Missing ${cfgPath}. Provide a config file for multi_commenter.`);
  }
  const cfg: any = readYamlFile(cfgPath);

  // Normalize users
  if (!cfg.users || !Array.isArray(cfg.users) || cfg.users.length === 0) {
    throw new Error('users must be provided as a non-empty array in multi config.');
  }
  const users: Array<{ phone: string; password?: string }>
    = (cfg.users as any[]).map((u) => {
      if (typeof u === 'string') return { phone: u };
      if (!u || typeof u.phone !== 'string') throw new Error('Each user must have a phone string.');
      return { phone: u.phone, password: u.password };
    });

  // Telegram credentials
  if (!cfg.telegram || !cfg.telegram.api_id || !cfg.telegram.api_hash) {
    throw new Error('telegram.api_id and telegram.api_hash must be set in multi config.');
  }
  if (!cfg.telegram.session_dir || typeof cfg.telegram.session_dir !== 'string') {
    throw new Error('telegram.session_dir must be provided as a string in multi config.');
  }
  const sessionDir = path.resolve(cfg.telegram.session_dir);
  try {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  } catch (e) {
    console.error('[multi-config] Failed to ensure session_dir exists:', e);
  }

  // Runtime
  if (!cfg.runtime) throw new Error('runtime section is required in multi config.');
  const groups_only = Boolean(cfg.runtime.groups_only);
  const comments_source = String(cfg.runtime.comments_source || '').trim();
  if (!comments_source) throw new Error('runtime.comments_source must be set (channel username or link).');
  const comments_refresh_minutes = Number(cfg.runtime.comments_refresh_minutes ?? 30);
  const ignore_probability = Number(cfg.runtime.ignore_probability ?? 0.5);
  const max_comment_history = Number(cfg.runtime.max_comment_history ?? 200);
  if (!Number.isFinite(comments_refresh_minutes) || comments_refresh_minutes <= 0) {
    throw new Error('runtime.comments_refresh_minutes must be a positive number.');
  }
  if (!Number.isFinite(ignore_probability) || ignore_probability < 0 || ignore_probability > 1) {
    throw new Error('runtime.ignore_probability must be a number in [0, 1].');
  }
  if (!Number.isFinite(max_comment_history) || max_comment_history <= 0) {
    throw new Error('runtime.max_comment_history must be a positive number.');
  }

  return {
    telegram: {
      api_id: Number(cfg.telegram.api_id),
      api_hash: String(cfg.telegram.api_hash),
      session_dir: sessionDir,
    },
    users,
    runtime: {
      groups_only,
      comments_source,
      comments_refresh_minutes,
      ignore_probability,
      max_comment_history,
    },
  } as MultiUserConfig;
}
