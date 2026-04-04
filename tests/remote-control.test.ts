import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  DATA_DIR: "/tmp/nanoclaw-rc-test"
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}));

import {
  _getStateFilePath,
  _resetForTesting,
  getActiveSession,
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl
} from "../src/remote-control.js";

function createMockProcess(pid = 12345) {
  return {
    pid,
    unref: vi.fn(),
    kill: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() }
  };
}

describe("remote control", () => {
  const stateFile = _getStateFilePath();
  let readFileSyncSpy: any;
  let writeFileSyncSpy: any;
  let unlinkSyncSpy: any;
  let mkdirSyncSpy: any;
  let openSyncSpy: any;
  let closeSyncSpy: any;
  let stdoutFileContent = "";

  beforeEach(() => {
    _resetForTesting();
    spawnMock.mockReset();
    stdoutFileContent = "";

    mkdirSyncSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    writeFileSyncSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    unlinkSyncSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
    openSyncSpy = vi.spyOn(fs, "openSync").mockReturnValue(42 as never);
    closeSyncSpy = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);

    readFileSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: any) => {
      const normalized = String(filePath);
      if (normalized.endsWith("remote-control.stdout")) return stdoutFileContent;
      if (normalized.endsWith("remote-control.json")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return "";
    }) as any);
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  it("spawns remote control and returns the URL", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    stdoutFileContent = "Session URL: https://claude.ai/code?bridge=env_abc123\n";
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    const result = await startRemoteControl("user1", "tg:123", "/project");

    expect(result).toEqual({
      ok: true,
      url: "https://claude.ai/code?bridge=env_abc123"
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["remote-control", "--name", "NanoClaw Remote"],
      expect.objectContaining({ cwd: "/project", detached: true })
    );
    expect(proc.unref).toHaveBeenCalled();
    expect(openSyncSpy).toHaveBeenCalledTimes(2);
    expect(closeSyncSpy).toHaveBeenCalledTimes(2);
    expect(writeFileSyncSpy).toHaveBeenCalledWith(stateFile, expect.stringContaining("\"pid\":12345"));
  });

  it("returns existing URL if session is already active", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    stdoutFileContent = "https://claude.ai/code?bridge=env_existing\n";
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    await startRemoteControl("user1", "tg:123", "/project");
    const result = await startRemoteControl("user2", "tg:456", "/project");

    expect(result).toEqual({
      ok: true,
      url: "https://claude.ai/code?bridge=env_existing"
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("times out if no URL appears", async () => {
    vi.useFakeTimers();
    const proc = createMockProcess(44444);
    spawnMock.mockReturnValue(proc);
    stdoutFileContent = "no url here";
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    const promise = startRemoteControl("user1", "tg:123", "/project");
    for (let i = 0; i < 160; i += 1) {
      await vi.advanceTimersByTimeAsync(200);
    }

    await expect(promise).resolves.toEqual({
      ok: false,
      error: "Timed out waiting for Remote Control URL"
    });
    vi.useRealTimers();
  });

  it("restores an active session from state", () => {
    readFileSyncSpy.mockImplementationOnce(
      ((_: any) =>
        JSON.stringify({
          pid: 99999,
          url: "https://claude.ai/code?bridge=env_restore",
          startedBy: "user",
          startedInChat: "chat",
          startedAt: new Date().toISOString()
        })) as any
    );
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    restoreRemoteControl();
    expect(getActiveSession()?.url).toBe("https://claude.ai/code?bridge=env_restore");
  });

  it("stops the active session and clears state", async () => {
    const proc = createMockProcess(55555);
    spawnMock.mockReturnValue(proc);
    stdoutFileContent = "https://claude.ai/code?bridge=env_stop\n";
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    await startRemoteControl("user1", "tg:123", "/project");
    expect(stopRemoteControl()).toEqual({ ok: true });
    expect(unlinkSyncSpy).toHaveBeenCalled();
    expect(getActiveSession()).toBeNull();
  });

  it("returns an error if no session is active", () => {
    expect(stopRemoteControl()).toEqual({
      ok: false,
      error: "No active Remote Control session"
    });
  });
});
