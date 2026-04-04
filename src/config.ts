import os from "node:os";
import path from "node:path";

import { loadConfig } from "./config/index.js";
import { readEnvFile } from "./env.js";
import { isValidTimezone } from "./timezone.js";

// Read config values from app config and .env (falls back to process.env).
const envConfig = readEnvFile(["NANOCLAW_ASSISTANT_NAME", "TZ"]);
const appConfig = loadConfig();

export const ASSISTANT_NAME = process.env.NANOCLAW_ASSISTANT_NAME || envConfig.NANOCLAW_ASSISTANT_NAME || appConfig.assistantName;
export const ASSISTANT_HAS_OWN_NUMBER = false;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = appConfig.schedulerPollIntervalMs;

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = appConfig.mountAllowlistPath;
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, ".config", "nanoclaw", "sender-allowlist.json");
export const STORE_DIR = path.resolve(PROJECT_ROOT, "store");
export const GROUPS_DIR = appConfig.groupsRoot;
export const DATA_DIR = appConfig.dataRoot;
export const LOGS_DIR = appConfig.logsRoot;

export const CONTAINER_IMAGE = appConfig.containerImage;
export const CONTAINER_TIMEOUT = appConfig.runtimeTimeoutMs;
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || "10485760", 10); // 10MB default
export const ONECLI_URL = "http://localhost:10254";
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || "10", 10) || 10);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || "1800000", 10); // 30min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, appConfig.maxConcurrency);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, "i");
}

export const DEFAULT_TRIGGER = appConfig.defaultTrigger || `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, appConfig.defaultTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return "UTC";
}

export const TIMEZONE = resolveConfigTimezone();
