import { describe, expect, it } from "vitest";
import { UserDirectory } from "../src/slack/users.js";
import { Syncer } from "../src/store/sync.js";
import { BOT_ID, BOT_USER, FakeSlack, memoryStore, tsDaysAgo } from "./fakes.js";

function setup(backfillDays = 365) {
  const slack = new FakeSlack();
  slack.addUser("U1", "Ana");
  slack.addUser("U2", "Bo");
  const store = memoryStore();
  const users = new UserDirectory(slack, store);
  const syncer = new Syncer(slack, store, users, { botUserId: BOT_USER, botId: BOT_ID }, { backfillDays });
  return { slack, store, syncer };
}

const texts = (store: ReturnType<typeof memoryStore>) =>
  (store.db.prepare("SELECT clean_text FROM messages ORDER BY ts_num").all() as Array<{ clean_text: string }>).map((r) => r.clean_text);

describe("Syncer", () => {
  it("backfills member channels, threads, and resolved names, and skips noise and Ghost's own posts", async () => {
    const { slack, store, syncer } = setup();
    slack.addChannel("C1", "general");
    slack.addChannel("C2", "secret", { isMember: false });
    const root = tsDaysAgo(3);
    slack.say("C1", { ts: root, user: "U1", text: "Kickoff for <@U2>" });
    slack.say("C1", { ts: tsDaysAgo(3, 1), user: "U2", text: "Thanks!", thread_ts: root });
    slack.say("C1", { ts: tsDaysAgo(2), user: "U2", subtype: "channel_join", text: "<@U2> has joined" });
    slack.say("C1", { ts: tsDaysAgo(1), user: BOT_USER, bot_id: BOT_ID, text: "Ghost answer" });
    slack.say("C1", { ts: tsDaysAgo(500), user: "U1", text: "Too old" });
    slack.say("C2", { ts: tsDaysAgo(1), user: "U1", text: "Not visible" });

    await syncer.syncAll();

    expect(texts(store)).toEqual(["Kickoff for @Bo", "Thanks!"]);
    expect(store.getChannel("C1")?.lastSyncedTs).toBe(tsDaysAgo(1));
  });

  it("purges a channel that Ghost left", async () => {
    const { slack, store, syncer } = setup();
    const channel = slack.addChannel("C1", "general");
    slack.say("C1", { ts: tsDaysAgo(1), user: "U1", text: "hello" });
    await syncer.syncAll();
    expect(texts(store)).toEqual(["hello"]);

    channel.isMember = false;
    await syncer.syncAll();
    expect(texts(store)).toEqual([]);
    expect(store.getChannel("C1")?.isMember).toBe(false);
  });

  it("applies live edits, deletes, and new messages", async () => {
    const { slack, store, syncer } = setup();
    slack.addChannel("C1", "general");
    await syncer.syncAll();
    const ts = tsDaysAgo(0);
    await syncer.ingest({ channel: "C1", ts, user: "U1", text: "ship monday" });
    expect(texts(store)).toEqual(["ship monday"]);
    await syncer.ingest({ channel: "C1", ts: tsDaysAgo(0, 1), subtype: "message_changed", message: { ts, user: "U1", text: "ship friday" } });
    expect(texts(store)).toEqual(["ship friday"]);
    await syncer.ingest({ channel: "C1", ts: tsDaysAgo(0, 2), subtype: "message_deleted", deleted_ts: ts });
    expect(texts(store)).toEqual([]);
  });

  it("ignores live messages from channels Ghost has not joined", async () => {
    const { store, syncer } = setup();
    await syncer.ingest({ channel: "CX", ts: tsDaysAgo(0), user: "U1", text: "hello" });
    expect(texts(store)).toEqual([]);
  });

  it("re-fetches a thread only when it has newer replies", async () => {
    const { slack, syncer } = setup();
    slack.addChannel("C1", "general");
    const root = tsDaysAgo(2);
    slack.say("C1", { ts: root, user: "U1", text: "root" });
    slack.say("C1", { ts: tsDaysAgo(2, 1), user: "U2", text: "reply", thread_ts: root });
    await syncer.syncAll();
    const first = slack.calls.filter((c) => c.startsWith("replies:")).length;
    await syncer.syncAll();
    expect(slack.calls.filter((c) => c.startsWith("replies:")).length).toBe(first);

    slack.say("C1", { ts: tsDaysAgo(1), user: "U1", text: "late reply", thread_ts: root });
    await syncer.syncAll();
    expect(slack.calls.filter((c) => c.startsWith("replies:")).length).toBe(first + 1);
  });

  it("backfills a channel when Ghost joins it", async () => {
    const { slack, store, syncer } = setup();
    slack.addChannel("C3", "new");
    slack.say("C3", { ts: tsDaysAgo(1), user: "U1", text: "welcome" });
    await syncer.joined("C3");
    expect(texts(store)).toEqual(["welcome"]);
  });

  it("does not re-fetch a thread whose last reply is Ghost's own", async () => {
    const { slack, syncer } = setup();
    slack.addChannel("C1", "general");
    const root = tsDaysAgo(2);
    slack.say("C1", { ts: root, user: "U1", text: "question" });
    slack.say("C1", { ts: tsDaysAgo(2, 1), user: BOT_USER, bot_id: BOT_ID, text: "Ghost answer", thread_ts: root });
    await syncer.syncAll();
    const first = slack.calls.filter((c) => c.startsWith("replies:")).length;
    await syncer.syncAll();
    expect(slack.calls.filter((c) => c.startsWith("replies:")).length).toBe(first);
  });

  it("catches up, once per process, on replies to older threads posted while Ghost was offline", async () => {
    const { slack, store, syncer } = setup();
    slack.addChannel("C1", "general");
    const root = tsDaysAgo(20); // older than the 7-day resync overlap
    slack.say("C1", { ts: root, user: "U1", text: "old decision" });
    slack.say("C1", { ts: tsDaysAgo(20, 1), user: "U2", text: "first reply", thread_ts: root });
    await syncer.syncAll();

    // Ghost restarts later. Meanwhile someone replies to the old thread.
    slack.say("C1", { ts: tsDaysAgo(0.5), user: "U2", text: "offline reply", thread_ts: root });
    const restarted = new Syncer(slack, store, new UserDirectory(slack, store), { botUserId: BOT_USER, botId: BOT_ID }, { backfillDays: 365 });
    await restarted.syncAll();
    expect(texts(store)).toContain("offline reply");

    const calls = slack.calls.length;
    await restarted.syncAll();
    expect(slack.calls.slice(calls).filter((c) => c === `replies:C1:${root}`)).toHaveLength(0);
  });
});
