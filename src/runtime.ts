import { webApi } from "@slack/bolt";
import { dirname, join } from "node:path";
import { createBackend } from "./backend/index.js";
import type { Config } from "./config.js";
import { Connections } from "./integrations/mcp.js";
import { Profiles } from "./memory/profiles.js";
import { Ghost } from "./pipeline/ghost.js";
import { FtsRetriever } from "./retrieval/search.js";
import { Scheduler } from "./schedule/scheduler.js";
import { slackApiFrom, type SlackApi } from "./slack/api.js";
import { UserDirectory } from "./slack/users.js";
import { openDb, Store } from "./store/db.js";
import { Syncer } from "./store/sync.js";
import { Limiter } from "./util/limiter.js";

export interface Runtime {
  api: SlackApi;
  store: Store;
  users: UserDirectory;
  syncer: Syncer;
  ghost: Ghost;
  scheduler: Scheduler;
  identity: { botUserId: string; botId?: string; teamUrl: string };
}

/** Wire every component. Shared by the bot, `npm run ask`, and `npm run doctor`. */
export async function createRuntime(
  config: Config,
  client: webApi.WebClient = new webApi.WebClient(config.slackBotToken),
): Promise<Runtime> {
  const api = slackApiFrom(client);
  const auth = await api.authTest();
  const identity = { botUserId: auth.userId, botId: auth.botId, teamUrl: auth.teamUrl };
  const store = new Store(openDb(config.dbPath));
  const users = new UserDirectory(api, store);
  const syncer = new Syncer(api, store, users, identity, { backfillDays: config.backfillDays });
  const connections = new Connections({ mode: config.connections, exclude: config.connectionsExclude });
  await connections.refresh(true);
  const ghost = new Ghost({
    api,
    store,
    users,
    retriever: new FtsRetriever(store),
    backend: createBackend(config, () => connections.servers),
    limiter: new Limiter(config.maxConcurrency),
    identity,
    contextChars: config.contextChars,
    modelTimeoutMs: config.modelTimeoutMs,
    profiles: new Profiles(join(dirname(config.dbPath), "profiles")),
    connections,
  });
  const scheduler = new Scheduler(store.db, api, async (s) => {
    const ts = (Date.now() / 1000).toFixed(6);
    return (await ghost.answer({ channel: s.channelId, ts, user: s.userId, text: s.text }, s.text)).text;
  });
  ghost.attachScheduler(scheduler);
  return { api, store, users, syncer, ghost, scheduler, identity };
}
