import { App, LogLevel } from "@slack/bolt";
import { loadConfig } from "./config.js";
import { errorFields, log, setLogLevel } from "./log.js";
import { ChatChannels } from "./pipeline/chat-channels.js";
import { createRuntime } from "./runtime.js";
import type { MessageEvent } from "./store/sync.js";

const config = loadConfig();
setLogLevel(config.logLevel);

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: config.logLevel === "debug" ? LogLevel.DEBUG : LogLevel.WARN,
});

const runtime = await createRuntime(config, app.client);
const { ghost, syncer, store, identity, api, users } = runtime;

// Optional override. Without it, Ghost chats in any channel where you are the only human member.
let homeChannelId: string | undefined;
if (config.homeChannel) {
  const channels = await api.memberChannels();
  homeChannelId = channels.find((c) => c.id === config.homeChannel || c.name === config.homeChannel)?.id;
  if (!homeChannelId) log.warn("GHOST_HOME_CHANNEL not found among Ghost's channels; invite Ghost there first", { homeChannel: config.homeChannel });
}

const chat = new ChatChannels(api, users, identity.botUserId, homeChannelId);

// Answer mentions. In a chat channel the reply goes to the channel; elsewhere it goes to the thread.
// The message handler can see the same message; event dedupe in Ghost answers it once.
app.event("app_mention", async ({ event }) => {
  const placement = (await chat.isChat(event.channel, event.user)) ? "channel" : "thread";
  void ghost.handleMention({ channel: event.channel, ts: event.ts, thread_ts: event.thread_ts, user: event.user, text: event.text }, placement);
});

// Keep the index current from live message events (message.channels, message.groups).
app.event("message", async ({ event }) => {
  const message = event as unknown as MessageEvent;
  syncer.ingest(message).catch((error) => log.warn("ingest failed", errorFields(error)));
  const human = message.user && !message.bot_id && (!message.subtype || message.subtype === "file_share" || message.subtype === "thread_broadcast");
  if (!human || !(await chat.isChat(message.channel, message.user))) return;
  void ghost.handleMention(
    { channel: message.channel, ts: message.ts, thread_ts: message.thread_ts, user: message.user, text: message.text ?? "" },
    "channel",
  );
});

app.event("member_joined_channel", async ({ event }) => {
  chat.forget(event.channel);
  if (event.user !== identity.botUserId) return;
  log.info("Ghost joined a channel", { channel: event.channel });
  syncer.joined(event.channel).catch((error) => log.error("join sync failed", { channel: event.channel, ...errorFields(error) }));
});

for (const name of ["channel_left", "group_left", "channel_archive", "group_archive"] as const) {
  app.event(name, async ({ event }) => {
    const channel = (event as { channel: string }).channel;
    log.info("Ghost lost access to a channel", { channel, event: name });
    syncer.left(channel);
  });
}

await app.start();
log.info("Ghost is online", { backend: config.backend, homeChannel: homeChannelId ?? "none", db: config.dbPath });

// Initial sync runs in the background. Ghost answers from live context while it runs.
const sync = () => syncer.syncAll().catch((error) => log.error("sync failed", errorFields(error)));
void sync();
if (config.resyncMinutes > 0) setInterval(sync, config.resyncMinutes * 60_000).unref();
setInterval(() => store.pruneEvents(24 * 60 * 60 * 1000), 60 * 60 * 1000).unref();

const shutdown = async (signal: string) => {
  log.info("shutting down", { signal });
  await app.stop().catch(() => undefined);
  store.db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
