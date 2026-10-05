import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export interface StoredMessage {
  channelId: string;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  userName: string | null;
  text: string;
  cleanText: string;
  isBot: boolean;
  replyCount: number;
}

export interface ChannelRow {
  id: string;
  name: string;
  isMember: boolean;
  lastSyncedTs: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  is_member      INTEGER NOT NULL DEFAULT 1,
  last_synced_ts TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  channel_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  thread_ts   TEXT,
  user_id     TEXT,
  user_name   TEXT,
  text        TEXT NOT NULL,
  clean_text  TEXT NOT NULL,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  ts_num      REAL NOT NULL,
  PRIMARY KEY (channel_id, ts)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS messages_time ON messages(ts_num);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  clean_text,
  content='messages',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, clean_text) VALUES (new.rowid, new.clean_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, clean_text) VALUES ('delete', old.rowid, old.clean_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF clean_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, clean_text) VALUES ('delete', old.rowid, old.clean_text);
  INSERT INTO messages_fts(rowid, clean_text) VALUES (new.rowid, new.clean_text);
END;

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  is_bot     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handled_events (
  key        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- The newest reply ts that Slack reported when Ghost last fetched a thread.
-- Ghost does not store its own replies, so stored rows alone cannot tell whether a thread is current.
CREATE TABLE IF NOT EXISTS thread_sync (
  channel_id   TEXT NOT NULL,
  thread_ts    TEXT NOT NULL,
  latest_reply TEXT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export class Store {
  constructor(readonly db: DB) {}

  upsertMessage(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (channel_id, ts, thread_ts, user_id, user_name, text, clean_text, is_bot, reply_count, ts_num)
         VALUES (@channelId, @ts, @threadTs, @userId, @userName, @text, @cleanText, @isBot, @replyCount, @tsNum)
         ON CONFLICT(channel_id, ts) DO UPDATE SET
           thread_ts = excluded.thread_ts,
           user_id = excluded.user_id,
           user_name = excluded.user_name,
           text = excluded.text,
           clean_text = excluded.clean_text,
           is_bot = excluded.is_bot,
           reply_count = MAX(messages.reply_count, excluded.reply_count)`,
      )
      .run({ ...m, isBot: m.isBot ? 1 : 0, tsNum: Number(m.ts) });
  }

  upsertMessages(messages: StoredMessage[]): void {
    const tx = this.db.transaction((rows: StoredMessage[]) => rows.forEach((row) => this.upsertMessage(row)));
    tx(messages);
  }

  deleteMessage(channelId: string, ts: string): void {
    this.db.prepare(`DELETE FROM messages WHERE channel_id = ? AND ts = ?`).run(channelId, ts);
  }

  /** Remove every stored message from a channel. Used when Ghost leaves a channel. */
  purgeChannel(channelId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE channel_id = ?`).run(channelId);
      this.db.prepare(`DELETE FROM thread_sync WHERE channel_id = ?`).run(channelId);
      this.db.prepare(`UPDATE channels SET is_member = 0, last_synced_ts = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), channelId);
    })();
  }

  upsertChannel(c: Omit<ChannelRow, "lastSyncedTs">): void {
    this.db
      .prepare(
        `INSERT INTO channels (id, name, is_member, updated_at)
         VALUES (@id, @name, @isMember, @now)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
           is_member = excluded.is_member, updated_at = excluded.updated_at`,
      )
      .run({ id: c.id, name: c.name, isMember: c.isMember ? 1 : 0, now: Date.now() });
  }

  threadLatestReply(channelId: string, threadTs: string): string | undefined {
    const row = this.db
      .prepare(`SELECT latest_reply FROM thread_sync WHERE channel_id = ? AND thread_ts = ?`)
      .get(channelId, threadTs) as { latest_reply: string } | undefined;
    return row?.latest_reply;
  }

  setThreadLatestReply(channelId: string, threadTs: string, latestReply: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_sync (channel_id, thread_ts, latest_reply) VALUES (?, ?, ?)
         ON CONFLICT(channel_id, thread_ts) DO UPDATE SET latest_reply = excluded.latest_reply`,
      )
      .run(channelId, threadTs, latestReply);
  }

  /** Thread roots with replies, started between two times (seconds). Used for the startup catch-up sweep. */
  threadRootsBetween(channelId: string, fromSeconds: number, toSeconds: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT ts FROM messages
           WHERE channel_id = ? AND reply_count > 0 AND (thread_ts IS NULL OR thread_ts = ts)
             AND ts_num >= ? AND ts_num < ?
           ORDER BY ts_num`,
        )
        .all(channelId, fromSeconds, toSeconds) as Array<{ ts: string }>
    ).map((r) => r.ts);
  }

  setLastSynced(channelId: string, ts: string): void {
    this.db.prepare(`UPDATE channels SET last_synced_ts = ? WHERE id = ?`).run(ts, channelId);
  }

  getChannel(id: string): ChannelRow | undefined {
    const row = this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as RawChannel | undefined;
    return row ? toChannel(row) : undefined;
  }

  memberChannels(): ChannelRow[] {
    return (this.db.prepare(`SELECT * FROM channels WHERE is_member = 1`).all() as RawChannel[]).map(toChannel);
  }

  upsertUser(id: string, name: string, isBot: boolean): void {
    this.db
      .prepare(
        `INSERT INTO users (id, name, is_bot, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_bot = excluded.is_bot, updated_at = excluded.updated_at`,
      )
      .run(id, name, isBot ? 1 : 0, Date.now());
  }

  getUser(id: string): { name: string; updatedAt: number } | undefined {
    const row = this.db.prepare(`SELECT name, updated_at FROM users WHERE id = ?`).get(id) as
      | { name: string; updated_at: number }
      | undefined;
    return row ? { name: row.name, updatedAt: row.updated_at } : undefined;
  }

  /** Returns true the first time a key is seen. Slack retries events, so handlers must be idempotent. */
  claimEvent(key: string): boolean {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO handled_events (key, created_at) VALUES (?, ?)`)
      .run(key, Date.now());
    return result.changes === 1;
  }

  pruneEvents(olderThanMs: number): void {
    this.db.prepare(`DELETE FROM handled_events WHERE created_at < ?`).run(Date.now() - olderThanMs);
  }

  stats(): { channels: number; messages: number } {
    const channels = (this.db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE is_member = 1`).get() as { n: number }).n;
    const messages = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
    return { channels, messages };
  }
}

interface RawChannel {
  id: string;
  name: string;
  is_member: number;
  last_synced_ts: string | null;
}

function toChannel(row: RawChannel): ChannelRow {
  return {
    id: row.id,
    name: row.name,
    isMember: row.is_member === 1,
    lastSyncedTs: row.last_synced_ts,
  };
}
