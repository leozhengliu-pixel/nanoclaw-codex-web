import { describe, expect, it } from "vitest";

import { createOrchestrator } from "../src/orchestrator.js";
import { RunnerToolHandler } from "../src/runner/tool-handler.js";
import { StorageBackedRemoteControlRecorder } from "../src/control-events.js";
import { appendRemoteControlEvent, listRemoteControlEvents } from "../src/db.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

describe("tool handler auth", () => {
  it("blocks non-main cross-group send_message", async () => {
    const root = await createTempDir("nanoclaw-tool-auth-send-");
    const orchestrator = await createOrchestrator(createTestConfig(root));

    try {
      await orchestrator.start();
      const handler = new RunnerToolHandler(
        orchestrator.app.controlPlane,
        new StorageBackedRemoteControlRecorder({ appendRemoteControlEvent, listRemoteControlEvents })
      );

      await orchestrator.app.router.handleInbound({
        channel: "local-dev",
        externalId: "local-dev:default",
        text: "@Andy seed"
      });
      const requester = orchestrator.app.storage.listTasks("local-dev:default").at(0);
      expect(requester).toBeTruthy();

      const result = await handler.handleToolRequest({
        id: "req-1",
        taskId: requester!.id,
        payload: {
          name: "send_message",
          args: {
            groupId: "main-local:control",
            text: "blocked"
          }
        }
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unauthorized");
    } finally {
      await orchestrator.stop();
    }
  });

  it("allows main group to register a new group with trigger metadata", async () => {
    const root = await createTempDir("nanoclaw-tool-auth-register-");
    const orchestrator = await createOrchestrator(createTestConfig(root));

    try {
      await orchestrator.start();
      const handler = new RunnerToolHandler(
        orchestrator.app.controlPlane,
        new StorageBackedRemoteControlRecorder({ appendRemoteControlEvent, listRemoteControlEvents })
      );

      await orchestrator.app.router.handleInbound({
        channel: "main-local",
        externalId: "main-local:control",
        text: "/list-groups"
      });
      const requester = orchestrator.app.storage.listTasks().find((task) => task.groupJid === "main-local:control");
      // main command does not create a task, so seed one explicitly.
      const seeded = await orchestrator.app.host.enqueueScheduledPrompt("main-local:control", "seed");

      const result = await handler.handleToolRequest({
        id: "req-2",
        taskId: requester?.id ?? seeded.taskId,
        payload: {
          name: "register_group",
          args: {
            channel: "local-dev",
            externalId: "local-dev:new-group",
            folder: "new-group",
            trigger: "@Bot",
            requiresTrigger: false
          }
        }
      });

      expect(result.ok).toBe(true);
      const registered = orchestrator.app.storage.getRegisteredGroup("local-dev:new-group");
      expect(registered?.trigger).toBe("@Bot");
    } finally {
      await orchestrator.stop();
    }
  });

  it("can pause and resume scheduled tasks only from the owning group", async () => {
    const root = await createTempDir("nanoclaw-tool-auth-pause-");
    const orchestrator = await createOrchestrator(createTestConfig(root));

    try {
      await orchestrator.start();
      const handler = new RunnerToolHandler(
        orchestrator.app.controlPlane,
        new StorageBackedRemoteControlRecorder({ appendRemoteControlEvent, listRemoteControlEvents })
      );

      const seeded = await orchestrator.app.host.enqueueScheduledPrompt("local-dev:default", "seed");
      const job = orchestrator.app.controlPlane.scheduleJob({
        sourceGroupId: "local-dev:default",
        groupId: "local-dev:default",
        prompt: "hello",
        scheduleType: "once",
        scheduleValue: new Date(Date.now() + 60_000).toISOString()
      }) as { jobId: string };

      const pause = await handler.handleToolRequest({
        id: "req-3",
        taskId: seeded.taskId,
        payload: {
          name: "pause_task",
          args: { taskId: job.jobId }
        }
      });
      expect(pause.ok).toBe(true);

      const resume = await handler.handleToolRequest({
        id: "req-4",
        taskId: seeded.taskId,
        payload: {
          name: "resume_task",
          args: { taskId: job.jobId }
        }
      });
      expect(resume.ok).toBe(true);
    } finally {
      await orchestrator.stop();
    }
  });
});
