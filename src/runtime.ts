import { webApi } from "@slack/bolt";
import { createBackend } from "./backend/index.js";
import type { Config } from "./config.js";
import { Ghost } from "./pipeline/ghost.js";
import { FtsRetriever } from "./retrieval/search.js";
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
  const ghost = new Ghost({
    api,
    store,
    users,
    retriever: new FtsRetriever(store),
    backend: createBackend(config),
    limiter: new Limiter(config.maxConcurrency),
    identity,
    contextChars: config.contextChars,
    modelTimeoutMs: config.modelTimeoutMs,
  });
  return { api, store, users, syncer, ghost, identity };
}
