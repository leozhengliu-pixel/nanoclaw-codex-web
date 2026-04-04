/**
 * Mount Security Module for NanoClaw
 *
 * Validates additional mounts against an allowlist stored OUTSIDE the project root.
 * This prevents container agents from modifying security configuration.
 *
 * Allowlist location: ~/.config/nanoclaw/mount-allowlist.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MOUNT_ALLOWLIST_PATH } from "./config.js";
import { logger } from "./logger.js";
import { AdditionalMount, AllowedRoot, MountAllowlist } from "./types.js";

let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

const DEFAULT_BLOCKED_PATTERNS = [
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  "credentials",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "private_key",
  ".secret"
];

export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }

  if (allowlistLoadError !== null) {
    return null;
  }

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        "Mount allowlist not found - additional mounts will be BLOCKED. Create the file to enable additional mounts."
      );
      return null;
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, "utf-8");
    const allowlist = JSON.parse(content) as MountAllowlist;

    if (!Array.isArray(allowlist.allowedRoots)) {
      throw new Error("allowedRoots must be an array");
    }
    if (!Array.isArray(allowlist.blockedPatterns)) {
      throw new Error("blockedPatterns must be an array");
    }
    if (typeof allowlist.nonMainReadOnly !== "boolean") {
      throw new Error("nonMainReadOnly must be a boolean");
    }

    allowlist.blockedPatterns = [...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns])];
    cachedAllowlist = allowlist;
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length
      },
      "Mount allowlist loaded successfully"
    );
    return cachedAllowlist;
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      { path: MOUNT_ALLOWLIST_PATH, error: allowlistLoadError },
      "Failed to load mount allowlist - additional mounts will be BLOCKED"
    );
    return null;
  }
}

function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith("~/")) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === "~") {
    return homeDir;
  }
  return path.resolve(p);
}

function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function matchesBlockedPattern(realPath: string, blockedPatterns: string[]): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

function findAllowedRoot(realPath: string, allowedRoots: AllowedRoot[]): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);
    if (realRoot === null) {
      continue;
    }

    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return root;
    }
  }

  return null;
}

function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes("..")) return false;
  if (containerPath.startsWith("/")) return false;
  if (!containerPath || containerPath.trim() === "") return false;
  if (containerPath.includes(":")) return false;
  return true;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

export function validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult {
  const allowlist = loadMountAllowlist();
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`
    };
  }

  const containerPath = mount.containerPath || path.basename(mount.hostPath);
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."`
    };
  }

  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);
  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: ${mount.hostPath}`
    };
  }

  const blockedPattern = matchesBlockedPattern(realPath, allowlist.blockedPatterns);
  if (blockedPattern) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern: ${blockedPattern}`
    };
  }

  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path is not under an allowed root: ${mount.hostPath}`
    };
  }

  const requestedReadonly = mount.readonly !== false;
  const effectiveReadonly = !isMain && allowlist.nonMainReadOnly ? true : requestedReadonly;
  if (!effectiveReadonly && !allowedRoot.allowReadWrite) {
    return {
      allowed: false,
      reason: `Read-write mounts are not allowed under root: ${allowedRoot.path}`
    };
  }

  return {
    allowed: true,
    reason: "Mount allowed",
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly
  };
}

export function validateMounts(mounts: AdditionalMount[], isMain: boolean): MountValidationResult[] {
  return mounts.map((mount) => validateMount(mount, isMain));
}
