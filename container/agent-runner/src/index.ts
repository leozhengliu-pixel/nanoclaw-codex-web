import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { RunnerTaskRequest, RuntimeEventEnvelope, ToolRequestEnvelope, ToolResponseEnvelope } from "../../../src/ipc/protocol.js";
import type { ProviderCredential } from "../../../src/types/runtime.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function waitForChildClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }

  return await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function waitForReadableToFinish(stream: Readable | null | undefined): Promise<void> {
  if (!stream) {
    return Promise.resolve();
  }

  const typed = stream as Readable & { readableEnded?: boolean; closed?: boolean; destroyed?: boolean };
  if (typed.readableEnded || typed.closed || typed.destroyed) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

function isJsonObjectLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function parseCodexEventLine(line: string): Record<string, unknown> | null {
  if (!isJsonObjectLine(line)) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function collectAgentMessage(payload: Record<string, unknown>): string | null {
  if (payload.type !== "item.completed") {
    return null;
  }

  const item = payload.item;
  if (!item || typeof item !== "object") {
    return null;
  }

  const typedItem = item as { type?: unknown; text?: unknown };
  if (typedItem.type !== "agent_message" || typeof typedItem.text !== "string") {
    return null;
  }

  return typedItem.text.trim() || null;
}

async function appendEvent(eventsFile: string, taskId: string, event: RuntimeEventEnvelope["event"]): Promise<void> {
  const envelope: RuntimeEventEnvelope = { taskId, event };
  await fs.appendFile(eventsFile, `${JSON.stringify(envelope)}\n`);
}

async function requestTool(ipcDir: string, taskId: string, payload: ToolRequestEnvelope["payload"]): Promise<unknown> {
  const id = randomUUID();
  const requestPath = path.join(ipcDir, "tool-requests", `${id}.json`);
  const responsePath = path.join(ipcDir, "tool-responses", `${id}.json`);
  const request: ToolRequestEnvelope = { id, taskId, payload };
  await fs.writeFile(requestPath, JSON.stringify(request, null, 2));

  while (true) {
    const exists = await fs
      .access(responsePath)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      const response = JSON.parse(await fs.readFile(responsePath, "utf8")) as ToolResponseEnvelope;
      if (!response.ok) {
        throw new Error(response.error ?? "Tool request failed");
      }
      return response.result;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runMock(request: RunnerTaskRequest, ipcDir: string, eventsFile: string): Promise<void> {
  const lastMessage = request.messages.at(-1)?.content ?? "";
  const markerPath = path.join(request.workingDirectory, ".nanoclaw-runner-touch");
  await fs.writeFile(markerPath, `task=${request.taskId}\nsession=${request.sessionId}\n`, "utf8");
  await appendEvent(eventsFile, request.taskId, { type: "status", value: "mock-started" });

  if (lastMessage.startsWith("/tool list_tasks")) {
    const result = await requestTool(ipcDir, request.taskId, {
      name: "list_tasks",
      args: { groupId: request.group.id }
    });
    await appendEvent(eventsFile, request.taskId, { type: "tool_result", name: "list_tasks", payload: result });
    await appendEvent(eventsFile, request.taskId, { type: "message", text: JSON.stringify(result) });
  } else if (lastMessage.startsWith("/tool capabilities")) {
    const skillsPath = process.env.NANOCLAW_CONTAINER_SKILLS_PATH ?? "";
    await appendEvent(eventsFile, request.taskId, {
      type: "message",
      text: JSON.stringify({
        executionMode: "container",
        scheduleTypes: ["once", "interval", "cron"],
        skillsPath,
        toolNames: ["schedule_task", "list_tasks", "get_task", "pause_task", "resume_task", "cancel_task", "send_message"]
      })
    });
  } else if (lastMessage.startsWith("/tool status")) {
    const skillsPath = process.env.NANOCLAW_CONTAINER_SKILLS_PATH ?? "";
    const hasSkills = skillsPath
      ? await fs
          .access(skillsPath)
          .then(() => true)
          .catch(() => false)
      : false;
    await appendEvent(eventsFile, request.taskId, {
      type: "message",
      text: JSON.stringify({
        ok: true,
        skillsPath,
        containerSkillsPresent: hasSkills
      })
    });
  } else {
    await appendEvent(eventsFile, request.taskId, {
      type: "message",
      text: `mock-container:${lastMessage}`
    });
  }

  await appendEvent(eventsFile, request.taskId, { type: "done" });
}

function buildOpenAIEndpoint(request: RunnerTaskRequest): string {
  const baseUrl =
    request.provider === "openai-codex"
      ? process.env.NANOCLAW_OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex"
      : process.env.NANOCLAW_OPENAI_API_BASE_URL ?? "https://api.openai.com/v1";
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function buildAuthHeaders(request: RunnerTaskRequest, credential: ProviderCredential): Headers {
  const headers = new Headers({
    "Content-Type": "application/json"
  });

  if (credential.type === "api-key") {
    headers.set("Authorization", `Bearer ${credential.apiKey}`);
    return headers;
  }

  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  if (credential.accountId && request.provider === "openai-codex") {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  }
  return headers;
}

function buildInput(request: RunnerTaskRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => ({
    role: message.role,
    content: [{ type: "input_text", text: message.content }]
  }));
}

function extractResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          texts.push((part as { text: string }).text);
        }
      }
    }

    if (texts.length > 0) {
      return texts.join("\n").trim();
    }
  }

  return "";
}

