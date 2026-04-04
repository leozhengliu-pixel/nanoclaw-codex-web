import { describe, expect, it } from "vitest";

import { createOrchestrator } from "../src/orchestrator.js";
import { RunnerToolHandler } from "../src/runner/tool-handler.js";
import { MockRuntime } from "../src/runtime/mock/mock-runtime.js";
import { runSetupStep } from "../setup/index.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

describe("scheduler and tool bridge", () => {
  it("executes once jobs through the same host path", async () => {
    const root = await createTempDir("nanoclaw-v2-scheduler-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root),
      new MockRuntime({ messagePrefix: "scheduler" })
    );
    const app = orchestrator.app;

    try {
      orchestrator.start();
      const group = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:default");
      const job = app.scheduler.createOnce(group!.id, "scheduled hello", new Date(Date.now() - 1));
      await app.scheduler.tick(new Date());

      const stored = app.storage.getScheduledJob(job.id);
      expect(stored?.active).toBe(false);
      expect(app.storage.listTasks(group!.id).length).toBe(1);
    } finally {
      await orchestrator.stop();
    }
  });

  it("runner tool handler can list tasks through the control plane", async () => {
    const root = await createTempDir("nanoclaw-v2-tools-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root),
      new MockRuntime({ messagePrefix: "tool" })
    );
    const app = orchestrator.app;

    try {
      orchestrator.start();
      const group = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:default");
      await app.host.enqueueScheduledPrompt(group!.id, "hello tools");

      const handler = new RunnerToolHandler(app.controlPlane, app.remoteControl);
      const response = await handler.handleToolRequest({
        id: "req-1",
        taskId: "task-1",
        payload: {
          name: "list_tasks",
          args: { groupId: group!.id }
        }
      });

      expect(response.ok).toBe(true);
      expect(Array.isArray(response.result)).toBe(true);
      expect((response.result as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("computes the next cron run after execution", async () => {
    const root = await createTempDir("nanoclaw-v2-cron-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, { defaultTimezone: "UTC" }),
      new MockRuntime({ messagePrefix: "cron" })
    );
    const app = orchestrator.app;

    try {
      orchestrator.start();
      const group = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:default");
      const job = app.scheduler.createCron(group!.id, "cron hello", "* * * * *", "UTC");
      await app.scheduler.tick(new Date(job.nextRunAt));

      const stored = app.storage.getScheduledJob(job.id);
      expect(stored?.active).toBe(true);
      expect(stored?.kind).toBe("cron");
      expect(stored?.cronExpression).toBe("* * * * *");
      expect(stored?.nextRunAt).not.toBe(job.nextRunAt);
    } finally {
      await orchestrator.stop();
    }
  });

  it("setup verify ensures default group assets exist", async () => {
    const root = await createTempDir("nanoclaw-v2-setup-");
    const result = await runSetupStep("verify", createTestConfig(root));

    expect(result.ok).toBe(true);
    expect(result.checks).toMatchObject({
      groups: {
        ok: true
      }
    });
  });
});
