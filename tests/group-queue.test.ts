import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  DATA_DIR: "/tmp/nanoclaw-test-data",
  MAX_CONCURRENT_CONTAINERS: 2
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn()
    }
  };
});

import { GroupQueue } from "../src/group-queue.js";

describe("group queue", () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only runs one container per group at a time", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async () => {
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount -= 1;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck("group1@g.us");
    queue.enqueueMessageCheck("group1@g.us");

    await vi.advanceTimersByTimeAsync(200);
    expect(maxConcurrent).toBe(1);
  });

  it("respects global concurrency limit", async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      activeCount += 1;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount -= 1;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck("group1@g.us");
    queue.enqueueMessageCheck("group2@g.us");
    queue.enqueueMessageCheck("group3@g.us");

    await vi.advanceTimersByTimeAsync(10);
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    const release = completionCallbacks[0];
    expect(release).toBeTypeOf("function");
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  it("drains tasks before messages for the same group", async () => {
    const executionOrder: string[] = [];
    let resolveFirst!: () => void;

    const processMessages = vi.fn(async () => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push("messages");
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck("group1@g.us");
    await vi.advanceTimersByTimeAsync(10);

    const taskFn = vi.fn(async () => {
      executionOrder.push("task");
    });
    queue.enqueueTask("group1@g.us", "task-1", taskFn);
    queue.enqueueMessageCheck("group1@g.us");

    resolveFirst();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder[0]).toBe("messages");
    expect(executionOrder[1]).toBe("task");
  });

  it("retries with exponential backoff on failure", async () => {
    let callCount = 0;
    queue.setProcessMessagesFn(async () => {
      callCount += 1;
      return false;
    });

    queue.enqueueMessageCheck("group1@g.us");
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  it("prevents new enqueues after shutdown", async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);
    queue.enqueueMessageCheck("group1@g.us");
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  it("stops retrying after max retries and resets", async () => {
    let callCount = 0;
    queue.setProcessMessagesFn(async () => {
      callCount += 1;
      return false;
    });

    queue.enqueueMessageCheck("group1@g.us");
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i += 1) {
      const delay = retryDelays[i];
      expect(delay).toBeTypeOf("number");
      await vi.advanceTimersByTimeAsync(delay! + 10);
      expect(callCount).toBe(i + 2);
    }

    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  it("drains waiting groups when active slots free up", async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    queue.setProcessMessagesFn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.enqueueMessageCheck("group1@g.us");
    queue.enqueueMessageCheck("group2@g.us");
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueMessageCheck("group3@g.us");
    await vi.advanceTimersByTimeAsync(10);
    expect(processed).toEqual(["group1@g.us", "group2@g.us"]);

    completionCallbacks[0]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(processed).toContain("group3@g.us");
  });

  it("rejects duplicate enqueue of a currently running task", async () => {
    let resolveTask!: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount += 1;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask("group1@g.us", "task-1", taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    const dupFn = vi.fn(async () => undefined);
    queue.enqueueTask("group1@g.us", "task-1", dupFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(dupFn).not.toHaveBeenCalled();

    resolveTask();
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);
  });
});
