import { randomUUID } from "node:crypto";

import type { RemoteControlEvent } from "./types/host.js";

export interface RemoteControlEventStore {
  appendRemoteControlEvent(event: RemoteControlEvent): void;
  listRemoteControlEvents(limit?: number): RemoteControlEvent[];
}

export interface RemoteControlRecorder {
  record(level: RemoteControlEvent["level"], message: string, details?: Record<string, unknown>): RemoteControlEvent;
  status(): { recentEvents: RemoteControlEvent[] };
}

export class StorageBackedRemoteControlRecorder implements RemoteControlRecorder {
  public constructor(private readonly storage: RemoteControlEventStore) {}

  public record(level: RemoteControlEvent["level"], message: string, details?: Record<string, unknown>): RemoteControlEvent {
    const event: RemoteControlEvent = {
      id: randomUUID(),
      level,
      message,
      createdAt: new Date().toISOString(),
      ...(details ? { details } : {})
    };
    this.storage.appendRemoteControlEvent(event);
    return event;
  }

  public status(): { recentEvents: RemoteControlEvent[] } {
    return {
      recentEvents: this.storage.listRemoteControlEvents()
    };
  }
}

export class InMemoryRemoteControlRecorder implements RemoteControlRecorder {
  private readonly events: RemoteControlEvent[] = [];

  public record(level: RemoteControlEvent["level"], message: string, details?: Record<string, unknown>): RemoteControlEvent {
    const event: RemoteControlEvent = {
      id: randomUUID(),
      level,
      message,
      createdAt: new Date().toISOString(),
      ...(details ? { details } : {})
    };
    this.events.unshift(event);
    return event;
  }

  public status(): { recentEvents: RemoteControlEvent[] } {
    return {
      recentEvents: [...this.events]
    };
  }
}
