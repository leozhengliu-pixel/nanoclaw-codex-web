import { describe, expect, it } from "vitest";

import { ProviderAuthService } from "../src/auth/provider-auth-service.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

describe("provider auth service", () => {
  it("stores project oauth credentials with method metadata", async () => {
    const root = await createTempDir("nanoclaw-auth-");
    const config = createTestConfig(root);
    const store = new Map<string, Record<string, unknown>>();
    const storage = {
      getProviderAuth(providerId: "openai" | "openai-codex") {
        return store.get(providerId) ?? null;
      },
      upsertProviderAuth(providerId: "openai" | "openai-codex", credential: Record<string, unknown>) {
        store.set(providerId, credential);
      },
      clearProviderAuth(providerId: "openai" | "openai-codex") {
        store.delete(providerId);
      },
      listProviderAuth() {
        return [...store.entries()].map(([providerId, credential]) => ({ providerId, credential }));
      }
    };
    const service = new ProviderAuthService(storage, config);

    service.setOAuthCredential({
      provider: "openai-codex",
      accessToken: "header.payload.sig",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      accountId: "acct_123",
      email: "user@example.com",
      method: "device"
    });

    const credential = service.get("openai-codex");
    expect(credential?.type).toBe("oauth");
    expect(credential && credential.type === "oauth" ? credential.method : "").toBe("device");
    expect(credential && credential.type === "oauth" ? credential.source : "").toBe("project-store");

    const status = service.status().find((item) => item.provider === "openai-codex");
    expect(status?.method).toBe("device");
    expect(status?.source).toBe("project-store");
    expect(status?.accountId).toBe("acct_123");
  });
});
