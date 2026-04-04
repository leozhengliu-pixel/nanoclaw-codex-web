import type { RemoteControlRecorder } from "../control-events.js";
import type { ToolRequestEnvelope, ToolResponseEnvelope } from "../ipc/protocol.js";

export interface ToolHandlerControlPlane {
  scheduleJob(input: {
    groupId: string;
    prompt: string;
    scheduleType: "once" | "interval" | "cron";
    scheduleValue: string;
    timezone?: string;
  }): unknown;
  scheduleTask(input: {
    groupId: string;
    prompt: string;
    intervalMs?: number;
    runAt?: string;
  }): unknown;
  listTasks(groupId?: string): unknown;
  getTask(taskId: string): unknown;
  pauseTask(taskId: string): void;
  resumeTask(taskId: string): void;
  cancelTask(taskId: string): void;
  sendMessage(groupId: string, text: string): Promise<void>;
  registerGroup(input: {
    channel: string;
    externalId: string;
    folder: string;
  }): unknown;
  listGroups(): unknown;
  updateGroupMounts(groupId: string, containerConfig: {
    additionalMounts: Array<unknown>;
  }): void;
}

export class RunnerToolHandler {
  public constructor(
    private readonly controlPlane: ToolHandlerControlPlane,
    private readonly remoteControl: RemoteControlRecorder
  ) {}

  public async handleToolRequest(request: ToolRequestEnvelope): Promise<ToolResponseEnvelope> {
    try {
      const result = await this.dispatch(request);
      this.remoteControl.record("info", `Handled tool request ${request.payload.name}`, {
        taskId: request.taskId
      });
      return {
        id: request.id,
        ok: true,
        result
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async dispatch(request: ToolRequestEnvelope): Promise<unknown> {
    const { name, args } = request.payload;
    switch (name) {
      case "schedule_task":
        if (typeof args.scheduleType === "string" && typeof args.scheduleValue === "string") {
          return this.controlPlane.scheduleJob({
            groupId: String(args.groupId),
            prompt: String(args.prompt),
            scheduleType: args.scheduleType as "once" | "interval" | "cron",
            scheduleValue: args.scheduleValue,
            ...(typeof args.timezone === "string" ? { timezone: args.timezone } : {})
          });
        }

        return this.controlPlane.scheduleTask({
          groupId: String(args.groupId),
          prompt: String(args.prompt),
          ...(typeof args.intervalMs === "number" ? { intervalMs: args.intervalMs } : {}),
          ...(typeof args.runAt === "string" ? { runAt: args.runAt } : {})
        });
      case "list_tasks":
        return this.controlPlane.listTasks(typeof args.groupId === "string" ? args.groupId : undefined);
      case "get_task":
        return this.controlPlane.getTask(String(args.taskId));
      case "pause_task":
        this.controlPlane.pauseTask(String(args.taskId));
        return { ok: true };
      case "resume_task":
        this.controlPlane.resumeTask(String(args.taskId));
        return { ok: true };
      case "cancel_task":
        this.controlPlane.cancelTask(String(args.taskId));
        return { ok: true };
      case "send_message":
        await this.controlPlane.sendMessage(String(args.groupId), String(args.text));
        return { ok: true };
      case "register_group":
        return this.controlPlane.registerGroup({
          channel: String(args.channel),
          externalId: String(args.externalId),
          folder: String(args.folder)
        });
      case "list_groups":
        return this.controlPlane.listGroups();
      case "update_group_mounts":
        this.controlPlane.updateGroupMounts(String(args.groupId), {
          additionalMounts: Array.isArray(args.additionalMounts) ? (args.additionalMounts as never[]) : []
        });
        return { ok: true };
      default:
        throw new Error(`Unsupported tool request: ${String(name)}`);
    }
  }
}
