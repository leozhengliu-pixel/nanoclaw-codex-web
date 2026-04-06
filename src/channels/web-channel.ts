import type { NewMessage } from "../types.js";
import { registerChannel, type Channel, type ChannelOpts } from "./registry.js";

export interface WebChatEvent {
  type: "chat.message" | "chat.typing";
  jid: string;
  payload: Record<string, unknown>;
}

export interface WebChannelSubscriber {
  id: string;
  jid: string;
  onEvent(event: WebChatEvent): void;
}

export class WebChannel implements Channel {
  public readonly name = "web";
  private connected = false;
  private readonly subscribers = new Map<string, WebChannelSubscriber>();
  private readonly typingEvents: Array<{ externalId: string; isTyping: boolean }> = [];

  public constructor(private readonly opts: ChannelOpts) {}

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.subscribers.clear();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public ownsJid(jid: string): boolean {
    return jid.startsWith("web:");
  }

  public async sendMessage(jid: string, text: string): Promise<void> {
    this.broadcast(jid, {
      type: "chat.message",
      jid,
      payload: {
        id: `web-bot:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        role: "assistant",
        text
      }
    });
  }

  public async setTyping(jid: string, isTyping: boolean): Promise<void> {
    this.typingEvents.push({ externalId: jid, isTyping });
    this.broadcast(jid, {
      type: "chat.typing",
      jid,
      payload: {
        isTyping
      }
    });
  }

  public async syncGroups(_force: boolean): Promise<void> {
    return;
  }

  public subscribe(subscriber: WebChannelSubscriber): void {
    this.subscribers.set(subscriber.id, subscriber);
  }

  public unsubscribe(subscriberId: string): void {
    this.subscribers.delete(subscriberId);
  }

  public async emitInbound(
    jid: string,
    text: string,
    senderId: string,
    senderName: string,
    metadata: {
      threadId?: string;
      replyToMessageId?: string;
      replyToMessageContent?: string;
      replyToSenderName?: string;
    } = {}
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    this.opts.onChatMetadata(jid, createdAt, senderName, this.name, false);

    const message: NewMessage = {
      id: `${this.name}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: createdAt,
      ...(metadata.threadId ? { thread_id: metadata.threadId } : {}),
      ...(metadata.replyToMessageId ? { reply_to_message_id: metadata.replyToMessageId } : {}),
      ...(metadata.replyToMessageContent ? { reply_to_message_content: metadata.replyToMessageContent } : {}),
      ...(metadata.replyToSenderName ? { reply_to_sender_name: metadata.replyToSenderName } : {})
    };
    await this.opts.onMessage(jid, message);
  }

  public getTypingEvents(): Array<{ externalId: string; isTyping: boolean }> {
    return [...this.typingEvents];
  }

  private broadcast(jid: string, event: WebChatEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.jid === jid) {
        subscriber.onEvent(event);
      }
    }
  }
}

registerChannel("web", (opts) => new WebChannel(opts));
