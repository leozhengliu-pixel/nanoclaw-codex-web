import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { LocalDevChannel } from "../src/channels/local-dev-channel.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.join("").trim() || `${command} ${args[0]} failed with ${code}`));
    });
  });
}

function detectEngineBinary(): string | null {
  const preferred = process.env.NANOCLAW_CONTAINER_ENGINE_BINARY;
  if (preferred) {
    const result = spawnSync(preferred, ["version"], { cwd: process.cwd(), stdio: "ignore" });
    return result.status === 0 ? preferred : null;
  }

  for (const candidate of ["docker", "podman"]) {
    const result = spawnSync(candidate, ["version"], { cwd: process.cwd(), stdio: "ignore" });
    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
}

async function waitFor<T>(producer: () => T | undefined, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = producer();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

const shouldRun = process.env.NANOCLAW_RUN_CONTAINER_E2E === "1";
const engineBinary = detectEngineBinary();
const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => undefined);
  }
});

describe.skipIf(!shouldRun || !engineBinary)("container engine e2e", () => {
  it("executes agent-runner inside a real container with mounted workspace and sessions", async () => {
    const root = await createTempDir("nanoclaw-container-e2e-");
    const imageName = `nanoclaw-codex-e2e:${randomUUID().slice(0, 8)}`;
    await runCommand(engineBinary!, ["build", "-t", imageName, "-f", "container/Dockerfile", "."], process.cwd());
    cleanup.push(() => runCommand(engineBinary!, ["rmi", "-f", imageName], process.cwd()));

    const orchestrator = await createOrchestrator(
      createTestConfig(root, {
        containerExecutor: "engine",
        containerEngineBinary: engineBinary!,
        containerImage: imageName,
        agentRunnerMode: "codex",
        codexBinaryPath: "/app/container/test-bin/fake-codex"
      })
    );
    const app = orchestrator.app;

    try {
      orchestrator.start();
      app.providerAuth.setOAuthCredential({
        provider: "openai-codex",
        accessToken: "header.payload.sig",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
        method: "oauth"
      });

      const channel = orchestrator.channels.get("local-dev");
      expect(channel).toBeInstanceOf(LocalDevChannel);

      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy hello from container");

      const lastSent = await waitFor(() => (channel as LocalDevChannel).getSentMessages().at(-1), 15_000, 100);
      expect(lastSent.text).toContain("fake-codex:");
      expect(lastSent.text).toContain("USER: hello from container");

      const task = await waitFor(() => app.storage.listTasks()[0], 15_000, 100);
      expect(task).toBeTruthy();
      const sessionFiles = await fs.readdir(path.join(root, "data", "sessions", "local-dev_default"));
      expect(sessionFiles.length).toBeGreaterThan(0);
    } finally {
      await orchestrator.stop();
    }
  }, 180_000);
});
