import fs from "node:fs";
import path from "node:path";

import { CronExpressionParser } from "cron-parser";

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from "./config.js";
import { createTask, deleteTask, getTaskById, updateTask } from "./db.js";
import { isValidGroupFolder } from "./group-folder.js";
import { logger } from "./logger.js";
import type { RegisteredGroup } from "./types.js";

export interface AvailableGroup {
  jid: string;
  folder: string;
  isMain: boolean;
  name: string;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug("IPC watcher already running, skipping duplicate start");
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, "ipc");
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((entry) => {
        const stat = fs.statSync(path.join(ipcBaseDir, entry));
        return stat.isDirectory() && entry !== "errors";
      });
    } catch (error) {
      logger.error({ error }, "Error reading IPC base directory");
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) {
        folderIsMain.set(group.folder, true);
      }
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, "messages");
      const tasksDir = path.join(ipcBaseDir, sourceGroup, "tasks");

      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter((file) => file.endsWith(".json"));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
              if (data.type === "message" && typeof data.chatJid === "string" && typeof data.text === "string") {
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info({ chatJid: data.chatJid, sourceGroup }, "IPC message sent");
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, "Unauthorized IPC message attempt blocked");
                }
              }
              fs.unlinkSync(filePath);
            } catch (error) {
              logger.error({ file, sourceGroup, error }, "Error processing IPC message");
              const errorDir = path.join(ipcBaseDir, "errors");
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (error) {
        logger.error({ error, sourceGroup }, "Error reading IPC messages directory");
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter((file) => file.endsWith(".json"));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (error) {
              logger.error({ file, sourceGroup, error }, "Error processing IPC task");
              const errorDir = path.join(ipcBaseDir, "errors");
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (error) {
        logger.error({ error, sourceGroup }, "Error reading IPC tasks directory");
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  void processIpcFiles();
  logger.info("IPC watcher started (per-group namespaces)");
}

export async function processTaskIpc(
  data: {
    type?: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup["containerConfig"];
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case "schedule_task": {
      if (!data.prompt || !data.schedule_type || !data.schedule_value || !data.targetJid) {
        break;
      }
      const targetJid = data.targetJid;
      const targetGroupEntry = registeredGroups[targetJid];
      if (!targetGroupEntry) {
        logger.warn({ targetJid }, "Cannot schedule task: target group not registered");
        break;
      }
      const targetFolder = targetGroupEntry.folder;
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn({ sourceGroup, targetFolder }, "Unauthorized schedule_task attempt blocked");
        break;
      }

      const scheduleType = data.schedule_type as "cron" | "interval" | "once";
      let nextRun: string | null = null;
      if (scheduleType === "cron") {
        try {
          const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn({ scheduleValue: data.schedule_value }, "Invalid cron expression");
          break;
        }
      } else if (scheduleType === "interval") {
        const ms = Number.parseInt(data.schedule_value, 10);
        if (Number.isNaN(ms) || ms <= 0) {
          logger.warn({ scheduleValue: data.schedule_value }, "Invalid interval");
          break;
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else {
        const date = new Date(data.schedule_value);
        if (Number.isNaN(date.getTime())) {
          logger.warn({ scheduleValue: data.schedule_value }, "Invalid timestamp");
          break;
        }
        nextRun = date.toISOString();
      }

      const taskId = data.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode = data.context_mode === "group" || data.context_mode === "isolated" ? data.context_mode : "isolated";
      createTask({
        id: taskId,
        group_folder: targetFolder,
        chat_jid: targetJid,
        prompt: data.prompt,
        script: data.script || null,
        schedule_type: scheduleType,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: "active",
        created_at: new Date().toISOString()
      });
      deps.onTasksChanged();
      break;
    }
    case "pause_task":
    case "resume_task":
    case "cancel_task": {
      if (!data.taskId) {
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || (!isMain && task.group_folder !== sourceGroup)) {
        logger.warn({ taskId: data.taskId, sourceGroup }, `Unauthorized task ${data.type} attempt`);
        break;
      }
      if (data.type === "cancel_task") {
        deleteTask(data.taskId);
      } else {
        updateTask(data.taskId, { status: data.type === "pause_task" ? "paused" : "active" });
      }
      deps.onTasksChanged();
      break;
    }
    case "refresh_groups":
      if (!isMain) {
        logger.warn({ sourceGroup }, "Unauthorized refresh_groups attempt blocked");
        break;
      }
      await deps.syncGroups(true);
      deps.writeGroupsSnapshot(sourceGroup, true, deps.getAvailableGroups(), new Set(Object.keys(registeredGroups)));
      break;
    case "register_group":
      if (!isMain) {
        logger.warn({ sourceGroup }, "Unauthorized register_group attempt blocked");
        break;
      }
      if (!data.jid || !data.name || !data.folder || !data.trigger) {
        logger.warn({ data }, "Invalid register_group request - missing required fields");
        break;
      }
      if (!isValidGroupFolder(data.folder)) {
        logger.warn({ sourceGroup, folder: data.folder }, "Invalid register_group request - unsafe folder name");
        break;
      }
      deps.registerGroup(data.jid, {
        name: data.name,
        folder: data.folder,
        trigger: data.trigger,
        added_at: new Date().toISOString(),
        ...(data.containerConfig ? { containerConfig: data.containerConfig } : {}),
        ...(data.requiresTrigger !== undefined ? { requiresTrigger: data.requiresTrigger } : {}),
        ...(registeredGroups[data.jid]?.isMain !== undefined ? { isMain: registeredGroups[data.jid]!.isMain } : {})
      });
      break;
    default:
      logger.warn({ type: data.type }, "Unknown IPC task type");
  }
}
