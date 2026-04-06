import { describe, expect, it } from "vitest";

import { LocalDevChannel } from "../src/channels/local-dev-channel.js";
import { MainLocalChannel } from "../src/channels/main-local-channel.js";
import { getAllChats } from "../src/db.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { MockRuntime } from "../src/runtime/mock/mock-runtime.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

async function waitForSentMessage(
  channel: LocalDevChannel,
  expectedText: string
): Promise<Array<{ externalId: string; text: string }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sent = channel.getSentMessages();
    if (sent.some((entry) => entry.text.includes(expectedText))) {
      return sent;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return channel.getSentMessages();
}

describe("app integration", () => {
  it("routes a local-dev message through router and sends outbound reply", async () => {
    const root = await createTempDir("nanoclaw-v2-app-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, {
        agentRunnerMode: "mock"
      }),
      new MockRuntime({ messagePrefix: "mock-container" })
    );
    const app = orchestrator.app;

    try {
      await orchestrator.start();
      const channel = orchestrator.channels.get("local-dev");
      expect(channel).toBeInstanceOf(LocalDevChannel);
      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy hello");

      const sent = await waitForSentMessage(channel as LocalDevChannel, "mock-container:hello");
      expect(sent.at(-1)?.text).toContain("mock-container:hello");
      expect(app.storage.listTasks().length).toBe(1);
    } finally {
      await orchestrator.stop();
    }
  });

  it("main-local can register a new group through control path", async () => {
    const root = await createTempDir("nanoclaw-v2-main-");
    const orchestrator = await createOrchestrator(createTestConfig(root));
    const app = orchestrator.app;

    try {
      await orchestrator.start();
      const channel = orchestrator.channels.get("main-local");
      expect(channel).toBeInstanceOf(MainLocalChannel);
      await (channel as MainLocalChannel).emitInbound(
        "main-local:control",
        "/register-group local-dev local-dev:team team-folder"
      );

      const registered = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:team");
      expect(registered?.folder).toBe("team-folder");
    } finally {
      await orchestrator.stop();
    }
  });

  it("stores chat metadata and reuses the same runtime session across consecutive group messages", async () => {
    const root = await createTempDir("nanoclaw-v2-session-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, {
        agentRunnerMode: "mock"
      }),
      new MockRuntime({ messagePrefix: "session" })
    );
    const app = orchestrator.app;

    try {
      await orchestrator.start();
      const channel = orchestrator.channels.get("local-dev") as LocalDevChannel;
      await channel.emitInbound("local-dev:default", "@Andy first");
      await waitForSentMessage(channel, "session:first");

      const firstTask = app.storage.listTasks()[0];
      expect(firstTask?.sessionId).toBeTruthy();

      await channel.emitInbound("local-dev:default", "@Andy second");
      await waitForSentMessage(channel, "session:second");

      const tasks = app.storage.listTasks();
      expect(tasks.length).toBe(2);
      expect(tasks[0]?.sessionId).toBe(tasks[1]?.sessionId);

      const chats = getAllChats();
      expect(chats.some((item) => item.channel === "local-dev" && item.jid === "local-dev:default")).toBe(true);
    } finally {
      await orchestrator.stop();
    }
  });

  it("toggles typing around runtime execution and forwards reply context into the runtime prompt", async () => {
    const root = await createTempDir("nanoclaw-v2-typing-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, {
        agentRunnerMode: "mock"
      }),
      new MockRuntime({ messagePrefix: "inspect" })
    );

    try {
      await orchestrator.start();
      const channel = orchestrator.channels.get("local-dev") as LocalDevChannel;
      await orchestrator.app.router.handleInbound({
        channel: "local-dev",
        externalId: "local-dev:default",
        text: "@Andy answer this",
        replyToMessageId: "m-1",
        replyToSenderName: "alice",
        replyToMessageContent: "previous message",
        threadId: "thread-1"
      });

      const sent = await waitForSentMessage(channel, "inspect:");
      expect(sent.at(-1)?.text).toContain("[thread:thread-1]");
      expect(sent.at(-1)?.text).toContain("Reply context:");
      expect(sent.at(-1)?.text).toContain("previous message");

      const typing = channel.getTypingEvents();
      expect(typing).toEqual([
        { externalId: "local-dev:default", isTyping: true },
        { externalId: "local-dev:default", isTyping: false }
      ]);
    } finally {
      await orchestrator.stop();
    }
  });
});
