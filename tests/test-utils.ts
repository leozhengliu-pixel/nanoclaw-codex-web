import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "../src/config/index.js";

export async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function createTestConfig(root: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataRoot: path.join(root, "data"),
    groupsRoot: path.join(root, "groups"),
    sqlitePath: path.join(root, "data", "db.sqlite"),
    sessionsRoot: path.join(root, "data", "sessions"),
    ipcRoot: path.join(root, "data", "ipc"),
    logsRoot: path.join(root, "logs"),
    maxConcurrency: 2,
    schedulerPollIntervalMs: 10,
    codexBinaryPath: "codex",
    runtimeTimeoutMs: 1_000,
    groupWorkspacePolicy: "group-scoped",
    sandboxProvider: "container",
    containerExecutor: "process",
    containerEngineBinary: "docker",
    containerImage: "ignored",
    containerRunnerEntrypoint: path.resolve(process.cwd(), "container", "agent-runner", "src", "index.ts"),
    containerRunnerPathInImage: "/app/dist/container/agent-runner/src/index.js",
    agentRunnerMode: "mock",
    assistantName: "Andy",
    defaultTrigger: "@Andy",
    mountAllowlistPath: path.resolve(process.cwd(), "config-examples", "mount-allowlist.json"),
    openaiApiBaseUrl: "https://api.openai.com/v1",
    openaiCodexBaseUrl: "https://chatgpt.com/backend-api/codex",
    defaultTimezone: "UTC",
    containerSkillsPath: path.resolve(process.cwd(), "container", "skills"),
    web: {
      enabled: false,
      bind: "127.0.0.1",
      port: 0,
      publicBaseUrl: "http://127.0.0.1:4318",
      allowedOrigins: ["http://127.0.0.1:4318"],
      trustedProxies: ["127.0.0.1", "::1"],
      messageMaxChars: 16_000,
      chatHistoryMaxChars: 4_000,
      rateLimits: {
        connectPerMinute: 30,
        sendPerMinute: 60,
        historyPerMinute: 120
      },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: [],
          allowUsers: []
        }
      }
    },
    ...overrides
  };
}
