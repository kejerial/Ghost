import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" };

describe("loadConfig", () => {
  it("applies defaults and treats blank values as unset", () => {
    const config = loadConfig({ ...base, GHOST_MODEL: "" });
    expect(config.backend).toBe("claude");
    expect(config.model).toBeUndefined();
    expect(config.modelTimeoutMs).toBe(180_000);
  });

  it("rejects tokens of the wrong type", () => {
    expect(() => loadConfig({ ...base, SLACK_BOT_TOKEN: "xoxp-1" })).toThrow(/bot token/);
  });
});
