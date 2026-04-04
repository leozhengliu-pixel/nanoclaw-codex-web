import { randomUUID } from "node:crypto";
import path from "node:path";

import { OpenAICodexAuthService } from "./auth/openai-codex-auth-service.js";
import { ProviderAuthService } from "./auth/provider-auth-service.js";
import { getChannelFactory, getRegisteredChannelNames, type Channel } from "./channels/registry.js";
import "./channels/index.js";
import { StorageBackedRemoteControlRecorder, type RemoteControlRecorder } from "./control-events.js";
import { ASSISTANT_NAME, TIMEZONE, getTriggerPattern } from "./config.js";
import { loadConfig, type AppConfig } from "./config/index.js";
import {
  _closeDatabase,
  appendRemoteControlEvent,
  appendTranscriptEvent,
  clearProviderAuth,
  createExecutionTask,
  createTask as createScheduledTask,
  getAllTasks,
  getExecutionTask,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getProviderAuth,
  getRegisteredGroup,
  getRouterState,
  getSession,
  getTaskById,
  initDatabase,
  listExecutionTasks,
  listProviderAuth,
  listRemoteControlEvents,
  logTaskRun,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateExecutionTask,
  updateRegisteredGroupMounts,
  updateRegisteredGroupRuntime,
  updateTaskAfterRun,
  upsertProviderAuth
} from "./db.js";
import { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import { GroupManager } from "./host/group-manager.js";
import { RunnerToolHandler, type ToolHandlerControlPlane } from "./runner/tool-handler.js";
import { ContainerRunner } from "./runner/container-runner.js";
import { CodexRuntime } from "./runtime/codex/codex-runtime.js";
import { getDefaultModelRef, parseModelRef } from "./runtime/openai/model-policy.js";
import { isSenderAllowed, isTriggerAllowed, loadSenderAllowlist, shouldDropMessage } from "./sender-allowlist.js";
import { computeNextRun, startSchedulerLoop, stopSchedulerLoop } from "./task-scheduler.js";
import type { AdditionalMount, RegisteredGroup as RootRegisteredGroup, ScheduledTask } from "./types.js";
import type { ScheduledJob as CompatScheduledJob } from "./types/host.js";
import type { AgentRuntime, PersistedRuntimeSession, RuntimeEvent, RuntimeMessage } from "./types/runtime.js";

interface CompatRegisteredGroup {
  id: string;
  channel: string;
  externalId: string;
  folder: string;
  isMain: boolean;
  trigger: string;
  containerConfig: {
    additionalMounts: AdditionalMount[];
    timeoutMs?: number;
  };
  runtimeConfig?: RootRegisteredGroup["runtimeConfig"];
  createdAt: string;
}

interface CompatTaskResult {
  taskId: string;
  events: RuntimeEvent[];
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";
}

export interface OrchestratorAppFacade {
  config: AppConfig;
  runtime: AgentRuntime;
  providerAuth: ProviderAuthService;
  codexAuth: OpenAICodexAuthService;
  remoteControl: RemoteControlRecorder;
  storage: {
    getRegisteredGroupByAddress(channel: string, externalId: string): CompatRegisteredGroup | null;
    getRegisteredGroup(groupId: string): CompatRegisteredGroup | null;
    listTasks(groupId?: string): ReturnType<typeof listExecutionTasks>;
    getTask(taskId: string): ReturnType<typeof getExecutionTask> | null;
    getScheduledJob(jobId: string): CompatScheduledJob | null;
  };
  scheduler: {
    createOnce(groupId: string, message: string, runAt: Date): CompatScheduledJob;
    createInterval(groupId: string, message: string, intervalMs: number): CompatScheduledJob;
    createCron(groupId: string, message: string, cronExpression: string, timezone: string): CompatScheduledJob;
    tick(now?: Date): Promise<void>;
  };
  host: {
    enqueueScheduledPrompt(groupId: string, prompt: string, scheduledJobId?: string): Promise<CompatTaskResult>;
  };
  router: {
    handleInbound(message: {
      id?: string;
      channel: string;
      externalId: string;
      text: string;
      senderId?: string;
      senderName?: string;
      createdAt?: string;
    }): Promise<CompatTaskResult | null>;
  };
  controlPlane: ToolHandlerControlPlane;
}

export interface OrchestratorServices {
  config: AppConfig;
  app: OrchestratorAppFacade;
  channels: Map<string, Channel>;
  queue: GroupQueue;
  start: () => void;
  stop: () => Promise<void>;
}

function normalizeTriggeredText(group: RootRegisteredGroup, text: string): string | null {
  const trimmed = text.trim();
  if (group.isMain) {
    return trimmed;
  }

  const triggerPattern = getTriggerPattern(group.trigger);
  if (!triggerPattern.test(trimmed)) {
    return null;
  }

  return trimmed.replace(triggerPattern, "").trim() || trimmed;
}

function toCompatGroup(jid: string, group: RootRegisteredGroup): CompatRegisteredGroup {
  const [channel = "unknown"] = jid.split(":");
  return {
    id: jid,
    channel,
    externalId: jid,
    folder: group.folder,
    isMain: group.isMain === true,
    trigger: group.trigger,
    containerConfig: {
      additionalMounts: group.containerConfig?.additionalMounts ?? [],
      ...(group.containerConfig?.timeout ? { timeoutMs: group.containerConfig.timeout } : {})
    },
    ...(group.runtimeConfig ? { runtimeConfig: group.runtimeConfig } : {}),
    createdAt: group.added_at
  };
}

function toRootGroup(group: CompatRegisteredGroup): RootRegisteredGroup {
  return {
    name: group.folder,
    folder: group.folder,
    trigger: group.trigger,
    added_at: group.createdAt,
    ...(group.containerConfig ? { containerConfig: { additionalMounts: group.containerConfig.additionalMounts } } : {}),
    ...(group.runtimeConfig ? { runtimeConfig: group.runtimeConfig } : {}),
    ...(group.isMain ? { isMain: true } : {}),
    channel: group.channel,
    externalId: group.externalId
  };
}

function toCompatScheduledJob(task: ScheduledTask): CompatScheduledJob {
  return {
    id: task.id,
    groupId: task.chat_jid,
    prompt: task.prompt,
    kind: task.schedule_type,
    nextRunAt: task.next_run ?? new Date().toISOString(),
    ...(task.schedule_type === "interval" ? { intervalMs: Number.parseInt(task.schedule_value, 10) } : {}),
    ...(task.schedule_type === "cron" ? { cronExpression: task.schedule_value, timezone: TIMEZONE } : {}),
    active: task.status === "active",
    createdAt: task.created_at,
    ...(task.last_run ? { lastRunAt: task.last_run } : {})
  };
}

function createProviderAuthStorageAdapter() {
  return {
    getProviderAuth(providerId: "openai" | "openai-codex") {
      return getProviderAuth(providerId);
    },
    upsertProviderAuth(providerId: "openai" | "openai-codex", credential: Record<string, unknown>) {
      upsertProviderAuth(providerId, credential);
    },
    clearProviderAuth(providerId: "openai" | "openai-codex") {
      clearProviderAuth(providerId);
    },
    listProviderAuth() {
      return listProviderAuth();
    }
  };
}

function createRemoteControlRecorder(): RemoteControlRecorder {
  return new StorageBackedRemoteControlRecorder({
    appendRemoteControlEvent,
    listRemoteControlEvents
  });
}

export async function createOrchestrator(config = loadConfig(), runtimeOverride?: AgentRuntime): Promise<OrchestratorServices> {
  initDatabase(path.join(config.dataRoot, "messages.db"));

  const providerAuth = new ProviderAuthService(createProviderAuthStorageAdapter(), config);
  const remoteControl = createRemoteControlRecorder();
  const codexAuth = new OpenAICodexAuthService(providerAuth, remoteControl);
  const groupManager = new GroupManager(config.groupsRoot, config.sessionsRoot, config.logsRoot);
  const senderAllowlist = loadSenderAllowlist();
  const runtime =
    runtimeOverride ?? new CodexRuntime(config.codexBinaryPath, config.runtimeTimeoutMs, providerAuth, config.agentRunnerMode);

  let registeredGroups: Record<string, RootRegisteredGroup> = {};
  let lastTimestamp = getRouterState("last_timestamp") ?? "";
  let lastAgentTimestamp: Record<string, string> = {};
  let stopping = false;
  const channels = new Map<string, Channel>();
  const queue = new GroupQueue();

  try {
    lastAgentTimestamp = JSON.parse(getRouterState("last_agent_timestamp") ?? "{}") as Record<string, string>;
  } catch {
    lastAgentTimestamp = {};
  }

  const saveState = (): void => {
    setRouterState("last_timestamp", lastTimestamp);
    setRouterState("last_agent_timestamp", JSON.stringify(lastAgentTimestamp));
  };

  const syncRegisteredGroups = (): Record<string, RootRegisteredGroup> => {
    const groups = Object.fromEntries(
      Object.keys({ ...registeredGroups }).map((jid) => [jid, getRegisteredGroup(jid) ?? registeredGroups[jid]!])
    );
    const storedGroups = Object.entries(registeredGroups).length === 0 ? [] : Object.keys(registeredGroups);
    for (const jid of storedGroups) {
      void jid;
    }
    registeredGroups = {
      ...registeredGroups,
      ...groups
    };
    return registeredGroups;
  };

  const compatGroupById = (groupId: string): CompatRegisteredGroup | null => {
    const group = registeredGroups[groupId] ?? getRegisteredGroup(groupId);
    return group ? toCompatGroup(groupId, group) : null;
  };

  const compatGroupByAddress = (channel: string, externalId: string): CompatRegisteredGroup | null => {
    const jid = externalId.includes(":") ? externalId : `${channel}:${externalId}`;
    const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
    return group ? toCompatGroup(jid, group) : null;
  };

  const sendToJid = async (jid: string, text: string): Promise<void> => {
    const channel = [...channels.values()].find((candidate) => candidate.ownsJid(jid));
    if (!channel) {
      throw new Error(`No channel for ${jid}`);
    }
    await channel.sendMessage(jid, text);
  };

  const registerGroup = (input: {
    channel: string;
    externalId: string;
    folder: string;
    isMain?: boolean;
    trigger?: string;
    containerConfig?: CompatRegisteredGroup["containerConfig"];
    runtimeConfig?: CompatRegisteredGroup["runtimeConfig"];
  }): CompatRegisteredGroup => {
    const jid = input.externalId.includes(":") ? input.externalId : `${input.channel}:${input.externalId}`;
    const group: CompatRegisteredGroup = {
      id: jid,
      channel: input.channel,
      externalId: jid,
      folder: input.folder,
      isMain: input.isMain ?? false,
      trigger: input.trigger ?? config.defaultTrigger,
      containerConfig: input.containerConfig ?? { additionalMounts: [] },
      ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
      createdAt: new Date().toISOString()
    };
    const rootGroup = toRootGroup(group);
    registeredGroups[jid] = rootGroup;
    setRegisteredGroup(jid, rootGroup);
    return group;
  };

  const listGroups = (): CompatRegisteredGroup[] =>
    Object.entries(syncRegisteredGroups()).map(([jid, group]) => toCompatGroup(jid, group));

  const createScheduledRecord = (
    groupId: string,
    prompt: string,
    scheduleType: ScheduledTask["schedule_type"],
    scheduleValue: string,
    nextRun: string | null
  ): ScheduledTask => {
    const rootGroup = registeredGroups[groupId] ?? getRegisteredGroup(groupId);
    if (!rootGroup) {
      throw new Error(`Unknown group: ${groupId}`);
    }
    const task: ScheduledTask = {
      id: randomUUID(),
      group_folder: rootGroup.folder,
      chat_jid: groupId,
      prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: "group",
      next_run: nextRun,
      last_run: null,
      last_result: null,
      status: "active",
      created_at: new Date().toISOString()
    };
    createScheduledTask(task);
    return task;
  };

  const runTaskForGroup = async (
    groupId: string,
    prompt: string,
    kind: "message" | "scheduled",
    scheduledTaskId?: string,
    sendOutbound = true
  ): Promise<CompatTaskResult> => {
    const rootGroup = registeredGroups[groupId] ?? getRegisteredGroup(groupId);
    if (!rootGroup) {
      throw new Error(`Unknown group: ${groupId}`);
    }

    const compatGroup = toCompatGroup(groupId, rootGroup);
    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    createExecutionTask({
      id: taskId,
      groupJid: groupId,
      kind,
      prompt,
      status: "queued",
      ...(scheduledTaskId ? { scheduledTaskId } : {}),
      createdAt
    });

    const managedGroup = await groupManager.ensureGroup(compatGroup as never);
    const existingSessionId = getSession(rootGroup.folder);
    const sessionHint: PersistedRuntimeSession | null = existingSessionId
      ? {
          id: existingSessionId,
          runtimeName: runtime.name,
          groupId,
          createdAt,
          updatedAt: createdAt
        }
      : null;

    const model = rootGroup.runtimeConfig ?? getDefaultModelRef();
    const session = await runtime.createSession({
      groupId,
      group: compatGroup as never,
      workingDirectory: managedGroup.workspacePath,
      memoryFiles: [managedGroup.globalMemoryFile, managedGroup.groupMemoryFile],
      runtimeTimeoutMs: compatGroup.containerConfig.timeoutMs ?? config.runtimeTimeoutMs,
      model,
      sessionHint
    });

    setSession(rootGroup.folder, session.id);
    updateExecutionTask(taskId, { status: "running", sessionId: session.id });

    const events: RuntimeEvent[] = [];
    let status: CompatTaskResult["status"] = "completed";
    try {
      for await (const event of runtime.runTurn({
        taskId,
        sessionId: session.id,
        group: compatGroup as never,
        workingDirectory: managedGroup.workspacePath,
        messages: [{ role: "user", content: prompt }] as RuntimeMessage[],
        memoryFiles: [managedGroup.globalMemoryFile, managedGroup.groupMemoryFile],
        sessionsPath: managedGroup.sessionsPath,
        runtimeTimeoutMs: compatGroup.containerConfig.timeoutMs ?? config.runtimeTimeoutMs,
        model
      })) {
        events.push(event);
        appendTranscriptEvent(taskId, rootGroup.folder, event as unknown as Record<string, unknown>);
        if (event.type === "message" && sendOutbound) {
          await sendToJid(groupId, event.text);
        } else if (event.type === "error") {
          status = "failed";
        }
      }
    } catch (error) {
      status = "failed";
      events.push({
        type: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    updateExecutionTask(taskId, { status, sessionId: session.id });
    return { taskId, events, sessionId: session.id, status };
  };

  const handleMainCommand = async (groupId: string, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === "/list-groups") {
      const groups = listGroups();
      await sendToJid(groupId, groups.map((item) => `${item.channel}:${item.externalId} -> ${item.folder}`).join("\n"));
      return;
    }
    if (trimmed === "/remote-status") {
      const status = remoteControl.status();
      const message = status.recentEvents.map((event) => `[${event.level}] ${event.message}`).join("\n") || "No events";
      await sendToJid(groupId, message);
      return;
    }
    if (trimmed === "/auth-status") {
      const row = codexAuth.status("openai-codex");
      const message =
        row.state === "missing"
          ? "openai-codex: missing"
          : [
              `${row.provider}: oauth state=${row.state}`,
              `expires=${new Date(row.expiresAt ?? 0).toISOString()}`,
              `account=${row.accountId ?? "n/a"}`,
              `email=${row.email ?? "n/a"}`,
              `method=${row.method ?? "unknown"}`,
              `source=${row.source ?? "project-store"}`
            ].join(" ");
      await sendToJid(groupId, message);
      return;
    }
    if (trimmed.startsWith("/auth-login ")) {
      const parts = trimmed.split(/\s+/);
      const provider = parts[1];
      const methodIndex = parts.indexOf("--method");
      const method = methodIndex !== -1 ? parts[methodIndex + 1] : undefined;
      if (provider !== "openai-codex") {
        await sendToJid(groupId, "Usage: /auth-login openai-codex [--method oauth|device]");
        return;
      }
      const updates: string[] = [];
      let message = "";
      try {
        const result = await codexAuth.login({
          provider: "openai-codex",
          method: method === "device" ? "device" : "oauth",
          notify: async (notifyMessage) => {
            updates.push(notifyMessage);
          }
        });
        message = [...updates, result.message].join("\n\n");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        remoteControl.record("error", "Main command auth login failed", {
          provider: "openai-codex",
          method: method === "device" ? "device" : "oauth",
          error: errorMessage
        });
        message = [...updates, `openai-codex login failed: ${errorMessage}`].join("\n\n");
      }
      await sendToJid(groupId, message);
      return;
    }
    if (trimmed === "/auth-logout openai-codex") {
      const result = codexAuth.logout({ provider: "openai-codex" });
      await sendToJid(groupId, result.message);
      return;
    }
    if (trimmed.startsWith("/register-group ")) {
      const [, channel, externalId, folder] = trimmed.split(/\s+/, 4);
      if (!channel || !externalId || !folder) {
        await sendToJid(groupId, "Usage: /register-group <channel> <externalId> <folder>");
        return;
      }
      const registered = registerGroup({ channel, externalId, folder });
      remoteControl.record("info", "Registered group via main-local command", { groupId: registered.id });
      await sendToJid(groupId, `Registered ${registered.channel}:${registered.externalId} as ${registered.folder}`);
      return;
    }
    if (trimmed.startsWith("/set-model ")) {
      const [, targetGroupId, modelText] = trimmed.split(/\s+/, 3);
      const model = modelText ? parseModelRef(modelText) : null;
      if (!targetGroupId || !model) {
        await sendToJid(groupId, "Usage: /set-model <groupId> <openai|openai-codex/model>");
        return;
      }
      updateRegisteredGroupRuntime(targetGroupId, model);
      registeredGroups = syncRegisteredGroups();
      await sendToJid(groupId, `Updated ${targetGroupId} model to ${model.provider}/${model.modelId}`);
      return;
    }
    if (trimmed.startsWith("/get-model ")) {
      const [, targetGroupId] = trimmed.split(/\s+/, 2);
      const registered = targetGroupId ? compatGroupById(targetGroupId) : null;
      if (!registered) {
        await sendToJid(groupId, "Unknown group");
        return;
      }
      const current = registered.runtimeConfig;
      await sendToJid(groupId, current ? `${registered.id}: ${current.provider}/${current.modelId}` : `${registered.id}: default model`);
      return;
    }
    await sendToJid(groupId, `Unknown main command: ${trimmed}`);
  };

  const handleInbound = async (message: {
    id?: string;
    channel: string;
    externalId: string;
    text: string;
    senderId?: string;
    senderName?: string;
    createdAt?: string;
  }): Promise<CompatTaskResult | null> => {
    const group = compatGroupByAddress(message.channel, message.externalId);
    if (!group) {
      remoteControl.record("warn", "Ignoring message from unregistered group", {
        channel: message.channel,
        externalId: message.externalId
      });
      return null;
    }
    if (group.isMain && message.text.startsWith("/")) {
      await handleMainCommand(group.id, message.text);
      return null;
    }
    const sender = message.senderId ?? message.senderName ?? "unknown";
    if (!isSenderAllowed(group.id, sender, senderAllowlist) && shouldDropMessage(group.id, senderAllowlist)) {
      remoteControl.record("info", "Dropped message from disallowed sender", {
        groupId: group.id,
        sender
      });
      return null;
    }
    if (!group.isMain && !isTriggerAllowed(group.id, sender, senderAllowlist)) {
      return null;
    }
    const normalized = normalizeTriggeredText(toRootGroup(group), message.text);
    if (!normalized) {
      return null;
    }
    return await runTaskForGroup(group.id, normalized, "message");
  };

  const runDueScheduledTasks = async (now = new Date()): Promise<void> => {
    const nowIso = now.toISOString();
    const dueTasks = getAllTasks().filter((task) => task.status === "active" && task.next_run !== null && task.next_run <= nowIso);
    for (const task of dueTasks) {
      const startTime = Date.now();
      let result: string | null = null;
      let error: string | null = null;
      try {
        const runResult = await runTaskForGroup(task.chat_jid, task.prompt, "scheduled", task.id);
        const messageEvent = runResult.events.find((event) => event.type === "message");
        result = messageEvent && "text" in messageEvent ? messageEvent.text : null;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: error ? "error" : "success",
        result,
        error
      });
      updateTaskAfterRun(task.id, computeNextRun(task, now), error ? `Error: ${error}` : result ? result.slice(0, 200) : "Completed");
    }
  };

  const controlPlane: ToolHandlerControlPlane = {
    scheduleJob(input) {
      const nextRun =
        input.scheduleType === "interval"
          ? new Date(Date.now() + Number.parseInt(input.scheduleValue, 10)).toISOString()
          : input.scheduleType === "cron"
            ? computeNextRun({
                id: "preview",
                group_folder: compatGroupById(input.groupId)?.folder ?? input.groupId,
                chat_jid: input.groupId,
                prompt: input.prompt,
                schedule_type: "cron",
                schedule_value: input.scheduleValue,
                context_mode: "group",
                next_run: new Date().toISOString(),
                last_run: null,
                last_result: null,
                status: "active",
                created_at: new Date().toISOString()
              })
            : input.scheduleValue;
      const task = createScheduledRecord(input.groupId, input.prompt, input.scheduleType, input.scheduleValue, nextRun);
      return { jobId: task.id };
    },
    scheduleTask(input) {
      if (input.intervalMs && input.intervalMs > 0) {
        const task = createScheduledRecord(
          input.groupId,
          input.prompt,
          "interval",
          String(input.intervalMs),
          new Date(Date.now() + input.intervalMs).toISOString()
        );
        return { jobId: task.id };
      }
      const task = createScheduledRecord(input.groupId, input.prompt, "once", input.runAt ?? new Date().toISOString(), input.runAt ?? new Date().toISOString());
      return { jobId: task.id };
    },
    listTasks(groupId) {
      return listExecutionTasks(groupId);
    },
    getTask(taskId) {
      return getExecutionTask(taskId) ?? null;
    },
    pauseTask(taskId) {
      updateExecutionTask(taskId, { status: "paused" });
    },
    resumeTask(taskId) {
      updateExecutionTask(taskId, { status: "queued" });
    },
    cancelTask(taskId) {
      updateExecutionTask(taskId, { status: "cancelled" });
    },
    async sendMessage(groupId, text) {
      await sendToJid(groupId, text);
    },
    registerGroup(input) {
      return registerGroup(input);
    },
    listGroups() {
      return listGroups();
    },
    updateGroupMounts(groupId, containerConfig) {
      updateRegisteredGroupMounts(groupId, {
        additionalMounts: containerConfig.additionalMounts as AdditionalMount[]
      });
      registeredGroups = syncRegisteredGroups();
    }
  };

  if (runtime instanceof CodexRuntime) {
    runtime.attachRunner(new ContainerRunner(config, new RunnerToolHandler(controlPlane, remoteControl)));
  }

  if (!compatGroupByAddress("local-dev", "local-dev:default")) {
    registerGroup({ channel: "local-dev", externalId: "local-dev:default", folder: "local-dev_default" });
  }
  if (!compatGroupByAddress("main-local", "main-local:control")) {
    registerGroup({
      channel: "main-local",
      externalId: "main-local:control",
      folder: "main",
      isMain: true,
      trigger: config.defaultTrigger
    });
  }

  registeredGroups = syncRegisteredGroups();

  for (const name of getRegisteredChannelNames()) {
    const factory = getChannelFactory(name);
    const instance = factory?.({
      onMessage: async (chatJid, message) => {
        if (stopping) return;
        storeMessage(message);
        if (message.timestamp > lastTimestamp) {
          lastTimestamp = message.timestamp;
          saveState();
        }
        if (registeredGroups[chatJid]) {
          queue.enqueueMessageCheck(chatJid);
        } else {
          remoteControl.record("warn", "Ignoring message from unregistered group", { jid: chatJid });
        }
      },
      onChatMetadata: (chatJid, timestamp, chatName, channel, isGroup) => {
        if (stopping) return;
        storeChatMetadata(chatJid, timestamp, chatName, channel, isGroup);
      },
      registeredGroups: () => registeredGroups
    });
    if (!instance) continue;
    const originalSend = instance.sendMessage.bind(instance);
    instance.sendMessage = async (jid: string, text: string): Promise<void> => {
      const now = new Date().toISOString();
      storeChatMetadata(jid, now, jid, instance.name, jid !== "main-local:control" && jid !== "local-dev:default");
      storeMessage({
        id: `bot:${randomUUID()}`,
        chat_jid: jid,
        sender: ASSISTANT_NAME,
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp: now,
        is_from_me: true,
        is_bot_message: true
      });
      await originalSend(jid, text);
    };
    await instance.connect();
    channels.set(name, instance);
  }

  queue.setProcessMessagesFn(async (chatJid: string) => {
    if (stopping) return true;
    const group = registeredGroups[chatJid];
    if (!group) return true;

    const missedMessages = getMessagesSince(
      chatJid,
      lastAgentTimestamp[chatJid] ?? getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME) ?? "",
      ASSISTANT_NAME
    );
    if (missedMessages.length === 0) {
      return true;
    }

    if (!group.isMain && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const hasTrigger = missedMessages.some((message) => triggerPattern.test(message.content.trim()));
      if (!hasTrigger) {
        return true;
      }
    }

    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1]!.timestamp;
    saveState();

    for (const message of missedMessages) {
      const [channel = "unknown"] = chatJid.split(":");
      await handleInbound({
        id: message.id,
        channel,
        externalId: chatJid,
        text: message.content,
        senderId: message.sender,
        senderName: message.sender_name,
        createdAt: message.timestamp
      });
      registeredGroups = syncRegisteredGroups();
    }

    return true;
  });

  const app: OrchestratorAppFacade = {
    config,
    runtime,
    providerAuth,
    codexAuth,
    remoteControl,
    storage: {
      getRegisteredGroupByAddress: compatGroupByAddress,
      getRegisteredGroup: compatGroupById,
      listTasks(groupId?: string) {
        return listExecutionTasks(groupId);
      },
      getTask(taskId: string) {
        return getExecutionTask(taskId) ?? null;
      },
      getScheduledJob(jobId: string) {
        const task = getTaskById(jobId);
        return task ? toCompatScheduledJob(task) : null;
      }
    },
    scheduler: {
      createOnce(groupId, message, runAt) {
        return toCompatScheduledJob(createScheduledRecord(groupId, message, "once", runAt.toISOString(), runAt.toISOString()));
      },
      createInterval(groupId, message, intervalMs) {
        return toCompatScheduledJob(
          createScheduledRecord(groupId, message, "interval", String(intervalMs), new Date(Date.now() + intervalMs).toISOString())
        );
      },
      createCron(groupId, message, cronExpression, _timezone) {
        const nextRun = computeNextRun({
          id: "preview",
          group_folder: compatGroupById(groupId)?.folder ?? groupId,
          chat_jid: groupId,
          prompt: message,
          schedule_type: "cron",
          schedule_value: cronExpression,
          context_mode: "group",
          next_run: new Date().toISOString(),
          last_run: null,
          last_result: null,
          status: "active",
          created_at: new Date().toISOString()
        });
        return toCompatScheduledJob(createScheduledRecord(groupId, message, "cron", cronExpression, nextRun));
      },
      async tick(now?: Date) {
        await runDueScheduledTasks(now);
      }
    },
    host: {
      async enqueueScheduledPrompt(groupId, prompt, scheduledJobId) {
        return await runTaskForGroup(groupId, prompt, "scheduled", scheduledJobId);
      }
    },
    router: {
      async handleInbound(message) {
        return await handleInbound(message);
      }
    },
    controlPlane
  };

  const start = (): void => {
    registeredGroups = syncRegisteredGroups();
    for (const jid of Object.keys(registeredGroups)) {
      queue.enqueueMessageCheck(jid);
    }
    startSchedulerLoop({
      registeredGroups: () => registeredGroups,
      queue,
      runTask: async (task) => {
        const result = await runTaskForGroup(task.chat_jid, task.prompt, "scheduled", task.id, true);
        const messageEvent = result.events.find((event) => event.type === "message");
        return messageEvent && "text" in messageEvent ? messageEvent.text : null;
      },
      sendMessage: async () => {}
    });
    logger.info({ groupCount: Object.keys(registeredGroups).length, timezone: TIMEZONE }, "NanoClaw-compatible orchestrator started");
  };

  return {
    config,
    app,
    channels,
    queue,
    start,
    stop: async () => {
      stopping = true;
      stopSchedulerLoop();
      await queue.shutdown(0);
      await Promise.all([...channels.values()].map((channel) => channel.disconnect()));
      _closeDatabase();
    }
  };
}
