import { describe, expect, it, vi } from "vitest";

import { MainLocalChannel } from "../src/channels/main-local-channel.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

describe("router", () => {
  it("ignores unregistered groups and records a remote control event", async () => {
    const root = await createTempDir("nanoclaw-router-");
    const orchestrator = await createOrchestrator(createTestConfig(root));
    const app = orchestrator.app;

    try {
      orchestrator.start();
      await app.router.handleInbound({
        channel: "local-dev",
        externalId: "local-dev:missing",
        text: "@Andy hello"
      });
      expect(app.remoteControl.status().recentEvents[0]?.message).toContain("Ignoring message");
    } finally {
      await orchestrator.stop();
    }
  });

  it("main-local remote-status command replies on the same channel", async () => {
    const root = await createTempDir("nanoclaw-router-main-");
    const orchestrator = await createOrchestrator(createTestConfig(root));

    try {
      orchestrator.start();
      const channel = orchestrator.channels.get("main-local") as MainLocalChannel;
      await channel.emitInbound("main-local:control", "/remote-status");
      expect(channel.getSentMessages().length).toBeGreaterThan(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("main-local auth-status reports configured provider auth", async () => {
    const root = await createTempDir("nanoclaw-router-auth-");
    const orchestrator = await createOrchestrator(createTestConfig(root));
    const app = orchestrator.app;

    try {
      orchestrator.start();
      app.providerAuth.setOAuthCredential({
        provider: "openai-codex",
        accessToken: "header.payload.sig",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
        accountId: "acct_123",
        email: "user@example.com",
        method: "device"
      });
      const channel = orchestrator.channels.get("main-local") as MainLocalChannel;
      await channel.emitInbound("main-local:control", "/auth-status");
      expect(channel.getSentMessages().at(-1)?.text).toContain("openai-codex: oauth");
      expect(channel.getSentMessages().at(-1)?.text).toContain("method=device");
    } finally {
      await orchestrator.stop();
    }
  });

  it("main-local can update a group's model", async () => {
    const root = await createTempDir("nanoclaw-router-model-");
    const orchestrator = await createOrchestrator(createTestConfig(root));
    const app = orchestrator.app;

    try {
      orchestrator.start();
      const group = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:default");
      expect(group).toBeTruthy();
      const channel = orchestrator.channels.get("main-local") as MainLocalChannel;
      await channel.emitInbound("main-local:control", `/set-model ${group!.id} openai/gpt-5-mini`);

      const updated = app.storage.getRegisteredGroup(group!.id);
      expect(updated?.runtimeConfig).toEqual({
        provider: "openai",
        modelId: "gpt-5-mini"
      });
    } finally {
      await orchestrator.stop();
    }
  });

  it("main-local auth-login reports user-facing failures instead of throwing", async () => {
    const root = await createTempDir("nanoclaw-router-auth-login-");
    const orchestrator = await createOrchestrator(createTestConfig(root));
    const app = orchestrator.app;

    try {
      orchestrator.start();
      vi.spyOn(app.codexAuth, "login").mockRejectedValue(new Error("OpenAI Codex auth preflight failed"));
      const channel = orchestrator.channels.get("main-local") as MainLocalChannel;
      await channel.emitInbound("main-local:control", "/auth-login openai-codex");

      expect(channel.getSentMessages().at(-1)?.text).toContain("openai-codex login failed: OpenAI Codex auth preflight failed");
    } finally {
      await orchestrator.stop();
    }
  });
});
