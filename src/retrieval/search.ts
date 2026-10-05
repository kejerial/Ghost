import type { Store } from "../store/db.js";

export interface RetrievalQuery {
  question: string;
  /** The channel where the question was asked. */
  channelId: string;
  /** Message keys (`channel:ts`) that are already in the prompt. */
  exclude: Set<string>;
  limit?: number;
  now?: number;
}

export interface RetrievedMessage {
  channelId: string;
  channelName: string;
  ts: string;
  threadTs: string | null;
  userName: string;
  text: string;
  score: number;
  /** The thread root, when the hit is a reply and the root adds context. */
  parent?: { ts: string; userName: string; text: string };
}

/** The retrieval contract. The MVP uses SQLite FTS5. A pgvector retriever can replace it later. */
export interface Retriever {
  search(query: RetrievalQuery): RetrievedMessage[];
}

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers herself him
  himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other
  our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
  these they this those through to too under until up very was we were what when where which while who whom why will
  with would you your yours yourself yourselves ghost hey please thanks tell show give know get got let lets us
  summarize summary catch decide decided decision did think thoughts any anything something whats what's`.split(/\s+/),
);

/** Build an FTS5 query from a natural-language question. Returns null when no useful terms remain. */
export function buildFtsQuery(question: string): string | null {
  const terms = new Set<string>();
  for (const match of question.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    if (term.length < 2 || STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= 12) break;
  }
  if (terms.size === 0) return null;
  // Quote each term so FTS5 operators in user text have no effect. The trailing * adds prefix matching.
  return [...terms].map((term) => `"${term}"*`).join(" OR ");
}

export interface RawHit {
  channelId: string;
  channelName: string;
  ts: string;
  threadTs: string | null;
  userName: string | null;
  text: string;
  /** FTS5 bm25() value. Lower is better, and matches are negative. */
  bm25: number;
}

const HALF_LIFE_DAYS = 90;
const WEIGHTS = { relevance: 0.6, recency: 0.3, channel: 0.1 };

/** Combine text relevance, recency, and channel affinity into one score in [0, 1]. */
export function rankHits(hits: RawHit[], channelId: string, now: number): Array<RawHit & { score: number }> {
  const best = Math.max(...hits.map((h) => -h.bm25), Number.EPSILON);
  return hits
    .map((hit) => {
      const relevance = Math.max(0, -hit.bm25) / best;
      const ageDays = Math.max(0, (now / 1000 - Number(hit.ts)) / 86400);
      const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      const channel = hit.channelId === channelId ? 1 : 0;
      const score = WEIGHTS.relevance * relevance + WEIGHTS.recency * recency + WEIGHTS.channel * channel;
      return { ...hit, score };
    })
    .sort((a, b) => b.score - a.score);
}

const MAX_PER_THREAD = 3;

export class FtsRetriever implements Retriever {
  constructor(private readonly store: Store) {}

  search(query: RetrievalQuery): RetrievedMessage[] {
    const fts = buildFtsQuery(query.question);
    if (!fts) return [];
    const limit = query.limit ?? 12;

    // Only channels Ghost is still a member of.
    const rows = this.store.db
      .prepare(
        `SELECT m.channel_id AS channelId, c.name AS channelName, m.ts, m.thread_ts AS threadTs,
                m.user_name AS userName, m.clean_text AS text, bm25(messages_fts) AS bm25
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN channels c ON c.id = m.channel_id
         WHERE messages_fts MATCH ?
           AND c.is_member = 1
         ORDER BY bm25
         LIMIT 200`,
      )
      .all(fts) as RawHit[];

    const fresh = rows.filter((row) => !query.exclude.has(`${row.channelId}:${row.ts}`));
    const ranked = rankHits(fresh, query.channelId, query.now ?? Date.now());

    const perThread = new Map<string, number>();
    const picked: RetrievedMessage[] = [];
    for (const hit of ranked) {
      const threadKey = `${hit.channelId}:${hit.threadTs ?? hit.ts}`;
      const count = perThread.get(threadKey) ?? 0;
      if (count >= MAX_PER_THREAD) continue;
      perThread.set(threadKey, count + 1);
      picked.push({
        channelId: hit.channelId,
        channelName: hit.channelName,
        ts: hit.ts,
        threadTs: hit.threadTs,
        userName: hit.userName ?? "unknown",
        text: hit.text,
        score: hit.score,
        parent: this.parentOf(hit, query.exclude),
      });
      if (picked.length >= limit) break;
    }
    // Present the hits in time order. The model can then see how a topic developed.
    return picked.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  private parentOf(hit: RawHit, exclude: Set<string>): RetrievedMessage["parent"] {
    if (!hit.threadTs || hit.threadTs === hit.ts) return undefined;
    if (exclude.has(`${hit.channelId}:${hit.threadTs}`)) return undefined;
    const row = this.store.db
      .prepare(`SELECT ts, user_name AS userName, clean_text AS text FROM messages WHERE channel_id = ? AND ts = ?`)
      .get(hit.channelId, hit.threadTs) as { ts: string; userName: string | null; text: string } | undefined;
    return row ? { ts: row.ts, userName: row.userName ?? "unknown", text: row.text } : undefined;
  }
}
