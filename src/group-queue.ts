import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from "./config.js";
import { logger } from "./logger.js";

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null = null;
  private shuttingDown = false;
  private readonly activeWaiters = new Set<() => void>();

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  public setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  public enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);
    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, "Container active, message queued");
      return;
    }
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) this.waitingGroups.push(groupJid);
      logger.debug({ groupJid, activeCount: this.activeCount }, "At concurrency limit, message queued");
      return;
    }
    void this.runForGroup(groupJid, "messages").catch((err) => logger.error({ groupJid, err }, "Unhandled error in runForGroup"));
  }

  public enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);
    if (state.runningTaskId === taskId || state.pendingTasks.some((t) => t.id === taskId)) return;
    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) this.closeStdin(groupJid);
      return;
    }
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) this.waitingGroups.push(groupJid);
      return;
    }
    void this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) => logger.error({ groupJid, taskId, err }, "Unhandled error in runTask"));
  }

  public registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  public notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  public sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
    state.idleWaiting = false;
    const inputDir = path.join(DATA_DIR, "ipc", state.groupFolder, "input");
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: "message", text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  public closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;
    const inputDir = path.join(DATA_DIR, "ipc", state.groupFolder, "input");
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, "_close"), "");
    } catch {
      // ignore
    }
  }

  private async runForGroup(groupJid: string, _reason: "messages" | "drain"): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;
    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) state.retryCount = 0;
        else this.scheduleRetry(groupJid, state);
      }
    } catch (err) {
      logger.error({ groupJid, err }, "Error processing messages for group");
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.notifyIfIdle();
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;
    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, "Error running task");
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.notifyIfIdle();
      this.drainGroup(groupJid);
    }
  }

  private notifyIfIdle(): void {
    if (this.activeCount !== 0) {
      return;
    }

    for (const resolve of this.activeWaiters) {
      resolve();
    }
    this.activeWaiters.clear();
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error({ groupJid, retryCount: state.retryCount }, "Max retries exceeded, dropping messages");
      state.retryCount = 0;
      return;
    }
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    setTimeout(() => {
      if (!this.shuttingDown) this.enqueueMessageCheck(groupJid);
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      void this.runTask(groupJid, task).catch((err) => logger.error({ groupJid, taskId: task.id, err }, "Unhandled error in runTask (drain)"));
      return;
    }
    if (state.pendingMessages) {
      void this.runForGroup(groupJid, "drain").catch((err) => logger.error({ groupJid, err }, "Unhandled error in runForGroup (drain)"));
      return;
    }
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (this.waitingGroups.length > 0 && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        void this.runTask(nextJid, task).catch((err) => logger.error({ groupJid: nextJid, taskId: task.id, err }, "Unhandled error in runTask (waiting)"));
      } else if (state.pendingMessages) {
        void this.runForGroup(nextJid, "drain").catch((err) => logger.error({ groupJid: nextJid, err }, "Unhandled error in runForGroup (waiting)"));
      }
    }
  }

  public async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    if (this.activeCount === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.activeWaiters.add(resolve);
    });
  }
}
