import type { NewMessage } from "../types.js";
import { registerChannel, type Channel, type ChannelOpts } from "./registry.js";

export class MainLocalChannel implements Channel {
  public readonly name = "main-local";
  private connected = false;
  private readonly sentMessages: Array<{ externalId: string; text: string }> = [];

  public constructor(private readonly opts: ChannelOpts) {}

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public ownsExternalId(externalId: string): boolean {
    return externalId.startsWith("main-local");
  }

  public ownsJid(jid: string): boolean {
    return this.ownsExternalId(jid);
  }

  public async sendMessage(externalId: string, text: string): Promise<void> {
    this.sentMessages.push({ externalId, text });
  }

  public async emitInbound(externalId: string, text: string, senderId = "main-user"): Promise<void> {
    const createdAt = new Date().toISOString();
    this.opts.onChatMetadata(externalId, createdAt, externalId, this.name, false);

    const message: NewMessage = {
      id: `${this.name}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      chat_jid: externalId,
      sender: senderId,
      sender_name: senderId,
      content: text,
      timestamp: createdAt
    };
    await this.opts.onMessage(externalId, message);
  }

  public getSentMessages(): Array<{ externalId: string; text: string }> {
    return [...this.sentMessages];
  }
}

registerChannel("main-local", (opts) => new MainLocalChannel(opts));
