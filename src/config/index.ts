import path from "node:path";
import { loadDotEnvFile } from "./dotenv.js";

export type GroupWorkspacePolicy = "group-scoped";
export type SandboxProviderMode = "container" | "local";
export type AgentRunnerMode = "codex" | "mock";
export type ContainerExecutorMode = "engine" | "process";
export type WebAuthMode = "trusted-proxy" | "dev-token";

export interface WebChannelConfig {
  enabled: boolean;
  bind: string;
  port: number;
  publicBaseUrl: string;
  allowedOrigins: string[];
  trustedProxies: string[];
  messageMaxChars: number;
  chatHistoryMaxChars: number;
  rateLimits: {
    connectPerMinute: number;
    sendPerMinute: number;
    historyPerMinute: number;
  };
  auth: {
    mode: WebAuthMode;
    trustedProxy: {
      userHeader: string;
      requiredHeaders: string[];
      allowUsers: string[];
    };
    devToken?: string;
  };
}

export interface AppConfig {
  dataRoot: string;
  groupsRoot: string;
  sqlitePath: string;
  sessionsRoot: string;
  ipcRoot: string;
  logsRoot: string;
  maxConcurrency: number;
  schedulerPollIntervalMs: number;
  codexBinaryPath: string;
  runtimeTimeoutMs: number;
  groupWorkspacePolicy: GroupWorkspacePolicy;
  sandboxProvider: SandboxProviderMode;
  containerExecutor: ContainerExecutorMode;
  containerEngineBinary: string;
  containerImage: string;
  containerRunnerEntrypoint: string;
  containerRunnerPathInImage: string;
  agentRunnerMode: AgentRunnerMode;
  assistantName: string;
  defaultTrigger: string;
  mountAllowlistPath: string;
  openaiApiBaseUrl: string;
  openaiCodexBaseUrl: string;
  defaultTimezone: string;
  containerSkillsPath: string;
  web: WebChannelConfig;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseWorkspacePolicy(value: string | undefined): GroupWorkspacePolicy {
  if (!value || value === "group-scoped") {
    return "group-scoped";
  }

  throw new Error(`Unsupported group workspace policy: ${value}`);
}

function parseSandboxProvider(value: string | undefined): SandboxProviderMode {
  if (!value || value === "container") {
    return "container";
  }

  if (value === "local") {
    return "local";
  }

  throw new Error(`Unsupported sandbox provider: ${value}`);
}

function parseAgentRunnerMode(value: string | undefined): AgentRunnerMode {
  if (!value || value === "codex") {
    return "codex";
  }

  if (value === "mock") {
    return "mock";
  }

  throw new Error(`Unsupported agent runner mode: ${value}`);
}

function parseContainerExecutor(value: string | undefined): ContainerExecutorMode {
  if (!value || value === "engine") {
    return "engine";
  }

  if (value === "process") {
    return "process";
  }

  throw new Error(`Unsupported container executor: ${value}`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWebAuthMode(value: string | undefined): WebAuthMode {
  if (!value || value === "trusted-proxy") {
    return "trusted-proxy";
  }
  if (value === "dev-token") {
    return "dev-token";
  }
  throw new Error(`Unsupported web auth mode: ${value}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const resolvedEnv = loadDotEnvFile(cwd, env);
  const dataRoot = path.resolve(cwd, resolvedEnv.NANOCLAW_DATA_ROOT ?? "data");
  const groupsRoot = path.resolve(cwd, resolvedEnv.NANOCLAW_GROUPS_ROOT ?? "groups");
  const sqlitePath = path.resolve(cwd, resolvedEnv.NANOCLAW_SQLITE_PATH ?? path.join("data", "db.sqlite"));
  const sessionsRoot = path.resolve(cwd, resolvedEnv.NANOCLAW_SESSIONS_ROOT ?? path.join("data", "sessions"));
  const ipcRoot = path.resolve(cwd, resolvedEnv.NANOCLAW_IPC_ROOT ?? path.join("data", "ipc"));
  const logsRoot = path.resolve(cwd, resolvedEnv.NANOCLAW_LOGS_ROOT ?? "logs");

  return {
    dataRoot,
    groupsRoot,
    sqlitePath,
    sessionsRoot,
    ipcRoot,
    logsRoot,
    maxConcurrency: parsePositiveInteger(resolvedEnv.NANOCLAW_MAX_CONCURRENCY, 2),
    schedulerPollIntervalMs: parsePositiveInteger(resolvedEnv.NANOCLAW_SCHEDULER_POLL_INTERVAL_MS, 1000),
    codexBinaryPath: resolvedEnv.NANOCLAW_CODEX_BINARY_PATH ?? "codex",
    runtimeTimeoutMs: parsePositiveInteger(resolvedEnv.NANOCLAW_RUNTIME_TIMEOUT_MS, 300_000),
    groupWorkspacePolicy: parseWorkspacePolicy(resolvedEnv.NANOCLAW_GROUP_WORKSPACE_POLICY),
    sandboxProvider: parseSandboxProvider(resolvedEnv.NANOCLAW_SANDBOX_PROVIDER),
    containerExecutor: parseContainerExecutor(resolvedEnv.NANOCLAW_CONTAINER_EXECUTOR),
    containerEngineBinary: resolvedEnv.NANOCLAW_CONTAINER_ENGINE_BINARY ?? "docker",
    containerImage: resolvedEnv.NANOCLAW_CONTAINER_IMAGE ?? "nanoclaw-codex-agent:latest",
    containerRunnerEntrypoint:
      resolvedEnv.NANOCLAW_CONTAINER_RUNNER_ENTRYPOINT ??
      path.resolve(cwd, "container", "agent-runner", "src", "index.ts"),
    containerRunnerPathInImage:
      resolvedEnv.NANOCLAW_CONTAINER_RUNNER_PATH_IN_IMAGE ?? "/app/dist/container/agent-runner/src/index.js",
    agentRunnerMode: parseAgentRunnerMode(resolvedEnv.NANOCLAW_AGENT_RUNNER_MODE),
    assistantName: resolvedEnv.NANOCLAW_ASSISTANT_NAME ?? "Andy",
    defaultTrigger: resolvedEnv.NANOCLAW_DEFAULT_TRIGGER ?? "@Andy",
    mountAllowlistPath:
      resolvedEnv.NANOCLAW_MOUNT_ALLOWLIST_PATH ??
      path.resolve(cwd, "config-examples", "mount-allowlist.json"),
    openaiApiBaseUrl: resolvedEnv.NANOCLAW_OPENAI_API_BASE_URL ?? "https://api.openai.com/v1",
    openaiCodexBaseUrl: resolvedEnv.NANOCLAW_OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex",
    defaultTimezone: resolvedEnv.NANOCLAW_DEFAULT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    containerSkillsPath: path.resolve(cwd, resolvedEnv.NANOCLAW_CONTAINER_SKILLS_PATH ?? path.join("container", "skills")),
    web: {
      enabled: parseBoolean(resolvedEnv.NANOCLAW_WEB_ENABLED, true),
      bind: resolvedEnv.NANOCLAW_WEB_BIND ?? "127.0.0.1",
      port: parsePositiveInteger(resolvedEnv.NANOCLAW_WEB_PORT, 4318),
      publicBaseUrl: resolvedEnv.NANOCLAW_WEB_PUBLIC_BASE_URL ?? "http://127.0.0.1:4318",
      allowedOrigins: parseCsv(resolvedEnv.NANOCLAW_WEB_ALLOWED_ORIGINS),
      trustedProxies: parseCsv(resolvedEnv.NANOCLAW_WEB_TRUSTED_PROXIES),
      messageMaxChars: parsePositiveInteger(resolvedEnv.NANOCLAW_WEB_MESSAGE_MAX_CHARS, 16_000),
      chatHistoryMaxChars: parsePositiveInteger(resolvedEnv.NANOCLAW_WEB_CHAT_HISTORY_MAX_CHARS, 4_000),
      rateLimits: {
        connectPerMinute: parsePositiveInteger(resolvedEnv.NANOCLAW_WEB_RATE_LIMIT_CONNECT_PER_MINUTE, 30),
        sendPerMinute: parsePositiveInteger(resolvedEnv.NANOCLAW_WEB_RATE_LIMIT_SEND_PER_MINUTE, 60),
        historyPerMinute: parsePositiveInteger(resolvedEnv.NANOCLAW_WEB_RATE_LIMIT_HISTORY_PER_MINUTE, 120)
      },
      auth: {
        mode: parseWebAuthMode(resolvedEnv.NANOCLAW_WEB_AUTH_MODE),
        trustedProxy: {
          userHeader: (resolvedEnv.NANOCLAW_WEB_AUTH_TRUSTED_PROXY_USER_HEADER ?? "x-forwarded-user").toLowerCase(),
          requiredHeaders: parseCsv(resolvedEnv.NANOCLAW_WEB_AUTH_TRUSTED_PROXY_REQUIRED_HEADERS).map((item) => item.toLowerCase()),
          allowUsers: parseCsv(resolvedEnv.NANOCLAW_WEB_AUTH_TRUSTED_PROXY_ALLOW_USERS)
        },
        ...(resolvedEnv.NANOCLAW_WEB_DEV_TOKEN ? { devToken: resolvedEnv.NANOCLAW_WEB_DEV_TOKEN } : {})
      }
    }
  };
}
