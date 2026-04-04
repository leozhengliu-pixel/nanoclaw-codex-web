import { CronExpressionParser } from "cron-parser";

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from "./config.js";
import { getDueTasks, getTaskById, logTaskRun, updateTaskAfterRun } from "./db.js";
import { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import type { RegisteredGroup, ScheduledTask } from "./types.js";

export function computeNextRun(task: ScheduledTask, now = new Date()): string | null {
  if (task.schedule_type === "once") return null;

  const nowMs = now.getTime();

  if (task.schedule_type === "cron") {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
      currentDate: now
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === "interval") {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn({ taskId: task.id, value: task.schedule_value }, "Invalid interval value");
      return new Date(nowMs + 60_000).toISOString();
    }
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= nowMs) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  runTask: (task: ScheduledTask, group: RegisteredGroup) => Promise<string | null>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runScheduledTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groups = deps.registeredGroups();
  const group = Object.entries(groups).find(([, value]) => value.folder === task.group_folder)?.[1];

  if (!group) {
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: "error",
      result: null,
      error: `Group not found: ${task.group_folder}`
    });
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    result = await deps.runTask(task, group);
    if (result) {
      await deps.sendMessage(task.chat_jid, result);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, "Task failed");
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: error ? "error" : "success",
    result,
    error
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error ? `Error: ${error}` : result ? result.slice(0, 200) : "Completed";
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
let schedulerTimer: NodeJS.Timeout | undefined;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug("Scheduler loop already running, skipping duplicate start");
    return;
  }
  schedulerRunning = true;
  logger.info("Scheduler loop started");

  const loop = async () => {
    if (!schedulerRunning) {
      return;
    }

    try {
      const dueTasks = getDueTasks();
      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== "active") {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () => runScheduledTask(currentTask, deps));
      }
    } catch (err) {
      logger.error({ err }, "Error in scheduler loop");
    }

    if (schedulerRunning) {
      schedulerTimer = setTimeout(loop, SCHEDULER_POLL_INTERVAL);
    }
  };

  void loop();
}

export function stopSchedulerLoop(): void {
  schedulerRunning = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = undefined;
  }
}

export function _resetSchedulerLoopForTests(): void {
  stopSchedulerLoop();
}
