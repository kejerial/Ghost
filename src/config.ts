import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : undefined));

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-", "SLACK_BOT_TOKEN must be a bot token (xoxb-...)"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-", "SLACK_APP_TOKEN must be an app-level token (xapp-...)"),
  GHOST_BACKEND: z.enum(["claude", "codex", "openai-compatible"]).default("claude"),
  GHOST_MODEL: optionalString,
  GHOST_MODEL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  GHOST_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  GHOST_PROXY_URL: z.string().url().default("http://127.0.0.1:8317/v1"),
  GHOST_PROXY_API_KEY: optionalString,
  GHOST_DB_PATH: z.string().default("./data/ghost.db"),
  GHOST_BACKFILL_DAYS: z.coerce.number().int().nonnegative().default(365),
  GHOST_RESYNC_MINUTES: z.coerce.number().int().nonnegative().default(360),
  GHOST_CONTEXT_CHARS: z.coerce.number().int().min(4000).default(24000),
  GHOST_HOME_CHANNEL: optionalString,
  GHOST_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  backend: "claude" | "codex" | "openai-compatible";
  model: string | undefined;
  modelTimeoutMs: number;
  maxConcurrency: number;
  proxyUrl: string;
  proxyApiKey: string | undefined;
  dbPath: string;
  backfillDays: number;
  resyncMinutes: number;
  contextChars: number;
  /** Optional chat channel (name or ID). Ghost answers every message there, no tag needed. */
  homeChannel: string | undefined;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so that blank lines in .env fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  const c = parsed.data;
  return {
    slackBotToken: c.SLACK_BOT_TOKEN,
    slackAppToken: c.SLACK_APP_TOKEN,
    backend: c.GHOST_BACKEND,
    model: c.GHOST_MODEL,
    modelTimeoutMs: c.GHOST_MODEL_TIMEOUT_SECONDS * 1000,
    maxConcurrency: c.GHOST_MAX_CONCURRENCY,
    proxyUrl: c.GHOST_PROXY_URL,
    proxyApiKey: c.GHOST_PROXY_API_KEY,
    dbPath: c.GHOST_DB_PATH,
    backfillDays: c.GHOST_BACKFILL_DAYS,
    resyncMinutes: c.GHOST_RESYNC_MINUTES,
    contextChars: c.GHOST_CONTEXT_CHARS,
    homeChannel: c.GHOST_HOME_CHANNEL?.replace(/^#/, ""),
    logLevel: c.GHOST_LOG_LEVEL,
  };
}
