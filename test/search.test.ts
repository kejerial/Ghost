import { describe, expect, it } from "vitest";
import { buildFtsQuery, FtsRetriever, rankHits, type RawHit } from "../src/retrieval/search.js";
import { memoryStore, tsDaysAgo } from "./fakes.js";
import type { Store } from "../src/store/db.js";

describe("buildFtsQuery", () => {
  it("keeps content words, drops stopwords, and quotes every term", () => {
    expect(buildFtsQuery("What did we decide about pricing?")).toBe('"pricing"*');
    expect(buildFtsQuery("catch me up on the Ms. Lin pilot")).toBe('"ms"* OR "lin"* OR "pilot"*');
  });

  it("neutralizes FTS5 syntax in user text", () => {
    const query = buildFtsQuery('pricing" OR NEAR(a b) -x *')!;
    expect(query).toBe('"pricing"* OR "near"*');
  });

  it("returns null when nothing useful remains", () => {
    expect(buildFtsQuery("what did we decide?")).toBeNull();
  });
});

describe("rankHits", () => {
  const hit = (ts: string, bm25: number, channelId = "C1"): RawHit => ({
    channelId,
    channelName: "x",
    ts,
    threadTs: null,
    userName: "a",
    text: "t",
    bm25,
  });

  it("prefers the recent message when relevance is equal", () => {
    const ranked = rankHits([hit(tsDaysAgo(400), -5), hit(tsDaysAgo(2), -5)], "C1", Date.now());
    expect(ranked[0]!.ts).toBe(tsDaysAgo(2));
  });

  it("lets a much more relevant old message beat a weak recent one", () => {
    const ranked = rankHits([hit(tsDaysAgo(200), -10), hit(tsDaysAgo(1), -1)], "C1", Date.now());
    expect(ranked[0]!.ts).toBe(tsDaysAgo(200));
  });

  it("boosts the current channel", () => {
    const ranked = rankHits([hit(tsDaysAgo(5), -5, "C2"), hit(tsDaysAgo(5, 1), -5, "C1")], "C1", Date.now());
    expect(ranked[0]!.channelId).toBe("C1");
  });
});

function seed(store: Store) {
  store.upsertChannel({ id: "CPUB", name: "pricing", isMember: true });
  store.upsertChannel({ id: "CPRIV", name: "founders", isMember: true });
  store.upsertChannel({ id: "CGONE", name: "old", isMember: false });
  const add = (channelId: string, ts: string, text: string, threadTs: string | null = null) =>
    store.upsertMessage({ channelId, ts, threadTs, userId: "U1", userName: "Ana", text, cleanText: text, isBot: false, replyCount: 0 });
  add("CPUB", tsDaysAgo(30), "We will keep pricing at $49 per seat");
  add("CPRIV", tsDaysAgo(10), "Private: pricing discount for Acme is 40%");
  add("CGONE", tsDaysAgo(5), "Old channel pricing notes");
  const root = tsDaysAgo(20);
  add("CPUB", root, "Thread about the annual plan");
  for (let i = 1; i <= 5; i++) add("CPUB", tsDaysAgo(20, i), `Reply ${i}: annual pricing detail`, root);
}

describe("FtsRetriever", () => {
  it("ignores channels Ghost is no longer a member of", () => {
    const store = memoryStore();
    seed(store);
    const hits = new FtsRetriever(store).search({ question: "old channel notes", channelId: "CPUB", exclude: new Set() });
    expect(hits.some((h) => h.channelId === "CGONE")).toBe(false);
  });

  it("caps hits per thread, attaches the thread root, and skips excluded messages", () => {
    const store = memoryStore();
    seed(store);
    const excluded = `CPUB:${tsDaysAgo(20, 1)}`;
    const hits = new FtsRetriever(store).search({ question: "annual pricing detail", channelId: "CPUB", exclude: new Set([excluded]) });
    const replies = hits.filter((h) => h.threadTs === tsDaysAgo(20));
    expect(replies.length).toBeLessThanOrEqual(3);
    expect(replies.every((h) => h.parent?.text === "Thread about the annual plan" || h.ts === tsDaysAgo(20))).toBe(true);
    expect(hits.some((h) => `${h.channelId}:${h.ts}` === excluded)).toBe(false);
  });

  it("returns hits in time order", () => {
    const store = memoryStore();
    seed(store);
    const hits = new FtsRetriever(store).search({ question: "pricing", channelId: "CPUB", exclude: new Set() });
    const times = hits.map((h) => Number(h.ts));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("finds messages after an edit and forgets deleted ones", () => {
    const store = memoryStore();
    store.upsertChannel({ id: "C1", name: "general", isMember: true });
    const ts = tsDaysAgo(1);
    const base = { channelId: "C1", ts, threadTs: null, userId: "U1", userName: "Ana", isBot: false, replyCount: 0 };
    store.upsertMessage({ ...base, text: "launch on monday", cleanText: "launch on monday" });
    store.upsertMessage({ ...base, text: "launch on friday", cleanText: "launch on friday" });
    const retriever = new FtsRetriever(store);
    expect(retriever.search({ question: "friday launch", channelId: "C1", exclude: new Set() })).toHaveLength(1);
    expect(retriever.search({ question: "monday", channelId: "C1", exclude: new Set() })).toHaveLength(0);
    store.deleteMessage("C1", ts);
    expect(retriever.search({ question: "friday", channelId: "C1", exclude: new Set() })).toHaveLength(0);
  });
});
