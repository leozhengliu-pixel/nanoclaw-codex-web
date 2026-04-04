import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage
} from "../src/sender-allowlist.js";
import { createTempDir } from "./test-utils.js";

describe("sender allowlist", () => {
  it("returns default config when file is missing", async () => {
    const root = await createTempDir("nanoclaw-sender-allowlist-");
    const config = loadSenderAllowlist(`${root}/missing.json`);

    expect(config.default).toEqual({ allow: "*", mode: "trigger" });
    expect(config.chats).toEqual({});
    expect(config.logDenied).toBe(true);
  });

  it("loads valid per-chat rules", async () => {
    const root = await createTempDir("nanoclaw-sender-allowlist-");
    const file = `${root}/allowlist.json`;
    await fs.writeFile(
      file,
      JSON.stringify({
        default: { allow: ["u1"], mode: "trigger" },
        chats: {
          "chat:1": { allow: ["u2", "u3"], mode: "drop" }
        },
        logDenied: false
      })
    );

    const config = loadSenderAllowlist(file);
    expect(isSenderAllowed("chat:1", "u2", config)).toBe(true);
    expect(isSenderAllowed("chat:1", "u1", config)).toBe(false);
    expect(shouldDropMessage("chat:1", config)).toBe(true);
    expect(isTriggerAllowed("chat:2", "u1", config)).toBe(true);
    expect(isTriggerAllowed("chat:2", "u9", config)).toBe(false);
  });
});
