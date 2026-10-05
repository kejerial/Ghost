/**
 * Live smoke test: real model CLI, fake Slack. Skipped unless GHOST_SMOKE=1.
 *   GHOST_SMOKE_BACKEND=claude|codex npm run test:smoke
 * It uses the subscription of the logged-in CLI.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBackend } from "../src/backend/index.js";
import { Ghost } from "../src/pipeline/ghost.js";
import { FtsRetriever } from "../src/retrieval/search.js";
import { UserDirectory } from "../src/slack/users.js";
import { Syncer } from "../src/store/sync.js";
import { Limiter } from "../src/util/limiter.js";
import { BOT_ID, BOT_USER, FakeSlack, memoryStore, TEAM_URL, tempProfiles, tsDaysAgo } from "./fakes.js";

const enabled = process.env.GHOST_SMOKE === "1";
const backendName = (process.env.GHOST_SMOKE_BACKEND ?? "claude") as "claude" | "codex";

/** Print the answer, and also save it when GHOST_SMOKE_OUT names a file (Vitest can hide console output). */
function report(kind: string, answer: string): void {
  const block = `\n--- ${backendName} answer (${kind}) ---\n${answer}\n`;
  console.log(block);
  if (process.env.GHOST_SMOKE_OUT) appendFileSync(process.env.GHOST_SMOKE_OUT, block);
}

describe.skipIf(!enabled)(`live backend: ${backendName}`, () => {
  async function ghostWith() {
    const slack = new FakeSlack();
    slack.addUser("U1", "Ana");
    slack.addUser("U2", "Bo");
    slack.addUser("UK", "Kevin");
    slack.addChannel("CGEN", "general");
    slack.addChannel("CPRICE", "pricing");
    slack.say("CPRICE", { ts: tsDaysAgo(120), user: "U1", text: "Decision: pricing is $30 per seat, billed monthly." });
    slack.say("CPRICE", { ts: tsDaysAgo(10), user: "U2", text: "Update: we changed pricing to $49 per seat, billed annually, because churn on monthly plans was high." });
    const store = memoryStore();
    const users = new UserDirectory(slack, store);
    const identity = { botUserId: BOT_USER, botId: BOT_ID, teamUrl: TEAM_URL };
    await new Syncer(slack, store, users, identity, { backfillDays: 365 }).syncAll();
    const ghost = new Ghost({
      api: slack,
      store,
      users,
      retriever: new FtsRetriever(store),
      backend: createBackend({ backend: backendName, model: process.env.GHOST_MODEL || undefined, proxyUrl: "", proxyApiKey: undefined }),
      limiter: new Limiter(1),
      identity,
      contextChars: 24000,
      modelTimeoutMs: 240_000,
      profiles: tempProfiles(),
    });
    return { slack, ghost };
  }

  it("answers a Slack-history question with the newest decision and citations", async () => {
    const { slack, ghost } = await ghostWith();
    const ts = tsDaysAgo(0);
    await ghost.handleMention({ channel: "CGEN", ts, user: "UK", text: `<@${BOT_USER}> what did we decide about pricing?` });
    const answer = slack.posts[0]!.text;
    report("history", answer);
    expect(answer).toContain("$49");
    expect(answer).toContain("*Sources*");
    expect(answer).toContain(`${TEAM_URL}archives/CPRICE/p${tsDaysAgo(10).replace(".", "")}`);
  }, 300_000);

  it("answers a general question without inventing Slack sources", async () => {
    const { slack, ghost } = await ghostWith();
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: `<@${BOT_USER}> what's a good way to structure a 30 minute discovery sales call?` });
    const answer = slack.posts[0]!.text;
    report("general", answer);
    expect(answer.length).toBeGreaterThan(100);
    expect(answer).not.toContain("*Sources*");
  }, 300_000);
});
