import { execSync } from "node:child_process";
import os from "node:os";

import { logger } from "./logger.js";

export const CONTAINER_RUNTIME_BIN = process.env.NANOCLAW_CONTAINER_ENGINE_BINARY || "docker";

export function hostGatewayArgs(): string[] {
  if (os.platform() === "linux") {
    return ["--add-host=host.docker.internal:host-gateway"];
  }
  return [];
}

export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ["-v", `${hostPath}:${containerPath}:ro`];
}

export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: "pipe" });
}

export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: "pipe",
      timeout: 10_000
    });
    logger.debug("Container runtime already running");
  } catch (error) {
    logger.error({ error }, "Failed to reach container runtime");
    throw new Error("Container runtime is required but failed to start", {
      cause: error
    });
  }
}

export function cleanupOrphans(prefix = "nanoclaw-"): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ps --filter name=${prefix} --format '{{.Names}}'`, {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8"
    });
    const orphans = output.trim().split("\n").filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        // ignore already-stopped containers
      }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, "Stopped orphaned containers");
    }
  } catch (error) {
    logger.warn({ error }, "Failed to clean up orphaned containers");
  }
}
