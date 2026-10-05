import { describe, expect, it } from "vitest";
import { Ghost, HELP_TEXT, type GhostDeps } from "../src/pipeline/ghost.js";
import { Scheduler } from "../src/schedule/scheduler.js";
import { FtsRetriever } from "../src/retrieval/search.js";
import { UserDirectory } from "../src/slack/users.js";
import { Syncer } from "../src/store/sync.js";
import { Limiter } from "../src/util/limiter.js";
import type { ModelBackend } from "../src/backend/types.js";
import { BOT_ID, BOT_USER, FakeBackend, FakeSlack, memoryStore, TEAM_URL, tempProfiles, tsDaysAgo } from "./fakes.js";

async function workspace(backend: ModelBackend) {
  const slack = new FakeSlack();
  slack.addUser("U1", "Ana");
  slack.addUser("U2", "Bo");
  slack.addUser("UK", "Kevin");
  slack.addChannel("CGEN", "general");
  slack.addChannel("CPRICE", "pricing");
  slack.addChannel("CFOUND", "founders");

  slack.say("CPRICE", { ts: tsDaysAgo(120), user: "U1", text: "Decision: pricing is $30 per seat, billed monthly." });
  slack.say("CPRICE", { ts: tsDaysAgo(10), user: "U2", text: "Update: we changed pricing to $49 per seat, billed annually." });
  slack.say("CFOUND", { ts: tsDaysAgo(5), user: "U1", text: "Secret pricing discount for Acme is 40 percent." });
  slack.say("CGEN", { ts: tsDaysAgo(0.01), user: "U2", text: "Morning all" });

  const store = memoryStore();
  const users = new UserDirectory(slack, store);
  const identity = { botUserId: BOT_USER, botId: BOT_ID, teamUrl: TEAM_URL };
  await new Syncer(slack, store, users, identity, { backfillDays: 365 }).syncAll();

  const deps: GhostDeps = {
    api: slack,
    store,
    users,
    retriever: new FtsRetriever(store),
    backend,
    limiter: new Limiter(2),
    identity,
    contextChars: 24000,
    modelTimeoutMs: 1000,
    profiles: tempProfiles(),
  };
  const ghost = new Ghost(deps);
  ghost.attachScheduler(new Scheduler(store.db, slack, async () => "done"));
  return { slack, store, ghost, profiles: deps.profiles };
}

