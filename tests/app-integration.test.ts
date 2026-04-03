import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { LocalDevChannel } from "../src/channels/local-dev-channel.js";
import { MainLocalChannel } from "../src/channels/main-local-channel.js";
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
    const app = await createApp(
      createTestConfig(root, {
        agentRunnerMode: "mock"
      }),
      new MockRuntime({ messagePrefix: "mock-container" })
    );

    try {
      const channel = app.channels.get("local-dev");
      expect(channel).toBeInstanceOf(LocalDevChannel);
      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy hello");

      const sent = await waitForSentMessage(channel as LocalDevChannel, "mock-container:hello");
      expect(sent.at(-1)?.text).toContain("mock-container:hello");
      expect(app.storage.listTasks().length).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it("main-local can register a new group through control path", async () => {
    const root = await createTempDir("nanoclaw-v2-main-");
    const app = await createApp(createTestConfig(root));

    try {
      const channel = app.channels.get("main-local");
      expect(channel).toBeInstanceOf(MainLocalChannel);
      await (channel as MainLocalChannel).emitInbound(
        "main-local:control",
        "/register-group local-dev local-dev:team team-folder"
      );

      const registered = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:team");
      expect(registered?.folder).toBe("team-folder");
    } finally {
      await app.stop();
    }
  });
});
