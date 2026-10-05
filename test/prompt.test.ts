import { describe, expect, it } from "vitest";
import type { ContextMessage } from "../src/pipeline/context.js";
import { buildPrompt, type PromptInput } from "../src/pipeline/prompt.js";
import type { RetrievedMessage } from "../src/retrieval/search.js";
import { TEAM_URL, tsDaysAgo } from "./fakes.js";

const msg = (ts: string, text: string, extra: Partial<ContextMessage> = {}): ContextMessage => ({
  channelId: "C1",
  ts,
  threadTs: null,
  userName: "Ana",
  text,
  isGhost: false,
  ...extra,
});

const hit = (ts: string, text: string, score: number): RetrievedMessage => ({
  channelId: "C2",
  channelName: "pricing",
  ts,
  threadTs: null,
  userName: "Bo",
  text,
  score,
});

const base = (overrides: Partial<PromptInput> = {}): PromptInput => ({
  question: "what did we decide?",
  askerName: "Kevin",
  channelName: "general",
  isThread: true,
  thread: [],
  recent: [],
  retrieved: [],
  teamUrl: TEAM_URL,
  budget: 24000,
  now: new Date("2026-10-05T12:00:00Z"),
  ...overrides,
});

describe("buildPrompt", () => {
  it("gives every included Slack message an ID that maps to its permalink", () => {
    const root = tsDaysAgo(1);
    const built = buildPrompt(
      base({
        thread: [msg(root, "root"), msg(tsDaysAgo(1, 1), "reply", { threadTs: root })],
        retrieved: [hit(tsDaysAgo(40), "annual plan decided", 0.9)],
      }),
    );
    expect(built.sources.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    for (const source of built.sources) expect(built.prompt).toContain(`[${source.id}]`);
    expect(built.sources[1]!.url).toContain(`?thread_ts=${root}&cid=C1`);
    expect(built.sources[2]!.label).toMatch(/^#pricing · Bo · \d{4}-\d{2}-\d{2}$/);
    expect(built.prompt).toContain("Today is 2026-10-05.");
    expect(built.prompt).toContain('<question asker="Kevin" channel="#general">');
  });

  it("keeps Ghost's own long reply whole in a channel chat, so it knows what it said", () => {
    const longReply = `${"Point. ".repeat(400)}Move the required AI-use question into the call.`;
    const built = buildPrompt(
      base({
        isThread: false,
        recent: [msg(tsDaysAgo(0.01), "how do I improve my landing page?"), msg(tsDaysAgo(0.005), longReply, { isGhost: true })],
        question: "wdym by required ai use question",
      }),
    );
    expect(built.prompt).toContain("Move the required AI-use question into the call.");
  });

  it("never gives Ghost's own messages a source ID", () => {
    const built = buildPrompt(base({ thread: [msg(tsDaysAgo(1), "q"), msg(tsDaysAgo(1, 1), "my answer", { isGhost: true })] }));
    expect(built.sources).toHaveLength(1);
    expect(built.prompt).toContain("(Ghost)");
  });

  it("says so when no history was found", () => {
    expect(buildPrompt(base()).prompt).toContain("No related messages found");
  });

  it("stays within the budget and assigns IDs only to the messages it keeps", () => {
    const big = "x".repeat(1400);
    const thread = Array.from({ length: 40 }, (_, i) => msg(tsDaysAgo(1, i), `${i} ${big}`));
    const retrieved = Array.from({ length: 30 }, (_, i) => hit(tsDaysAgo(50, i), `${i} ${big}`, i / 30));
    const built = buildPrompt(base({ thread, retrieved, budget: 12000 }));
    expect(built.prompt.length).toBeLessThan(12000 + 4000); // budget + fixed framing
    expect(built.prompt).toContain("earlier replies omitted");
    expect(built.prompt).toContain("0 xxx"); // the thread root survives
    const ids = [...built.prompt.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(built.sources.map((s) => s.id)));
  });

  it("prefers the highest-scoring history when the budget is tight", () => {
    // Each hit costs about 1,620 characters, so a 2,500-character budget holds only one.
    const retrieved = [hit(tsDaysAgo(10), "low ".repeat(400), 0.1), hit(tsDaysAgo(20), "high ".repeat(400), 0.9)];
    const built = buildPrompt(base({ retrieved, budget: 2500 }));
    expect(built.prompt).toContain("high high");
    expect(built.prompt).not.toContain("low low");
  });
});
