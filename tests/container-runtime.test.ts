import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args)
}));

import {
  CONTAINER_RUNTIME_BIN,
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  readonlyMountArgs,
  stopContainer
} from "../src/container-runtime.js";
import { logger } from "../src/logger.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("container runtime", () => {
  it("builds readonly mount args", () => {
    expect(readonlyMountArgs("/host/path", "/container/path")).toEqual([
      "-v",
      "/host/path:/container/path:ro"
    ]);
  });

  it("stops a valid container by name", () => {
    stopContainer("nanoclaw-test-123");
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: "pipe" }
    );
  });

  it("rejects invalid container names", () => {
    expect(() => stopContainer("foo; rm -rf /")).toThrow("Invalid container name");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("checks that the container runtime is running", () => {
    mockExecSync.mockReturnValueOnce("");
    ensureContainerRuntimeRunning();
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: "pipe",
      timeout: 10_000
    });
    expect(logger.debug).toHaveBeenCalled();
  });

  it("throws when the container runtime is unavailable", () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("docker not reachable");
    });
    expect(() => ensureContainerRuntimeRunning()).toThrow(
      "Container runtime is required but failed to start"
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("cleans up orphaned containers", () => {
    mockExecSync.mockReturnValueOnce("nanoclaw-group1-111\nnanoclaw-group2-222\n");
    mockExecSync.mockReturnValue("");

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`,
      { stdio: "pipe" }
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`,
      { stdio: "pipe" }
    );
    expect(logger.info).toHaveBeenCalled();
  });
});
