import type { ChannelInfo, SlackApi, SlackMessage } from "../slack/api.js";
import { cleanSlackText } from "../slack/text.js";
import type { UserDirectory } from "../slack/users.js";
import { errorFields, log } from "../log.js";
import type { Store, StoredMessage } from "./db.js";

/** Message subtypes that carry human content. Everything else (joins, topic changes, ...) is noise. */
const CONTENT_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share", "bot_message", "me_message"]);

/** On a resync, look back this far so late thread replies and edits are picked up. */
const RESYNC_OVERLAP_SECONDS = 7 * 24 * 60 * 60;

/** At startup, re-check threads started in this window for replies posted while Ghost was offline. */
const CATCH_UP_DAYS = 30;

export interface Identity {
  botUserId: string;
  botId?: string;
}

/** Message events Ghost receives through the Events API (message.channels / message.groups). */
export interface MessageEvent extends SlackMessage {
  channel: string;
  message?: SlackMessage;
  deleted_ts?: string;
  previous_message?: SlackMessage;
}

/**
 * Keeps the local index in step with Slack. Ghost indexes only channels that it
 * is a member of, and it never indexes its own messages.
 */
export class Syncer {
  private readonly running = new Map<string, Promise<void>>();
  /** Channels that had their once-per-process offline catch-up sweep. */
  private readonly caughtUp = new Set<string>();

  constructor(
    private readonly api: SlackApi,
    private readonly store: Store,
    private readonly users: UserDirectory,
    private readonly identity: Identity,
    private readonly options: { backfillDays: number },
  ) {}

  isOwnMessage(m: SlackMessage): boolean {
    return m.user === this.identity.botUserId || (this.identity.botId !== undefined && m.bot_id === this.identity.botId);
  }

  toStored(channelId: string, m: SlackMessage): StoredMessage | null {
    if (!CONTENT_SUBTYPES.has(m.subtype) || this.isOwnMessage(m)) return null;
    const text = m.text ?? "";
    const cleanText = cleanSlackText(text, (id) => this.users.cached(id));
    if (!cleanText) return null;
    const userName = m.user ? (this.users.cached(m.user) ?? m.user) : (m.username ?? "bot");
    return {
      channelId,
      ts: m.ts,
      threadTs: m.thread_ts ?? null,
      userId: m.user ?? null,
      userName,
      text,
      cleanText,
      isBot: Boolean(m.bot_id),
      replyCount: m.reply_count ?? 0,
    };
  }

  /** Refresh channel membership, purge channels Ghost left, and sync every member channel. */
  async syncAll(): Promise<void> {
    const channels = await this.api.memberChannels();
    const current = new Set(channels.map((c) => c.id));
    for (const stale of this.store.memberChannels()) {
      if (!current.has(stale.id)) {
        log.info("purging channel Ghost is no longer in", { channel: stale.id });
        this.store.purgeChannel(stale.id);
      }
    }
    for (const channel of channels) {
      this.store.upsertChannel(channel);
      await this.syncChannel(channel.id).catch((error) =>
        log.error("channel sync failed", { channel: channel.id, ...errorFields(error) }),
      );
    }
    log.info("sync complete", this.store.stats());
  }

  /** Sync one channel. Concurrent calls for the same channel share one run. */
  syncChannel(channelId: string): Promise<void> {
    const existing = this.running.get(channelId);
    if (existing) return existing;
    const run = this.doSyncChannel(channelId).finally(() => this.running.delete(channelId));
    this.running.set(channelId, run);
    return run;
  }