async function runProviderRequest(request: RunnerTaskRequest, eventsFile: string): Promise<void> {
  if (!request.auth) {
    throw new Error(`Missing auth for ${request.provider}`);
  }

  const endpoint = buildOpenAIEndpoint(request);
  const headers = buildAuthHeaders(request, request.auth);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: request.modelId,
      input: buildInput(request),
      stream: false
    })
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const errorText =
      typeof payload.error === "string"
        ? payload.error
        : typeof (payload.error as { message?: unknown } | undefined)?.message === "string"
          ? String((payload.error as { message: string }).message)
          : `Provider request failed with ${response.status}`;
    throw new Error(errorText);
  }

  const text = extractResponseText(payload);
  if (text) {
    await appendEvent(eventsFile, request.taskId, { type: "message", text });
  }

  const usage = payload.usage as Record<string, unknown> | undefined;
  await appendEvent(eventsFile, request.taskId, {
    type: "done",
    usage: {
      provider: request.provider,
      modelId: request.modelId,
      finishReason: typeof payload.status === "string" ? payload.status : "completed",
      tokenUsage: usage
        ? {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined
          }
        : undefined
    }
  });
}

async function createIsolatedCodexHome(
  request: RunnerTaskRequest,
  eventsFile: string
): Promise<{ codexHomePath: string; cleanup: () => Promise<void> }> {
  const codexHomePath = path.join(path.dirname(eventsFile), "codex-home");
  await fs.mkdir(codexHomePath, { recursive: true });

  if (!request.auth || request.auth.type !== "oauth") {
    throw new Error("Missing OAuth credential for openai-codex");
  }

  await fs.writeFile(
    path.join(codexHomePath, "auth.json"),
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: request.auth.idToken ?? request.auth.accessToken,
          access_token: request.auth.accessToken,
          refresh_token: request.auth.refreshToken,
          ...(request.auth.accountId ? { account_id: request.auth.accountId } : {})
        },
        last_refresh: new Date().toISOString()
      },
      null,
      2
    )
  );

  return {
    codexHomePath,
    cleanup: async () => {
      await fs.rm(codexHomePath, { recursive: true, force: true });
    }
  };
}

