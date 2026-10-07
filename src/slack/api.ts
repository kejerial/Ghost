import type { webApi } from "@slack/bolt";
import type { SlackFile } from "./files.js";

type WebClient = webApi.WebClient;

/** The subset of a Slack message that Ghost reads. */
export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackFile[];
  /** Rich layout blocks. Ghost reads only table blocks from them. */
  blocks?: unknown[];
}

interface ChannelProperties {
  canvas?: { file_id?: string };
  tabs?: { type?: string; data?: { file_id?: string } }[];
}

export interface ChannelInfo {
  id: string;
  name: string;
  isMember: boolean;
}

export interface Page {
  messages: SlackMessage[];
  nextCursor?: string;
}

/**
 * The Slack Web API calls that Ghost uses. The interface keeps the pipeline
 * testable with a fake, and it documents the exact API surface (and scopes).
 */
export interface SlackApi {
  authTest(): Promise<{ userId: string; botId?: string; teamId: string; teamUrl: string }>;
  memberChannels(): Promise<ChannelInfo[]>;
  channelInfo(channelId: string): Promise<ChannelInfo>;
  history(channelId: string, options: { oldest?: string; latest?: string; limit: number; cursor?: string }): Promise<Page>;
  replies(channelId: string, threadTs: string, options: { limit: number; cursor?: string; oldest?: string }): Promise<Page>;
  userInfo(userId: string): Promise<{ id: string; name: string; isBot: boolean; tz?: string }>;
  /** Slack posts the message at `postAt` (Unix seconds), even if Ghost is offline. Returns the scheduled message ID. */
  scheduleMessage(channelId: string, postAt: number, text: string): Promise<string>;
  deleteScheduledMessage(channelId: string, scheduledMessageId: string): Promise<void>;
  channelMembers(channelId: string): Promise<string[]>;
  /** Post a message. Without `threadTs`, the message goes to the channel itself. */
  post(channelId: string, threadTs: string | undefined, text: string): Promise<{ ts: string }>;
  addReaction(channelId: string, ts: string, name: string): Promise<void>;
  /** Edit Ghost's own message (used only for the plain-text status line). */
  update(channelId: string, ts: string, text: string): Promise<void>;
  deleteMessage(channelId: string, ts: string): Promise<void>;
  removeReaction(channelId: string, ts: string, name: string): Promise<void>;
  /** File IDs of the channel's canvas tabs, in tab order. */
  channelCanvasIds(channelId: string): Promise<string[]>;
  fileInfo(fileId: string): Promise<SlackFile>;
  editCanvas(canvasId: string, change: CanvasChange): Promise<void>;
  /** Add a new canvas tab to the channel. Returns the canvas ID. */
  createChannelCanvas(channelId: string, markdown: string, title?: string): Promise<string>;
  deleteCanvas(canvasId: string): Promise<void>;
}

export type CanvasChange =
  | { operation: "insert_at_end" | "insert_at_start" | "replace"; markdown: string }
  | { operation: "rename"; title: string };

export function slackApiFrom(client: WebClient): SlackApi {
  return {
    async authTest() {
      const r = await client.auth.test();
      return { userId: r.user_id!, botId: r.bot_id, teamId: r.team_id!, teamUrl: r.url! };
    },

    async memberChannels() {
      const channels: ChannelInfo[] = [];
      let cursor: string | undefined;
      do {
        const r = await client.users.conversations({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        for (const c of r.channels ?? []) {
          if (c.id && c.name) channels.push({ id: c.id, name: c.name, isMember: true });
        }
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return channels;
    },

    async channelInfo(channelId) {
      const r = await client.conversations.info({ channel: channelId });
      const c = r.channel!;
      return { id: c.id!, name: c.name ?? c.id!, isMember: Boolean(c.is_member) };
    },

    async history(channelId, options) {
      const r = await client.conversations.history({
        channel: channelId,
        oldest: options.oldest,
        latest: options.latest,
        limit: options.limit,
        cursor: options.cursor,
        inclusive: false,
      });
      return { messages: (r.messages ?? []) as SlackMessage[], nextCursor: r.response_metadata?.next_cursor || undefined };
    },

    async replies(channelId, threadTs, options) {
      const r = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: options.limit,
        cursor: options.cursor,
        oldest: options.oldest,
      });
      return { messages: (r.messages ?? []) as SlackMessage[], nextCursor: r.response_metadata?.next_cursor || undefined };
    },

    async channelMembers(channelId) {
      const members: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await client.conversations.members({ channel: channelId, limit: 200, cursor });
        members.push(...(r.members ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return members;
    },

    async userInfo(userId) {
      const r = await client.users.info({ user: userId });
      const u = r.user!;
      const name = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || userId;
      return { id: userId, name, isBot: Boolean(u.is_bot), tz: u.tz };
    },

    async scheduleMessage(channelId, postAt, text) {
      const r = await client.chat.scheduleMessage({ channel: channelId, post_at: postAt, text, unfurl_links: false, unfurl_media: false });
      return r.scheduled_message_id!;
    },

    async deleteScheduledMessage(channelId, scheduledMessageId) {
      await client.chat.deleteScheduledMessage({ channel: channelId, scheduled_message_id: scheduledMessageId });
    },

    async post(channelId, threadTs, text) {
      const r = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
        // Unfurls fetch URLs. A prompt-injected link could leak data through that fetch.
        unfurl_links: false,
        unfurl_media: false,
        // Plain "@here" or "#channel" in model text stays plain text.
        parse: "none",
        link_names: false,
      });
      return { ts: r.ts! };
    },

    async update(channelId, ts, text) {
      await client.chat.update({ channel: channelId, ts, text, parse: "none", link_names: false });
    },

    async deleteMessage(channelId, ts) {
      await client.chat.delete({ channel: channelId, ts });
    },

    async addReaction(channelId, ts, name) {
      await client.reactions.add({ channel: channelId, timestamp: ts, name });
    },

    async removeReaction(channelId, ts, name) {
      await client.reactions.remove({ channel: channelId, timestamp: ts, name });
    },

    async channelCanvasIds(channelId) {
      const r = await client.conversations.info({ channel: channelId });
      const props = (r.channel as { properties?: ChannelProperties } | undefined)?.properties;
      // A channel can have several canvas tabs. Older channels have one, under "canvas".
      const ids = (props?.tabs ?? []).filter((t) => t.type === "canvas").map((t) => t.data?.file_id);
      return [...new Set([props?.canvas?.file_id, ...ids].filter((id): id is string => Boolean(id)))];
    },

    async fileInfo(fileId) {
      const r = await client.files.info({ file: fileId });
      return r.file as SlackFile;
    },

    async editCanvas(canvasId, change) {
      const edit =
        change.operation === "rename"
          ? { operation: "rename" as const, title_content: { type: "markdown" as const, markdown: change.title } }
          : { operation: change.operation, document_content: { type: "markdown" as const, markdown: change.markdown } };
      // The SDK types do not list "rename" yet; the API accepts it.
      await client.canvases.edit({ canvas_id: canvasId, changes: [edit] as Parameters<typeof client.canvases.edit>[0]["changes"] });
    },

    async createChannelCanvas(channelId, markdown, title) {
      const r = await client.conversations.canvases.create({ channel_id: channelId, title, document_content: { type: "markdown", markdown } });
      return r.canvas_id!;
    },

    async deleteCanvas(canvasId) {
      await client.canvases.delete({ canvas_id: canvasId });
    },
  };
}
