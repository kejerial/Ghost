/**
 * `npm run doctor` — check that Ghost can run. Add `--live` to also send one
 * short test prompt through the configured model backend.
 */
import { webApi } from "@slack/bolt";
import { createBackend } from "./backend/index.js";
import { loadConfig, type Config } from "./config.js";
import { openDb, Store } from "./store/db.js";

export const REQUIRED_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "reactions:write",
  "users:read",
];

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function attempt(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await fn());
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

let config: Config | undefined;
try {
  config = loadConfig();
  record("config", true, `backend=${config.backend}, db=${config.dbPath}`);
} catch (error) {
  record("config", false, error instanceof Error ? error.message : String(error));
}

if (config) {
  const c = config;
  await attempt("slack bot token", async () => {
    const r = await new webApi.WebClient(c.slackBotToken).auth.test();
    const scopes = r.response_metadata?.scopes ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) throw new Error(`missing scopes: ${missing.join(", ")} (run "slack run" again to update the app from manifest.json)`);
    return `bot @${r.user} in ${r.team} (${r.url})`;
  });
  await attempt("slack app token (Socket Mode)", async () => {
    await new webApi.WebClient(c.slackAppToken).apps.connections.open();
    return "Socket Mode connection allowed";
  });
  await attempt("database", async () => {
    const store = new Store(openDb(c.dbPath));
    const stats = store.stats();
    store.db.close();
    return `${stats.channels} channels, ${stats.messages} messages indexed`;
  });
  const backend = createBackend(c);
  await attempt(`backend (${backend.name})`, () => backend.check());
  if (process.argv.includes("--live")) {
    await attempt(`backend live call (${backend.name})`, async () => {
      const started = Date.now();
      const reply = await backend.complete({ system: "Reply with exactly one word.", prompt: "Say PONG.", timeoutMs: c.modelTimeoutMs });
      return `"${reply.slice(0, 40)}" in ${((Date.now() - started) / 1000).toFixed(1)}s`;
    });
  }
}

for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
