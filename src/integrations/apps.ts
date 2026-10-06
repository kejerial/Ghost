import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A ChatGPT app (connector) such as Gmail or Google Calendar. Codex installs it as a plugin
 * from the "openai-curated-remote" marketplace, and it runs on the ChatGPT subscription.
 */
export interface AppConnection {
  name: string;
  /** The app ID that `codex exec -c apps.<id>.enabled=true` turns on. */
  appId: string;
}

export const APP_MARKETPLACE = "openai-curated-remote";

/**
 * Apps Ghost never uses. Slack: Ghost already reads Slack as itself, and the app would read it
 * as you, including channels Ghost is not in. The rest are developer or admin tools, not data sources.
 */
const NEVER = new Set([
  "slack",
  "plugin-creator",
  "codex-tasks",
  "cloud-environment",
  "code-review",
  "admin-console",
  "task-tool",
  "defense-factory",
  "openai-developers",
  "openai-templates",
  "pages",
  "sites",
  "plugin-management",
  "work-pets",
]);

export interface AppCatalog {
  installed: AppConnection[];
  /** Apps that can be installed with `codex plugin add <name>@openai-curated-remote`. */
  available: string[];
}

/**
 * Parse `codex plugin list` (text output; its JSON output omits remote plugins that are not installed).
 * Line format: `gmail@openai-curated-remote   installed, enabled  0.1.10  plugin_connector_1p_...`
 */
export function parsePluginList(text: string): { name: string; installed: boolean; enabled: boolean }[] {
  const out: { name: string; installed: boolean; enabled: boolean }[] = [];
  const line = new RegExp(`^([a-z0-9-]+)@${APP_MARKETPLACE}\\s+(installed, enabled|installed, disabled|not installed)\\s+\\S+\\s+(plugin_(?:connector|asdk_app)_\\S+)`);
  for (const raw of text.split("\n")) {
    const m = line.exec(raw.trim());
    if (!m) continue;
    out.push({ name: m[1]!, installed: m[2] !== "not installed", enabled: m[2] === "installed, enabled" });
  }
  return out;
}

/** Read the app ID of an installed plugin from its newest cached version's `.app.json`. */
export async function appIdFor(name: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<string | undefined> {
  const dir = join(codexHome, "plugins", "cache", APP_MARKETPLACE, name);
  const versions = (await readdir(dir).catch(() => [] as string[])).filter((v) => !v.startsWith(".")).sort().reverse();
  for (const version of versions) {
    try {
      const json = JSON.parse(await readFile(join(dir, version, ".app.json"), "utf8")) as { apps?: Record<string, { id?: string }> };
      const id = Object.values(json.apps ?? {})[0]?.id;
      if (id && /^[A-Za-z0-9_]+$/.test(id)) return id;
    } catch {
      // no app file in this version
    }
  }
  return undefined;
}

export async function loadApps(pluginListText: string, exclude: string[], codexHome?: string): Promise<AppCatalog> {
  const skip = (name: string) => NEVER.has(name) || exclude.includes(name);
  const entries = parsePluginList(pluginListText).filter((e) => !skip(e.name));
  const installed: AppConnection[] = [];
  for (const e of entries.filter((e) => e.installed && e.enabled)) {
    const appId = await appIdFor(e.name, codexHome);
    if (appId) installed.push({ name: e.name, appId });
  }
  return { installed, available: entries.filter((e) => !e.installed).map((e) => e.name) };
}

/** `codex exec` flags that turn on exactly these apps and keep every other app off. */
export function codexAppArgs(apps: AppConnection[]): string[] {
  if (!apps.length) return [];
  const args = ["--enable", "apps", "--enable", "plugins", "-c", "apps._default.enabled=false"];
  for (const app of apps) args.push("-c", `apps.${app.appId}.enabled=true`);
  return args;
}

/** "figma-remote-mcp" and "figma" are the same service. */
export function serviceKey(name: string): string {
  return name.toLowerCase().split(/[-_]/).filter((w) => w && !["mcp", "remote", "server"].includes(w)).join("-");
}
