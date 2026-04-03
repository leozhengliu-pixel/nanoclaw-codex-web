import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { loadConfig, type AppConfig } from "../src/config/index.js";
import { ensureDefaultGroupAssets } from "../src/groups/default-groups.js";

function exists(pathname: string): boolean {
  try {
    fs.accessSync(pathname);
    return true;
  } catch {
    return false;
  }
}

function shellEscape(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

function which(binary: string): string | null {
  try {
    const output = execFileSync("bash", ["-lc", `command -v '${shellEscape(binary)}'`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function runEnvironment(config: AppConfig): Record<string, unknown> {
  const containerEngineAvailable = config.containerExecutor === "process" || which(config.containerEngineBinary) !== null;
  const codexAvailable = which(config.codexBinaryPath) !== null;
  return {
    step: "environment",
    ok: containerEngineAvailable || config.containerExecutor === "process",
    platform: process.platform,
    nodeVersion: process.version,
    isWsl: Boolean(process.env.WSL_DISTRO_NAME),
    containerExecutor: config.containerExecutor,
    containerEngineBinary: config.containerEngineBinary,
    containerEngineAvailable,
    codexBinaryPath: config.codexBinaryPath,
    codexAvailable,
    defaultTimezone: config.defaultTimezone
  };
}

function runGroups(config: AppConfig): Record<string, unknown> {
  return {
    step: "groups",
    ok: exists(config.groupsRoot),
    groupsRoot: config.groupsRoot,
    globalMemoryFile: `${config.groupsRoot}/global/CLAUDE.md`,
    mainMemoryFile: `${config.groupsRoot}/main/CLAUDE.md`
  };
}

function runStatus(config: AppConfig): Record<string, unknown> {
  const environment = runEnvironment(config);
  const groups = runGroups(config);
  const codexAuthPath = path.join(config.codexHomePath, "auth.json");
  return {
    step: "status",
    ok: Boolean(environment.ok) && Boolean(groups.ok),
    environment,
    groups,
    containerSkillsPath: config.containerSkillsPath,
    containerSkillsPresent: exists(config.containerSkillsPath),
    sqliteDirectoryPresent: exists(config.dataRoot),
    codexHomePath: config.codexHomePath,
    codexAuthPresent: exists(codexAuthPath)
  };
}

function runVerify(config: AppConfig): Record<string, unknown> {
  const status = runStatus(config);
  return {
    step: "verify",
    ok: Boolean(status.ok),
    checks: status
  };
}

export async function runSetupStep(step: string, config = loadConfig()): Promise<Record<string, unknown>> {
  await ensureDefaultGroupAssets(config.groupsRoot);

  switch (step) {
    case "environment":
      return runEnvironment(config);
    case "groups":
      return runGroups(config);
    case "status":
      return runStatus(config);
    case "verify":
      return runVerify(config);
    default:
      throw new Error(`Unsupported setup step: ${step}`);
  }
}

async function main(): Promise<void> {
  const stepIndex = process.argv.indexOf("--step");
  const step = stepIndex === -1 ? "verify" : process.argv[stepIndex + 1] ?? "verify";
  const result = await runSetupStep(step);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
