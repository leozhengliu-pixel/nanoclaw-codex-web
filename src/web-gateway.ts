import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

import { getChat, getChatHistory } from "./db.js";
import type { AppConfig } from "./config/index.js";
import { logger } from "./logger.js";
import type { OrchestratorAppFacade } from "./orchestrator.js";
import { type WebChannel, type WebChatEvent } from "./channels/web-channel.js";

interface WebSession {
  id: string;
  userId: string;
  displayName: string;
  jid: string;
  socket: WebSocket;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface WebGatewayOptions {
  config: AppConfig;
  channel: WebChannel;
  app: OrchestratorAppFacade;
  projectRoot: string;
}

interface WebSocketEnvelope {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

function normalizeIp(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1";
}

function normalizeUserId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function createFolderName(userId: string): string {
  const normalized = normalizeUserId(userId) || "user";
  return `web_${normalized.replace(/[^a-z0-9_-]+/g, "_")}`;
}

function trimContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}…`;
}

function readHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export class WebGateway {
  private server: http.Server | null = null;
  private readonly sockets = new Map<string, WebSession>();
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly staticRoot: string;

  public constructor(private readonly options: WebGatewayOptions) {
    this.staticRoot = path.join(options.projectRoot, "dist-web");
  }

  public async start(): Promise<void> {
    if (this.server || !this.options.config.web.enabled) {
      return;
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleHttp(req, res);
      } catch (error) {
        logger.error({ error }, "Web gateway request failed");
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });

    this.server.on("upgrade", (req, socket, head) => {
      try {
        const auth = this.authenticate(req);
        this.consumeRateLimit(`connect:${auth.userId}`, this.options.config.web.rateLimits.connectPerMinute);
        this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.handleSocket(ws, auth, req);
        });
      } catch (error) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });

    this.wss.on("close", () => {
      this.sockets.clear();
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.config.web.port, this.options.config.web.bind, () => resolve());
    });

    logger.info(
      {
        bind: this.options.config.web.bind,
        port: this.options.config.web.port,
        authMode: this.options.config.web.auth.mode
      },
      "Web gateway started"
    );
  }

  public async stop(): Promise<void> {
    for (const session of this.sockets.values()) {
      session.socket.close();
    }
    this.sockets.clear();
    this.channelUnsubscribeAll();
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  public getBaseUrl(): string | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      return null;
    }
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    const pathname = new URL(req.url, this.options.config.web.publicBaseUrl).pathname;
    if (pathname === "/healthz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/") {
      await this.serveStatic("index.html", res);
      return;
    }

    if (pathname.startsWith("/assets/")) {
      await this.serveStatic(pathname.slice(1), res);
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  }

  private async serveStatic(relativePath: string, res: http.ServerResponse): Promise<void> {
    const filePath = path.join(this.staticRoot, relativePath);
    const safePath = path.resolve(filePath);
    if (!safePath.startsWith(path.resolve(this.staticRoot))) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    try {
      const body = await fs.readFile(safePath);
      res.statusCode = 200;
      if (relativePath.endsWith(".html")) {
        res.setHeader("content-type", "text/html; charset=utf-8");
      } else if (relativePath.endsWith(".js")) {
        res.setHeader("content-type", "application/javascript; charset=utf-8");
      } else if (relativePath.endsWith(".css")) {
        res.setHeader("content-type", "text/css; charset=utf-8");
      }
      res.end(body);
    } catch {
      if (relativePath === "index.html") {
        res.statusCode = 503;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><body><h1>Web UI not built</h1><p>Run <code>npm run build:web</code> in nanoclaw-codex-web.</p></body></html>"
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not Found");
    }
  }

  private authenticate(req: http.IncomingMessage): { userId: string; displayName: string } {
    const origin = readHeader(req, "origin");
    const remoteAddress = normalizeIp(req.socket.remoteAddress);
    const config = this.options.config.web;

    const allowedOrigins = config.allowedOrigins.length > 0 ? config.allowedOrigins : [new URL(config.publicBaseUrl).origin];
    if (!origin || !allowedOrigins.includes(origin)) {
      throw new Error("Origin not allowed");
    }

    if (config.auth.mode === "dev-token") {
      if (!isLoopback(remoteAddress)) {
        throw new Error("dev-token mode only allows loopback");
      }
      const token = readHeader(req, "x-nanoclaw-web-token");
      if (!config.auth.devToken || token !== config.auth.devToken) {
        throw new Error("Invalid development token");
      }
      return { userId: "developer", displayName: "Developer" };
    }

    if (!config.trustedProxies.map(normalizeIp).includes(remoteAddress)) {
      throw new Error("Request did not originate from a trusted proxy");
    }

    for (const header of config.auth.trustedProxy.requiredHeaders) {
      if (!readHeader(req, header)) {
        throw new Error(`Missing required trusted proxy header: ${header}`);
      }
    }

    const rawUser = readHeader(req, config.auth.trustedProxy.userHeader);
    if (!rawUser) {
      throw new Error("Missing trusted proxy user header");
    }

    const normalizedUser = normalizeUserId(rawUser);
    if (!normalizedUser) {
      throw new Error("Invalid trusted proxy user");
    }

    if (config.auth.trustedProxy.allowUsers.length > 0) {
      const allowed = config.auth.trustedProxy.allowUsers.map(normalizeUserId);
      if (!allowed.includes(normalizedUser)) {
        throw new Error("Trusted proxy user is not allowed");
      }
    }

    return { userId: normalizedUser, displayName: rawUser };
  }

  private handleSocket(ws: WebSocket, auth: { userId: string; displayName: string }, req: http.IncomingMessage): void {
    const jid = `web:${auth.userId}`;
    this.ensureRegisteredWebGroup(auth.userId, auth.displayName);

    const session: WebSession = {
      id: randomUUID(),
      userId: auth.userId,
      displayName: auth.displayName,
      jid,
      socket: ws
    };

    this.sockets.set(session.id, session);
    this.options.channel.subscribe({
      id: session.id,
      jid,
      onEvent: (event) => {
        this.send(ws, event as unknown as Record<string, unknown>);
      }
    });

    this.send(ws, {
      type: "chat.ready",
      payload: {
        jid,
        userId: auth.userId,
        displayName: auth.displayName
      }
    });

    ws.on("message", async (raw: Buffer) => {
      try {
        const envelope = JSON.parse(raw.toString("utf8")) as WebSocketEnvelope;
        await this.handleWebMessage(session, envelope);
      } catch (error) {
        this.send(ws, {
          type: "chat.error",
          payload: {
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });

    ws.on("close", () => {
      this.options.channel.unsubscribe(session.id);
      this.sockets.delete(session.id);
    });

    void req;
  }

  private async handleWebMessage(session: WebSession, envelope: WebSocketEnvelope): Promise<void> {
    if (envelope.type === "chat.subscribe") {
      this.send(session.socket, {
        type: "chat.subscribed",
        payload: { jid: session.jid }
      });
      return;
    }

    if (envelope.type === "chat.history") {
      this.consumeRateLimit(`history:${session.userId}`, this.options.config.web.rateLimits.historyPerMinute);
      const history = getChatHistory(session.jid, 100).map((message) => ({
        id: message.id,
        role: message.is_bot_message || message.is_from_me ? "assistant" : "user",
        sender: message.sender_name,
        text: trimContent(message.content, this.options.config.web.chatHistoryMaxChars),
        timestamp: message.timestamp,
        ...(message.reply_to_message_id ? { replyToMessageId: message.reply_to_message_id } : {}),
        ...(message.reply_to_sender_name ? { replyToSenderName: message.reply_to_sender_name } : {})
      }));
      const chat = getChat(session.jid);
      this.send(session.socket, {
        type: "chat.history",
        payload: {
          jid: session.jid,
          name: chat?.name ?? session.displayName,
          messages: history
        }
      });
      return;
    }

    if (envelope.type === "chat.send") {
      this.consumeRateLimit(`send:${session.userId}`, this.options.config.web.rateLimits.sendPerMinute);
      const text = typeof envelope.payload?.text === "string" ? envelope.payload.text.trim() : "";
      if (!text) {
        throw new Error("Message text is required");
      }
      if (text.length > this.options.config.web.messageMaxChars) {
        throw new Error(`Message exceeds ${this.options.config.web.messageMaxChars} characters`);
      }
      await this.options.channel.emitInbound(session.jid, text, session.userId, session.displayName, {
        ...(typeof envelope.payload?.threadId === "string" ? { threadId: envelope.payload.threadId } : {}),
        ...(typeof envelope.payload?.replyToMessageId === "string" ? { replyToMessageId: envelope.payload.replyToMessageId } : {}),
        ...(typeof envelope.payload?.replyToMessageContent === "string"
          ? { replyToMessageContent: envelope.payload.replyToMessageContent }
          : {}),
        ...(typeof envelope.payload?.replyToSenderName === "string" ? { replyToSenderName: envelope.payload.replyToSenderName } : {})
      });
      this.send(session.socket, {
        type: "chat.ack",
        payload: {
          requestId: envelope.id ?? null
        }
      });
      return;
    }

    throw new Error(`Unsupported message type: ${envelope.type}`);
  }

  private ensureRegisteredWebGroup(userId: string, displayName: string): void {
    const existing = this.options.app.storage.getRegisteredGroupByAddress("web", `web:${userId}`);
    if (existing) {
      return;
    }
    this.options.app.controlPlane.registerGroup({
      sourceGroupId: "main-local:control",
      channel: "web",
      externalId: `web:${userId}`,
      folder: createFolderName(userId),
      trigger: this.options.config.defaultTrigger,
      requiresTrigger: false
    });
    this.options.app.remoteControl.record("info", "Registered web channel group", {
      externalId: `web:${userId}`,
      displayName
    });
  }

  private consumeRateLimit(key: string, limitPerMinute: number): void {
    const now = Date.now();
    const current = this.rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    if (current.count >= limitPerMinute) {
      throw new Error("Rate limit exceeded");
    }
    current.count += 1;
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  private channelUnsubscribeAll(): void {
    for (const id of this.sockets.keys()) {
      this.options.channel.unsubscribe(id);
    }
  }
}

export function isTrustedProxyRequest(config: AppConfig, remoteAddress: string | undefined): boolean {
  const normalized = normalizeIp(remoteAddress);
  return config.web.trustedProxies.map(normalizeIp).includes(normalized);
}
