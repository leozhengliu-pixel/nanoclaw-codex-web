import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { OpenAICodexAuthService } from "../src/auth/openai-codex-auth-service.js";
import { ProviderAuthService } from "../src/auth/provider-auth-service.js";
import { InMemoryRemoteControlRecorder } from "../src/control-events.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

function createAccessToken(expirySecondsFromNow = 3600, extras: Record<string, unknown> = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expirySecondsFromNow,
      ...extras
    }),
    "utf8"
  ).toString("base64url");
  return `header.${payload}.sig`;
}

function createResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

async function createHarness(fetchImpl: typeof fetch) {
  const root = await createTempDir("nanoclaw-codex-auth-");
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
  const providerAuth = new ProviderAuthService(storage, config);
  const remoteControl = new InMemoryRemoteControlRecorder();
  const service = new OpenAICodexAuthService(providerAuth, remoteControl, fetchImpl);

  return {
    providerAuth,
    remoteControl,
    service
  };
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
});

describe("openai codex auth service", () => {
  it("completes oauth login through localhost callback", async () => {
    const accessToken = createAccessToken(3600, {
      email: "oauth@example.com",
      chatgpt_account_id: "acct_oauth"
    });

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/authorize") || url.includes("/backend-api/codex/responses")) {
        return createResponse({ ok: true });
      }
      if (url.includes("/oauth/token")) {
        return createResponse({
          access_token: accessToken,
          refresh_token: "refresh-oauth",
          expires_in: 3600
        });
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    };

    const harness = await createHarness(fetchImpl);
    const notifications: string[] = [];

    try {
      const loginPromise = harness.service.login({
        provider: "openai-codex",
        notify: async (message) => {
          notifications.push(message);
        }
      });

      for (let attempt = 0; attempt < 40 && notifications.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const authorizeUrl = notifications.join("\n").match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/)?.[0];
      expect(authorizeUrl).toBeTruthy();

      const parsed = new URL(authorizeUrl!);
      const redirectUri = parsed.searchParams.get("redirect_uri");
      const state = parsed.searchParams.get("state");
      expect(redirectUri).toBeTruthy();
      expect(state).toBeTruthy();

      await fetch(`${redirectUri}?code=oauth-code&state=${state}`);
      const result = await loginPromise;

      expect(result.ok).toBe(true);
      expect(result.method).toBe("oauth");
      expect(harness.service.status("openai-codex").email).toBe("oauth@example.com");
    } finally {
      // no-op
    }
  });

  it("falls back to manual oauth code entry when callback port is unavailable", async () => {
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("busy");
    });
    await new Promise<void>((resolve) => blocker.listen(1455, () => resolve()));

    const accessToken = createAccessToken(3600, {
      email: "manual@example.com",
      chatgpt_account_id: "acct_manual"
    });

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/oauth/authorize") || url.includes("/backend-api/codex/responses")) {
        return createResponse({ ok: true });
      }
      if (url.includes("/oauth/token")) {
        return createResponse({
          access_token: accessToken,
          refresh_token: "refresh-manual",
          expires_in: 3600
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const harness = await createHarness(fetchImpl);
    try {
      const notifications: string[] = [];
      const result = await harness.service.login({
        provider: "openai-codex",
        notify: async (message) => {
          notifications.push(message);
        },
        prompt: async () => {
          const state = notifications.join("\n").match(/state=([^&\s]+)/)?.[1] ?? "missing-state";
          return `http://localhost:1455/auth/callback?code=manual-code&state=${state}`;
        }
      });

      expect(result.ok).toBe(true);
      expect(result.method).toBe("oauth");
      expect(harness.service.status("openai-codex").accountId).toBe("acct_manual");
    } finally {
      blocker.close();
    }
  });

  it("rejects manual oauth redirect URLs with mismatched state", async () => {
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("busy");
    });
    await new Promise<void>((resolve) => blocker.listen(1455, () => resolve()));

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/oauth/authorize") || url.includes("/backend-api/codex/responses")) {
        return createResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const harness = await createHarness(fetchImpl);
    try {
      await expect(
        harness.service.login({
          provider: "openai-codex",
          notify: async () => undefined,
          prompt: async () => "http://localhost:1455/auth/callback?code=manual-code&state=wrong-state"
        })
      ).rejects.toThrow("OAuth state mismatch");
    } finally {
      blocker.close();
    }
  });

  it("releases the callback port after oauth token exchange failure", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/authorize") || url.includes("/backend-api/codex/responses")) {
        return createResponse({ ok: true });
      }
      if (url.includes("/oauth/token")) {
        return createResponse({ error: "bad_exchange" }, { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    };

    const harness = await createHarness(fetchImpl);
    const notifications: string[] = [];

    try {
      const loginPromise = harness.service.login({
        provider: "openai-codex",
        notify: async (message) => {
          notifications.push(message);
        }
      });

      for (let attempt = 0; attempt < 40 && notifications.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const authorizeUrl = notifications.join("\n").match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/)?.[0];
      expect(authorizeUrl).toBeTruthy();

      const parsed = new URL(authorizeUrl!);
      const redirectUri = parsed.searchParams.get("redirect_uri");
      const state = parsed.searchParams.get("state");
      expect(redirectUri).toBeTruthy();
      expect(state).toBeTruthy();

      await fetch(`${redirectUri}?code=oauth-code&state=${state}`);
      await expect(loginPromise).rejects.toThrow("OpenAI OAuth token exchange failed: 500");

      const probe = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(1455, () => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        probe.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      // no-op
    }
  });

  it("completes device login when explicitly requested", async () => {
    const accessToken = createAccessToken(3600, {
      email: "device@example.com",
      chatgpt_account_id: "acct_device"
    });
    let devicePolls = 0;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/oauth/authorize") || url.includes("/backend-api/codex/responses")) {
        return createResponse({ ok: true });
      }
      if (url.includes("/api/accounts/deviceauth/usercode")) {
        return createResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: "1"
        });
      }
      if (url.includes("/api/accounts/deviceauth/token")) {
        devicePolls += 1;
        if (devicePolls === 1) {
          return createResponse({ error: "authorization_pending" }, { status: 403 });
        }
        return createResponse({
          authorization_code: "device-code",
          code_verifier: "device-verifier"
        });
      }
      if (url.includes("/oauth/token")) {
        return createResponse({
          access_token: accessToken,
          refresh_token: "refresh-device",
          expires_in: 3600
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const harness = await createHarness(fetchImpl);
    try {
      const notifications: string[] = [];
      const result = await harness.service.login({
        provider: "openai-codex",
        method: "device",
        notify: async (message) => {
          notifications.push(message);
        }
      });

      expect(result.ok).toBe(true);
      expect(result.method).toBe("device");
      expect(notifications.join("\n")).toContain("ABCD-EFGH");
      expect(harness.service.status("openai-codex").email).toBe("device@example.com");
    } finally {
      // no-op
    }
  });
});
