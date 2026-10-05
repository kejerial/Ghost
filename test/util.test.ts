import { describe, expect, it } from "vitest";
import type { webApi } from "@slack/bolt";
import { slackApiFrom } from "../src/slack/api.js";
import { Limiter } from "../src/util/limiter.js";

describe("Limiter", () => {
  it("never runs more than max tasks, even when new callers arrive as slots free up", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    };
    const runs: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) runs.push(limiter.run(task));
    // New callers join while earlier tasks finish.
    await new Promise((resolve) => setTimeout(resolve, 3));
    for (let i = 0; i < 6; i++) runs.push(limiter.run(task));
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(limiter.pending).toBe(0);
  });

  it("frees the slot when a task throws", async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });
});

describe("slackApiFrom", () => {
  it("posts with unfurls and parsing turned off", async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          sent.push(args);
          return { ts: "1.1" };
        },
      },
    } as unknown as webApi.WebClient;
    await slackApiFrom(client).post("C1", "1.0", "hello @here https://x.test");
    expect(sent[0]).toMatchObject({ unfurl_links: false, unfurl_media: false, parse: "none", link_names: false, thread_ts: "1.0" });
  });
});