async function runCodex(request: RunnerTaskRequest, eventsFile: string): Promise<void> {
  if (request.provider === "openai" && request.auth) {
    await runProviderRequest(request, eventsFile);
    return;
  }

  const outputPath = path.join(path.dirname(eventsFile), "codex-last-message.txt");
  const sessionStatePath = path.join(request.sessionsPath, `${request.sessionId}.json`);
  const prompt = request.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");
  const isolatedHome = await createIsolatedCodexHome(request, eventsFile);
  try {
    const child = spawn(
      request.codexBinaryPath,
      [
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--model",
        request.modelId,
        "-C",
        request.workingDirectory,
        "-o",
        outputPath,
        prompt
      ],
      {
        cwd: request.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_HOME: isolatedHome.codexHomePath,
          HOME: isolatedHome.codexHomePath
        }
      }
    );

    await appendEvent(eventsFile, request.taskId, { type: "status", value: "codex-started" });
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const agentMessages: string[] = [];
    let stdoutBuffer = "";
    let externalSessionId: string | undefined;
    let tokenUsage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        }
      | undefined;
    let timedOut = false;
    const stdoutEnded = waitForReadableToFinish(child.stdout);
    const stderrEnded = waitForReadableToFinish(child.stderr);
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const parsed = parseCodexEventLine(line);
        if (!parsed) {
          continue;
        }

        if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
          externalSessionId = parsed.thread_id;
        }

        const message = collectAgentMessage(parsed);
        if (message) {
          agentMessages.push(message);
        }

        if (parsed.type === "turn.completed") {
          const usage = parsed.usage;
          if (usage && typeof usage === "object") {
            const typedUsage = usage as Record<string, unknown>;
            tokenUsage = {
              inputTokens:
                typeof typedUsage.input_tokens === "number" ? typedUsage.input_tokens : undefined,
              outputTokens:
                typeof typedUsage.output_tokens === "number" ? typedUsage.output_tokens : undefined,
              totalTokens:
                typeof typedUsage.total_tokens === "number" ? typedUsage.total_tokens : undefined
            };
          }
        }
      }
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.runtimeTimeoutMs);

    const exitCode = await waitForChildClose(child);
    clearTimeout(timeout);
    await Promise.all([stdoutEnded, stderrEnded]);

    const trailingLine = stdoutBuffer.trim();
    if (trailingLine) {
      const parsed = parseCodexEventLine(trailingLine);
      if (parsed) {
        if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
          externalSessionId = parsed.thread_id;
        }
        const message = collectAgentMessage(parsed);
        if (message) {
          agentMessages.push(message);
        }
        if (parsed.type === "turn.completed") {
          const usage = parsed.usage;
          if (usage && typeof usage === "object") {
            const typedUsage = usage as Record<string, unknown>;
            tokenUsage = {
              inputTokens:
                typeof typedUsage.input_tokens === "number" ? typedUsage.input_tokens : undefined,
              outputTokens:
                typeof typedUsage.output_tokens === "number" ? typedUsage.output_tokens : undefined,
              totalTokens:
                typeof typedUsage.total_tokens === "number" ? typedUsage.total_tokens : undefined
            };
          }
        }
      }
    }

    await fs.mkdir(request.sessionsPath, { recursive: true });
    await fs.writeFile(
      sessionStatePath,
      JSON.stringify(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          externalSessionId,
          exitCode,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    const fallbackOutput = await fs.readFile(outputPath, "utf8").catch(() => "");
    const output = (agentMessages.join("\n").trim() || fallbackOutput.trim());
    if (output) {
      await appendEvent(eventsFile, request.taskId, { type: "message", text: output });
    }

    if (timedOut) {
      await appendEvent(eventsFile, request.taskId, { type: "error", error: "codex execution timed out" });
    } else if (exitCode !== 0 && stderrChunks.length > 0) {
      await appendEvent(eventsFile, request.taskId, { type: "error", error: stderrChunks.join("").trim() });
    } else if (exitCode !== 0 && stdoutChunks.length > 0) {
      await appendEvent(eventsFile, request.taskId, { type: "error", error: stdoutChunks.join("").trim() });
    }

    await appendEvent(eventsFile, request.taskId, {
      type: "done",
      usage: {
        provider: request.provider,
        modelId: request.modelId,
        exitCode,
        finishReason: exitCode === 0 ? "completed" : "failed",
        tokenUsage
      }
    });
  } finally {
    await isolatedHome.cleanup();
  }
}

async function main(): Promise<void> {
  const requestPath = getArg("--request");
  const ipcDir = getArg("--ipc-dir");
  if (!requestPath || !ipcDir) {
    throw new Error("Both --request and --ipc-dir are required");
  }

  const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as RunnerTaskRequest;
  const eventsFile = path.join(ipcDir, "events.jsonl");
  const doneFile = path.join(ipcDir, "done.json");

  await fs.mkdir(path.dirname(eventsFile), { recursive: true });
  if (request.mode === "mock" || process.env.NANOCLAW_AGENT_RUNNER_MODE === "mock") {
    await runMock(request, ipcDir, eventsFile);
  } else {
    await runCodex(request, eventsFile);
  }

  await fs.writeFile(doneFile, JSON.stringify({ ok: true }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
