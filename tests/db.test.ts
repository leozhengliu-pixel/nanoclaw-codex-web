import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _closeDatabase,
  _initTestDatabase,
  getDueTasks,
  getNewMessages,
  getTaskById,
  storeMessageDirect,
  updateTaskAfterRun,
  createTask
} from "../src/db.js";

describe("db", () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it("stores direct messages without reply metadata and surfaces them in queries", () => {
    storeMessageDirect({
      id: "msg-1",
      chat_jid: "local-dev:default",
      sender: "user-1",
      sender_name: "User One",
      content: "@Andy hello",
      timestamp: "2026-04-04T10:00:00.000Z",
      is_from_me: false
    });

    const result = getNewMessages(["local-dev:default"], "2026-04-04T09:59:00.000Z", "Andy");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe("@Andy hello");
    expect(result.newTimestamp).toBe("2026-04-04T10:00:00.000Z");
  });

  it("updates once tasks to completed when no next run remains", () => {
    createTask({
      id: "task-1",
      group_folder: "main",
      chat_jid: "main-local:control",
      prompt: "check status",
      script: null,
      schedule_type: "once",
      schedule_value: "2026-04-04T11:00:00.000Z",
      context_mode: "isolated",
      next_run: "2026-04-04T11:00:00.000Z",
      status: "active",
      created_at: "2026-04-04T10:00:00.000Z"
    });

    expect(getDueTasks()).toHaveLength(0);
    updateTaskAfterRun("task-1", null, "ok");

    const task = getTaskById("task-1");
    expect(task?.status).toBe("completed");
    expect(task?.last_result).toBe("ok");
  });
});
