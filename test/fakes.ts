import type { CompletionRequest, ModelBackend } from "../src/backend/types.js";
import type { ChannelInfo, Page, SlackApi, SlackMessage } from "../src/slack/api.js";
import { openDb, Store } from "../src/store/db.js";

export const TEAM_URL = "https://acme.slack.com/";
export const BOT_USER = "UGHOST";
export const BOT_ID = "BGHOST";

/** Fixed at load time so repeated calls return identical values within a test run. */
const NOW_SECONDS = Math.floor(Date.now() / 1000);

/** Seconds-based Slack ts for `daysAgo` days before now, made unique with `seq`. */
export function tsDaysAgo(daysAgo: number, seq = 0): string {
  const seconds = Math.floor(NOW_SECONDS - daysAgo * 86400) + seq;
  return `${seconds}.${String(100 + seq).padStart(6, "0")}`;
}

export interface FakeChannel extends ChannelInfo {
  messages: SlackMessage[];
  members: string[];
}

/** An in-memory Slack workspace that implements the SlackApi interface. */
export class FakeSlack implements SlackApi {
  channels = new Map<string, FakeChannel>();
  users = new Map<string, { name: string; isBot: boolean }>([[BOT_USER, { name: "ghost", isBot: true }]]);
  posts: Array<{ channel: string; threadTs: string | undefined; text: string; ts: string }> = [];
  reactions: Array<{ op: "add" | "remove"; channel: string; ts: string; name: string }> = [];
  calls: string[] = [];
  private seq = 0;

  addChannel(id: string, name: string, options: { isMember?: boolean; members?: string[] } = {}): FakeChannel {
    const channel = { id, name, isMember: options.isMember ?? true, messages: [], members: options.members ?? [BOT_USER] };
    this.channels.set(id, channel);
    return channel;
  }

  addUser(id: string, name: string): void {
    this.users.set(id, { name, isBot: false });
  }

  say(channelId: string, message: SlackMessage): SlackMessage {
    this.channels.get(channelId)!.messages.push(message);
    if (message.thread_ts && message.thread_ts !== message.ts) {
      const root = this.channels.get(channelId)!.messages.find((m) => m.ts === message.thread_ts);
      if (root) {
        root.reply_count = (root.reply_count ?? 0) + 1;
        root.latest_reply = message.ts;
      }
    }
    return message;
  }

  async authTest() {
    return { userId: BOT_USER, botId: BOT_ID, teamId: "T1", teamUrl: TEAM_URL };
  }

  async memberChannels(): Promise<ChannelInfo[]> {
    return [...this.channels.values()].filter((c) => c.isMember).map(({ messages: _m, members: _p, ...info }) => info);
  }

  async channelInfo(channelId: string): Promise<ChannelInfo> {
    this.calls.push(`info:${channelId}`);
    const { messages: _m, members: _p, ...info } = this.channels.get(channelId)!;
    return info;
  }

  async history(channelId: string, options: { oldest?: string; latest?: string; limit: number }): Promise<Page> {
    this.calls.push(`history:${channelId}`);
    const top = this.channels
      .get(channelId)!
      .messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast")
      .filter((m) => (options.oldest ? Number(m.ts) > Number(options.oldest) : true))
      .filter((m) => (options.latest ? Number(m.ts) < Number(options.latest) : true))
      .sort((a, b) => Number(b.ts) - Number(a.ts)); // Slack returns newest first.
    return { messages: top.slice(0, options.limit) };
  }

  async replies(channelId: string, threadTs: string): Promise<Page> {
    this.calls.push(`replies:${channelId}:${threadTs}`);
    const messages = this.channels
      .get(channelId)!
      .messages.filter((m) => m.ts === threadTs || m.thread_ts === threadTs)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    return { messages };
  }

  async channelMembers(channelId: string): Promise<string[]> {
    this.calls.push(`members:${channelId}`);
    return this.channels.get(channelId)!.members;
  }

  async userInfo(userId: string) {
    const user = this.users.get(userId);
    if (!user) throw new Error(`user_not_found: ${userId}`);
    return { id: userId, ...user };
  }

  async post(channel: string, threadTs: string | undefined, text: string) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(900000 + this.seq++)}`;
    this.posts.push({ channel, threadTs, text, ts });
    return { ts };
  }

  async addReaction(channel: string, ts: string, name: string) {
    this.reactions.push({ op: "add", channel, ts, name });
  }

  async removeReaction(channel: string, ts: string, name: string) {
    this.reactions.push({ op: "remove", channel, ts, name });
  }

}

/** A backend that records the request and returns a scripted reply. */
export class FakeBackend implements ModelBackend {
  readonly name = "fake";
  requests: CompletionRequest[] = [];

  constructor(private readonly reply: string | ((request: CompletionRequest) => string) = "OK") {}

  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push(request);
    return typeof this.reply === "function" ? this.reply(request) : this.reply;
  }

  async check(): Promise<string> {
    return "fake";
  }
}

export function memoryStore(): Store {
  return new Store(openDb(":memory:"));
}
