import fs from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunnerTaskRequest } from "../src/ipc/protocol.js";
import { ContainerRunner } from "../src/runner/container-runner.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

const mocks = vi.hoisted(() => ({
  ensureContainerRuntimeRunning: vi.fn(),
  hostGatewayArgs: vi.fn(() => ["--add-host=host.docker.internal:host-gateway"])
}));

vi.mock("../src/container-runtime.js", () => ({
  ensureContainerRuntimeRunning: mocks.ensureContainerRuntimeRunning,
  hostGatewayArgs: mocks.hostGatewayArgs
}));

describe("container runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks container runtime availability before starting an engine-backed run", async () => {
    const root = await createTempDir("nanoclaw-container-runner-");
    const config = createTestConfig(root, {
      containerExecutor: "engine"
    });
    const runner = new ContainerRunner(config, {
      async handleToolRequest() {
        return { id: "ignored", ok: true };
      }
    }) as any;

    runner.runEngineCommand = vi.fn().mockResolvedValue(undefined);

    const runDir = `${root}/ipc/run-1`;
    await fs.mkdir(runDir, { recursive: true });
    const request: RunnerTaskRequest = {
      taskId: "task-1",
      sessionId: "session-1",
      group: {
        id: "local-dev:default",
        channel: "local-dev",
        externalId: "local-dev:default",
        folder: "local-dev_default",
        isMain: false,
        trigger: "@Andy",
        containerConfig: {
          additionalMounts: []
        },
        createdAt: new Date().toISOString()
      },
      workingDirectory: root,
      globalMemoryFile: `${root}/global.md`,
      groupMemoryFile: `${root}/group.md`,
      sessionsPath: `${root}/sessions`,
      messages: [{ role: "user", content: "hello" }],
      provider: "openai-codex",
      modelId: "gpt-5.4",
      codexBinaryPath: "codex",
      runtimeTimeoutMs: 1_000,
      mode: "mock",
      containerConfig: {
        additionalMounts: []
      }
    };

    await runner.startContainer("nanoclaw-test", request, runDir);

    expect(mocks.ensureContainerRuntimeRunning).toHaveBeenCalledTimes(1);
    expect(mocks.hostGatewayArgs).toHaveBeenCalledTimes(1);
    expect(runner.runEngineCommand).toHaveBeenCalledWith(
      expect.arrayContaining(["--add-host=host.docker.internal:host-gateway"])
    );
  });
});
