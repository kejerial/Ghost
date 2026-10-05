import type { SlackApi, SlackMessage } from "../slack/api.js";
import { cleanSlackText } from "../slack/text.js";
import type { UserDirectory } from "../slack/users.js";

export interface ContextMessage {
  channelId: string;
  ts: string;
  threadTs: string | null;
  userName: string;
  text: string;
  /** Ghost's own earlier replies. They give conversational context but are never cited as sources. */
  isGhost: boolean;
}

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "bot_add", "bot_remove"]);

async function toContext(
  channelId: string,
  messages: SlackMessage[],
  users: UserDirectory,
  isGhost: (m: SlackMessage) => boolean,
): Promise<ContextMessage[]> {
  await users.warm(messages.map((m) => m.user), messages.map((m) => m.text));
  const out: ContextMessage[] = [];
  for (const m of messages) {
    if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) continue;
    const text = cleanSlackText(m.text ?? "", (id) => users.cached(id));
    if (!text) continue;
    const ghost = isGhost(m);
    out.push({
      channelId,
      ts: m.ts,
      threadTs: m.thread_ts ?? null,
      userName: ghost ? "Ghost" : m.user ? await users.name(m.user) : (m.username ?? "bot"),
      text,
      isGhost: ghost,
    });
  }
  return out;
}

/** The full current thread, oldest first, capped at `max` messages (root + newest). */
export async function gatherThread(
  api: SlackApi,
  users: UserDirectory,
  isGhost: (m: SlackMessage) => boolean,
  channelId: string,
  threadTs: string,
  max = 200,
): Promise<ContextMessage[]> {
  const all: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.replies(channelId, threadTs, { limit: 200, cursor });
    all.push(...page.messages);
    cursor = page.nextCursor;
  } while (cursor && all.length < 1000);
  const kept = all.length > max ? [all[0]!, ...all.slice(-(max - 1))] : all;
  return toContext(channelId, kept, users, isGhost);
}

/** Recent top-level channel messages before `beforeTs`, oldest first. */
export async function gatherRecent(
  api: SlackApi,
  users: UserDirectory,
  isGhost: (m: SlackMessage) => boolean,
  channelId: string,
  beforeTs: string,
  limit = 15,
): Promise<ContextMessage[]> {
  const page = await api.history(channelId, { latest: beforeTs, limit });
  return toContext(channelId, [...page.messages].reverse(), users, isGhost);
}
