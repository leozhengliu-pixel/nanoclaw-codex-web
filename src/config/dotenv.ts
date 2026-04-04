import fs from "node:fs";
import path from "node:path";

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function loadDotEnvFile(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const envFilePath = path.join(cwd, ".env");
  if (!fs.existsSync(envFilePath)) {
    return env;
  }

  const file = fs.readFileSync(envFilePath, "utf8");
  const merged: NodeJS.ProcessEnv = { ...env };

  for (const line of file.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || merged[key] !== undefined) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    merged[key] = stripWrappingQuotes(rawValue);
  }

  return merged;
}