  private async doSyncChannel(channelId: string): Promise<void> {
    const channel = this.store.getChannel(channelId);
    if (!channel?.isMember) return;
    const nowSeconds = Date.now() / 1000;
    const backfillStart = nowSeconds - this.options.backfillDays * 86400;
    const oldest = channel.lastSyncedTs
      ? Math.max(backfillStart, Number(channel.lastSyncedTs) - RESYNC_OVERLAP_SECONDS)
      : backfillStart;

    let newest = channel.lastSyncedTs ?? "0";
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await this.api.history(channelId, { oldest: oldest.toFixed(6), limit: 200, cursor });
      await this.users.warm(page.messages.map((m) => m.user), page.messages.map((m) => m.text));
      const rows = page.messages.map((m) => this.toStored(channelId, m)).filter((m): m is StoredMessage => m !== null);
      this.store.upsertMessages(rows);
      count += rows.length;
      for (const m of page.messages) {
        if (Number(m.ts) > Number(newest)) newest = m.ts;
        if ((m.reply_count ?? 0) > 0 && this.threadNeedsSync(channelId, m)) await this.syncThread(channelId, m.ts);
      }
      cursor = page.nextCursor;
    } while (cursor);

    // The history pass above sees only roots inside the overlap window. Once per process, also fetch
    // replies that arrived while Ghost was offline to older threads (started in the last 30 days).
    if (channel.lastSyncedTs && !this.caughtUp.has(channelId)) {
      const sweepStart = Math.max(backfillStart, nowSeconds - CATCH_UP_DAYS * 86400);
      for (const rootTs of this.store.threadRootsBetween(channelId, sweepStart, oldest)) {
        await this.syncThread(channelId, rootTs, channel.lastSyncedTs);
      }
    }
    this.caughtUp.add(channelId);

    if (newest !== "0") this.store.setLastSynced(channelId, newest);
    log.info("channel synced", { channel: channelId, messages: count });
  }

  private threadNeedsSync(channelId: string, root: SlackMessage): boolean {
    if (!root.latest_reply) return true;
    const seen = this.store.threadLatestReply(channelId, root.ts);
    return seen === undefined || Number(seen) < Number(root.latest_reply);
  }

  private async syncThread(channelId: string, threadTs: string, oldest?: string): Promise<void> {
    let cursor: string | undefined;
    let latestReply = this.store.threadLatestReply(channelId, threadTs) ?? "0";
    do {
      const page = await this.api.replies(channelId, threadTs, { limit: 200, cursor, oldest });
      await this.users.warm(page.messages.map((m) => m.user), page.messages.map((m) => m.text));
      const rows = page.messages.map((m) => this.toStored(channelId, m)).filter((m): m is StoredMessage => m !== null);
      this.store.upsertMessages(rows);
      // Count every reply, Ghost's own included, so a thread that Ghost answered last is still "current".
      for (const m of page.messages) if (m.ts !== threadTs && Number(m.ts) > Number(latestReply)) latestReply = m.ts;
      cursor = page.nextCursor;
    } while (cursor);
    if (latestReply !== "0") this.store.setThreadLatestReply(channelId, threadTs, latestReply);
  }

  /** Apply one live message event to the index. */
  async ingest(event: MessageEvent): Promise<void> {
    const channel = this.store.getChannel(event.channel);
    if (!channel?.isMember) return;

    if (event.subtype === "message_deleted" && event.deleted_ts) {
      this.store.deleteMessage(event.channel, event.deleted_ts);
      return;
    }
    const message = event.subtype === "message_changed" ? event.message : event;
    if (!message) return;
    await this.users.warm([message.user], [message.text]);
    const row = this.toStored(event.channel, message);
    if (row) this.store.upsertMessage(row);
    else if (event.subtype === "message_changed") this.store.deleteMessage(event.channel, message.ts);
  }

  /** Ghost joined a channel: record it and backfill its history. */
  async joined(channelId: string): Promise<void> {
    const info: ChannelInfo = await this.api.channelInfo(channelId);
    this.store.upsertChannel({ ...info, isMember: true });
    await this.syncChannel(channelId);
  }

  /** Ghost left a channel or the channel was archived: forget everything from it. */
  left(channelId: string): void {
    this.store.purgeChannel(channelId);
  }
}
