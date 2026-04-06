import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { WebChannel } from "../src/channels/web-channel.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { MockRuntime } from "../src/runtime/mock/mock-runtime.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

function createEventBuffer(socket: WebSocket) {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const listener = (raw: Buffer) => {
    events.push(JSON.parse(raw.toString("utf8")) as { type: string; payload?: Record<string, unknown> });
  };
  socket.on("message", listener);

  return {
    async next<T extends { type: string }>(expectedType: string, timeoutMs = 4_000): Promise<T> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const index = events.findIndex((entry) => entry.type === expectedType);
        if (index !== -1) {
          return events.splice(index, 1)[0] as T;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${expectedType}`);
    },
    stop() {
      socket.off("message", listener);
    }
  };
}

function connectAndWaitForReady(
  url: string,
  headers: Record<string, string>
): Promise<{ socket: WebSocket; ready: { type: "chat.ready"; payload: { jid: string } } }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for chat.ready"));
    }, 4_000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString("utf8")) as { type: string; payload: { jid: string } };
      if (parsed.type === "chat.ready") {
        cleanup();
        resolve({ socket, ready: parsed as { type: "chat.ready"; payload: { jid: string } } });
      }
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function expectUpgradeFailure(url: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request: ClientRequest, response: IncomingMessage) => {
      response.resume();
      if (response.statusCode === 401) {
        resolve();
      } else {
        reject(new Error(`Unexpected status code ${response.statusCode}`));
      }
    });
    socket.once("open", () => reject(new Error("Expected unauthorized upgrade failure")));
    socket.once("error", () => resolve());
  });
}

describe("web gateway", () => {
  it("rejects websocket upgrades that do not satisfy trusted proxy headers", async () => {
    const root = await createTempDir("nanoclaw-web-gateway-auth-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, {
        web: {
          enabled: true,
          bind: "127.0.0.1",
          port: 0,
          publicBaseUrl: "http://web.test",
          allowedOrigins: ["http://web.test"],
          trustedProxies: ["127.0.0.1", "::1"],
          messageMaxChars: 16_000,
          chatHistoryMaxChars: 128,
          rateLimits: {
            connectPerMinute: 30,
            sendPerMinute: 60,
            historyPerMinute: 60
          },
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowUsers: ["alice@example.com"]
            }
          }
        }
      }),
      new MockRuntime({ messagePrefix: "web" })
    );

    try {
      await orchestrator.start();
      const baseUrl = orchestrator.webGateway?.getBaseUrl();
      expect(baseUrl).toBeTruthy();
      const wsUrl = baseUrl!.replace("http://", "ws://") + "/ws";

      await expectUpgradeFailure(wsUrl, {
        origin: "http://malicious.test",
        "x-forwarded-user": "alice@example.com",
        "x-forwarded-proto": "https"
      });

      await expectUpgradeFailure(wsUrl, {
        origin: "http://web.test",
        "x-forwarded-proto": "https"
      });
    } finally {
      await orchestrator.stop();
    }
  });

  it("routes browser chat through the orchestrator and streams typing plus replies", async () => {
    const root = await createTempDir("nanoclaw-web-gateway-chat-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, {
        web: {
          enabled: true,
          bind: "127.0.0.1",
          port: 0,
          publicBaseUrl: "http://web.test",
          allowedOrigins: ["http://web.test"],
          trustedProxies: ["127.0.0.1", "::1"],
          messageMaxChars: 16_000,
          chatHistoryMaxChars: 32,
          rateLimits: {
            connectPerMinute: 30,
            sendPerMinute: 60,
            historyPerMinute: 60
          },
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowUsers: ["alice@example.com"]
            }
          }
        }
      }),
      new MockRuntime({ messagePrefix: "web" })
    );

    try {
      await orchestrator.start();
      const baseUrl = orchestrator.webGateway?.getBaseUrl();
      expect(baseUrl).toBeTruthy();
      const wsUrl = baseUrl!.replace("http://", "ws://") + "/ws";
      const { socket, ready } = await connectAndWaitForReady(wsUrl, {
        origin: "http://web.test",
        "x-forwarded-user": "alice@example.com",
        "x-forwarded-proto": "https"
      });
      const buffer = createEventBuffer(socket);

      try {
        expect(ready.payload.jid).toBe("web:alice-example.com");

        const group = orchestrator.app.storage.getRegisteredGroupByAddress("web", ready.payload.jid);
        expect(group?.id).toBe("web:alice-example.com");

        socket.send(JSON.stringify({ type: "chat.history" }));
        const initialHistory = await buffer.next<{ type: "chat.history"; payload: { messages: unknown[] } }>("chat.history");
        expect(initialHistory.payload.messages).toEqual([]);

        socket.send(JSON.stringify({ id: "req-1", type: "chat.send", payload: { text: "hello from browser" } }));
        const reply = await buffer.next<{ type: "chat.message"; payload: { text: string } }>("chat.message");
        expect(reply.payload.text).toContain("web:hello from browser");

        const webChannel = orchestrator.channels.get("web") as WebChannel;
        expect(webChannel.getTypingEvents().some((event) => event.isTyping)).toBe(true);
        expect(webChannel.getTypingEvents().some((event) => event.isTyping === false)).toBe(true);
        await webChannel.sendMessage(ready.payload.jid, "x".repeat(96));
        socket.send(JSON.stringify({ type: "chat.history" }));
        const laterHistory = await buffer.next<{ type: "chat.history"; payload: { messages: Array<{ text: string }> } }>("chat.history");
        expect(laterHistory.payload.messages.at(-1)?.text.length).toBeLessThanOrEqual(33);
      } finally {
        buffer.stop();
        socket.close();
      }
    } finally {
      await orchestrator.stop();
    }
  });
});
