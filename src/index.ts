import { createReadlinePrompt } from "./auth/openai-codex-auth-service.js";
import { LocalDevChannel } from "./channels/local-dev-channel.js";
import { MainLocalChannel } from "./channels/main-local-channel.js";
import { loadConfig } from "./config/index.js";
import { createOrchestrator } from "./orchestrator.js";
import { runSetupStep } from "../setup/index.js";

function getFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function printUsage(): void {
  console.log(`Usage:
  npm run dev -- serve
  npm run dev -- send --channel <local-dev|main-local> --external-id <id> --message <text>
  npm run dev -- auth login --provider <openai-codex> [--method <oauth|device>]
  npm run dev -- auth status
  npm run dev -- auth logout --provider <openai-codex>
  npm run dev -- schedule-once --group-id <groupId> --message <text> [--delay-ms <ms>]
  npm run dev -- schedule-recurring --group-id <groupId> --message <text> --interval-ms <ms>
  npm run dev -- schedule-cron --group-id <groupId> --message <text> --cron <expr> [--timezone <iana>]
  npm run dev -- setup [--step <environment|groups|status|verify>]
  npm run dev -- status
  npm run dev -- verify`);
}

async function runServeCommand(): Promise<void> {
  const orchestrator = await createOrchestrator();
  try {
    orchestrator.start();
    console.log(JSON.stringify({ ok: true, mode: "serve" }, null, 2));
    await new Promise<void>((resolve) => {
      const shutdown = () => resolve();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    await orchestrator.stop();
  }
}

async function runSendCommand(args: string[]): Promise<void> {
  const orchestrator = await createOrchestrator();
  try {
    orchestrator.start();
    const channelName = getFlag(args, "--channel") ?? "local-dev";
    const externalId = getFlag(args, "--external-id") ?? (channelName === "main-local" ? "main-local:control" : "local-dev:default");
    const message = getFlag(args, "--message");
    if (!message) {
      throw new Error("--message is required");
    }

    const channel = orchestrator.channels.get(channelName);
    if (!channel) {
      throw new Error(`Unknown channel: ${channelName}`);
    }

    if (channel instanceof LocalDevChannel || channel instanceof MainLocalChannel) {
      await channel.emitInbound(externalId, message);
      console.log(JSON.stringify({ ok: true }, null, 2));
      return;
    }

    throw new Error(`Channel ${channelName} does not support local emit`);
  } finally {
    await orchestrator.stop();
  }
}

async function runAuthCommand(args: string[]): Promise<void> {
  const orchestrator = await createOrchestrator();
  try {
    const subcommand = args[1];

    if (subcommand === "login") {
      const provider = getFlag(args, "--provider") ?? "openai-codex";
      const method = getFlag(args, "--method");
      if (provider !== "openai-codex") {
        throw new Error("--provider must be openai-codex");
      }

      const result = await orchestrator.app.codexAuth.login({
        provider: "openai-codex",
        method: method === "device" ? "device" : "oauth",
        notify: async (message) => {
          console.log(message);
        },
        prompt: createReadlinePrompt
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (subcommand === "status") {
      console.log(JSON.stringify(orchestrator.app.codexAuth.status("openai-codex"), null, 2));
      return;
    }

    if (subcommand === "logout") {
      const provider = getFlag(args, "--provider") ?? "openai-codex";
      if (provider !== "openai-codex") {
        throw new Error("--provider must be openai-codex");
      }

      console.log(JSON.stringify(orchestrator.app.codexAuth.logout({ provider: "openai-codex" }), null, 2));
      return;
    }

    throw new Error(`Unknown auth command: ${subcommand ?? ""}`);
  } finally {
    await orchestrator.stop();
  }
}

async function runScheduleCommand(command: string, args: string[]): Promise<void> {
  const orchestrator = await createOrchestrator();
  try {
    const app = orchestrator.app;

    if (command === "schedule-once") {
      const groupId = getFlag(args, "--group-id");
      const message = getFlag(args, "--message");
      if (!groupId || !message) {
        throw new Error("--group-id and --message are required");
      }

      const delayMs = Number.parseInt(getFlag(args, "--delay-ms") ?? "0", 10);
      const job = app.scheduler.createOnce(groupId, message, new Date(Date.now() + delayMs));
      await app.scheduler.tick(new Date(job.nextRunAt));
      console.log(JSON.stringify(job, null, 2));
      return;
    }

    if (command === "schedule-recurring" || command === "schedule-interval") {
      const groupId = getFlag(args, "--group-id");
      const message = getFlag(args, "--message");
      const intervalMs = Number.parseInt(getFlag(args, "--interval-ms") ?? "", 10);
      if (!groupId || !message || !Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error("--group-id, --message, and a positive --interval-ms are required");
      }

      const job = app.scheduler.createInterval(groupId, message, intervalMs);
      console.log(JSON.stringify(job, null, 2));
      return;
    }

    if (command === "schedule-cron") {
      const groupId = getFlag(args, "--group-id");
      const message = getFlag(args, "--message");
      const cronExpression = getFlag(args, "--cron");
      const timezone = getFlag(args, "--timezone") ?? app.config.defaultTimezone;
      if (!groupId || !message || !cronExpression) {
        throw new Error("--group-id, --message, and --cron are required");
      }

      const job = app.scheduler.createCron(groupId, message, cronExpression, timezone);
      console.log(JSON.stringify(job, null, 2));
      return;
    }
  } finally {
    await orchestrator.stop();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help") {
    printUsage();
    return;
  }

  if (command === "setup" || command === "status" || command === "verify") {
    const step = command === "setup" ? getFlag(args, "--step") ?? "verify" : command;
    const result = await runSetupStep(step, loadConfig());
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "serve") {
    await runServeCommand();
    return;
  }

  if (command === "send") {
    await runSendCommand(args);
    return;
  }

  if (command === "auth") {
    await runAuthCommand(args);
    return;
  }

  if (
    command === "schedule-once" ||
    command === "schedule-recurring" ||
    command === "schedule-interval" ||
    command === "schedule-cron"
  ) {
    await runScheduleCommand(command, args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

void main();