describe("Ghost.handleMention", () => {
  it("answers once in the thread with a cited answer, and shows a working reaction meanwhile", async () => {
    const backend = new FakeBackend((request) => {
      const newest = [...request.prompt.matchAll(/\[(S\d+)\][^\n]*\$49/g)][0]![1];
      const oldest = [...request.prompt.matchAll(/\[(S\d+)\][^\n]*\$30/g)][0]![1];
      return `We moved to $49 per seat, billed annually [${newest}]. Before that it was $30 monthly [${oldest}].`;
    });
    const { slack, ghost } = await workspace(backend);
    const ts = tsDaysAgo(0);
    slack.say("CGEN", { ts, user: "UK", text: `<@${BOT_USER}> what did we decide about pricing?` });

    await ghost.handleMention({ channel: "CGEN", ts, user: "UK", text: `<@${BOT_USER}> what did we decide about pricing?` });

    expect(slack.reactions).toEqual([
      { op: "add", channel: "CGEN", ts, name: "eyes" },
      { op: "remove", channel: "CGEN", ts, name: "eyes" },
    ]);
    const prompt = backend.requests[0]!.prompt;
    expect(prompt).toContain("<related_slack_history>");
    expect(prompt).toContain("#pricing");
    expect(prompt).toContain("Morning all"); // recent channel context
    expect(prompt).toContain('asker="Kevin"');
    expect(prompt).toContain("Secret pricing discount"); // every channel Ghost is in counts

    expect(slack.posts).toHaveLength(1);
    const reply = slack.posts[0]!;
    expect(reply).toMatchObject({ channel: "CGEN", threadTs: ts });
    expect(reply.text).toContain(`<${TEAM_URL}archives/CPRICE/p${tsDaysAgo(10).replace(".", "")}|[1]>`);
    expect(reply.text).toContain("*Sources*\n1. <");
    expect(reply.text).toMatch(/2\. <[^|]+\|#pricing · Ana · \d{4}-\d{2}-\d{2}>/);
  });

  it("includes the current thread when asked inside a thread", async () => {
    const backend = new FakeBackend("Summary.");
    const { slack, ghost } = await workspace(backend);
    const root = tsDaysAgo(0.5);
    slack.say("CGEN", { ts: root, user: "U1", text: "Should onboarding use a checklist?" });
    slack.say("CGEN", { ts: tsDaysAgo(0.5, 1), user: "U2", text: "Yes, five steps max.", thread_ts: root });
    slack.say("CGEN", { ts: tsDaysAgo(0.5, 2), user: BOT_USER, bot_id: BOT_ID, text: "Earlier Ghost reply", thread_ts: root });
    const ts = tsDaysAgo(0.5, 3);
    slack.say("CGEN", { ts, user: "UK", text: `<@${BOT_USER}> summarize this thread`, thread_ts: root });

    await ghost.handleMention({ channel: "CGEN", ts, thread_ts: root, user: "UK", text: `<@${BOT_USER}> summarize this thread` });

    const prompt = backend.requests[0]!.prompt;
    expect(prompt).toMatch(/<current_thread channel="#general">[\s\S]*checklist[\s\S]*five steps max[\s\S]*\(Ghost\)/);
    expect(prompt.match(/summarize this thread/g)).toHaveLength(1); // only in the question section
    expect(slack.posts[0]!.threadTs).toBe(root);
  });

  it("handles each event once", async () => {
    const backend = new FakeBackend("ok");
    const { slack, ghost } = await workspace(backend);
    const event = { channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: `<@${BOT_USER}> hi there` };
    await Promise.all([ghost.handleMention(event), ghost.handleMention(event)]);
    expect(backend.requests).toHaveLength(1);
    expect(slack.posts).toHaveLength(1);
  });

  it("replies with help for an empty mention", async () => {
    const backend = new FakeBackend("ok");
    const { slack, ghost } = await workspace(backend);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: `<@${BOT_USER}>` });
    expect(slack.posts[0]!.text).toBe(HELP_TEXT);
    expect(backend.requests).toHaveLength(0);
  });

  it("posts an apology when the backend fails", async () => {
    const failing: ModelBackend = {
      name: "failing",
      complete: async () => {
        throw new Error("401 OAuth access token is invalid");
      },
      check: async () => "x",
    };
    const { slack, ghost } = await workspace(failing);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: `<@${BOT_USER}> pricing?` });
    expect(slack.posts[0]!.text).toContain("couldn't answer");
    expect(slack.posts[0]!.text).not.toContain("OAuth"); // internal errors stay in the log
  });

  it("strips pings that the model tries to emit", async () => {
    const backend = new FakeBackend("<!channel> look at <@U1>");
    const { slack, ghost } = await workspace(backend);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: `<@${BOT_USER}> ping test` });
    expect(slack.posts[0]!.text).not.toMatch(/<[!@]/);
  });

  it("cleans Slack markup in the question before search and prompting", async () => {
    const backend = new FakeBackend("ok");
    const { ghost } = await workspace(backend);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: `<@${BOT_USER}> what did <@U1> say about pricing &amp; churn?` });
    const prompt = backend.requests[0]!.prompt;
    expect(prompt).toContain("what did @Ana say about pricing & churn?");
    expect(prompt).not.toContain("<@U1>");
  });

  it("home channel: answers an untagged message in the channel, with earlier chat as context", async () => {
    const backend = new FakeBackend("Sure thing.");
    const { slack, ghost } = await workspace(backend);
    slack.say("CGEN", { ts: tsDaysAgo(0.001), user: BOT_USER, bot_id: BOT_ID, text: "Earlier Ghost chat reply" });
    const ts = tsDaysAgo(0);
    await ghost.handleMention({ channel: "CGEN", ts, user: "UK", text: "what should I prep for tomorrow?" }, "channel");
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({ channel: "CGEN", threadTs: undefined, text: "Sure thing." });
    expect(backend.requests[0]!.prompt).toContain("(Ghost)");
  });

  it("home channel: replies inside the thread when the message is in a thread", async () => {
    const backend = new FakeBackend("ok");
    const { slack, ghost } = await workspace(backend);
    const root = tsDaysAgo(0.01);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), thread_ts: root, user: "UK", text: "and then?" }, "channel");
    expect(slack.posts[0]!.threadTs).toBe(root);
  });

  it("applies directives: saves the memory, queues the reminder in Slack, and posts clean text", async () => {
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const backend = new FakeBackend(
      `Done, I'll remind you tomorrow.\n<<remember: prefers short answers>>\n<<schedule: {"kind":"reminder","text":"Email the principal","at":"${at}"}>>`,
    );
    const { slack, ghost, profiles } = await workspace(backend);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: "remind me tomorrow to email the principal" }, "channel");
    expect(slack.posts[0]!.text).toBe("Done, I'll remind you tomorrow.");
    expect(profiles.read("UK")).toContain("prefers short answers");
    expect(slack.scheduled[0]).toMatchObject({ channel: "CGEN", text: "⏰ <@UK> Email the principal" });

    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0, 1), user: "UK", text: "what do you know about me?" }, "channel");
    const prompt = backend.requests[1]!.prompt;
    expect(prompt).toContain("<about_asker>");
    expect(prompt).toContain("prefers short answers");
    expect(prompt).toMatch(/<asker_schedules>\n#1 reminder: "Email the principal"/);
    expect(prompt).toMatch(/<asker_time timezone="America\/New_York">/);
  });

  it("opens a needed login without asking, posts the sign-in link, then answers again", async () => {
    let call = 0;
    const backend = new FakeBackend(() =>
      ++call === 1 ? "Opening the granola sign-in now.\n<<connect: granola>>" : "Your last meeting was the Lin pilot sync.",
    );
    const { slack, ghost } = await workspace(backend);
    const logins: string[] = [];
    let loggedIn: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (loggedIn = resolve));
    (ghost as unknown as { deps: GhostDeps }).deps.connections = {
      servers: [],
      needsLogin: ["granola"],
      refresh: async () => undefined,
      login: async (name: string, onUrl?: (url: string) => void, onSignedIn?: () => void) => {
        logins.push(name);
        onUrl?.("https://granola.test/oauth?state=abc");
        onSignedIn?.();
        setTimeout(loggedIn, 0);
        return true;
      },
    } as unknown as GhostDeps["connections"];

    const ts = tsDaysAgo(0);
    await ghost.handleMention({ channel: "CGEN", ts, user: "UK", text: "what was my last granola meeting?" }, "channel");
    await done;
    await new Promise((r) => setTimeout(r, 10));

    expect(logins).toEqual(["granola"]);
    expect(slack.posts.map((p) => p.text)).toEqual([
      "Opening the granola sign-in now.",
      "🔑 <https://granola.test/oauth?state=abc|Sign in to Granola>. The page should also be open in your browser on your Mac.",
      "✅ Granola is connected. Checking on that now…",
      "Your last meeting was the Lin pilot sync.",
    ]);
    expect(backend.requests[0]!.prompt).toContain("Needs login: granola");
  });

  it("shows a live status line while working and deletes it after the answer", async () => {
    const backend = new FakeBackend((request) => {
      request.onProgress?.({ kind: "web" });
      request.onProgress?.({ kind: "web" }); // same step: no extra update
      request.onProgress?.({ kind: "connection", name: "granola" });
      return "Done.";
    });
    const { slack, ghost } = await workspace(backend);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: "what happened in my last meeting?" }, "channel");
    expect(slack.posts.map((p) => p.text)).toEqual(["🔎 Searching the web…", "Done."]);
    expect(slack.updates.map((u) => u.text)).toEqual(["📎 Checking Granola…"]);
    expect(slack.deleted).toEqual([slack.posts[0]!.ts]);
  });

  it("scheduled task runs strip directives but do not apply them", async () => {
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const backend = new FakeBackend(`Summary.\n<<schedule: {"kind":"task","text":"again","at":"${at}"}>>\n<<remember: x y z>>`);
    const { slack, ghost, profiles } = await workspace(backend);
    const answer = await ghost.answer({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: "Summarize" }, "Summarize", { applyDirectives: false });
    expect(answer.text).toBe("Summary.");
    expect(slack.scheduled).toHaveLength(0);
    expect(profiles.read("UK") ?? "").not.toContain("x y z");
  });

  it("home channel: ignores empty messages instead of posting help", async () => {
    const backend = new FakeBackend("ok");
    const { slack, ghost } = await workspace(backend);
    await ghost.handleMention({ channel: "CGEN", ts: tsDaysAgo(0), user: "UK", text: "" }, "channel");
    expect(slack.posts).toHaveLength(0);
  });
});
