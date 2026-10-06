import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAppArgs, parsePluginList } from "../src/integrations/apps.js";
import { Connections } from "../src/integrations/mcp.js";
import { pickConnections } from "../src/integrations/router.js";
import { CodexCliBackend } from "../src/backend/codex.js";
import { buildPrompt } from "../src/pipeline/prompt.js";
import type { Runner } from "../src/backend/subprocess.js";

const PLUGIN_LIST = `
Marketplace openai-curated-remote
gmail@openai-curated-remote                 installed, enabled  0.1.10   plugin_connector_1p_95d3
google-calendar@openai-curated-remote       installed, enabled  1.2.7    plugin_connector_1p_f850
slack@openai-curated-remote                 installed, enabled  0.1.8    plugin_asdk_app_69a1
linear@openai-curated-remote                installed, enabled  1.0.0    plugin_connector_1p_aaaa
github@openai-curated-remote                installed, enabled  0.1.12   plugin_connector_1p_bbbb
figma@openai-curated-remote                 installed, disabled 15.0.0   plugin_connector_68df
google-drive@openai-curated-remote          not installed       0.1.16   plugin_connector_1p_ab21
outlook-email@openai-curated-remote         not installed       0.1.8    plugin_connector_1p_6bcb
plugin-creator@openai-curated-remote        not installed       0.1.22   plugin_connector_1p_e1a1
work-pets@openai-curated-remote             installed, enabled  0.1.0    plugins_6a73
gmail@cursor-plugins                        not installed       /x/gmail
`;

function codexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ghost-codex-home-"));
  const ids: Record<string, string> = {
    gmail: "connector_gmail1",
    "google-calendar": "connector_cal1",
    slack: "asdk_app_slack1",
    linear: "connector_linear1",
    github: "connector_github1",
  };
  for (const [name, id] of Object.entries(ids)) {
    const dir = join(home, "plugins", "cache", "openai-curated-remote", name, "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".app.json"), JSON.stringify({ apps: { [name]: { id, required: true } } }));
  }
  return home;
}

/** A fake `codex`: an MCP list with GitHub connected and Linear signed out, plus the plugin list. */
function fakeCodex(): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (command, args, options) => {
    calls.push([command, ...args]);
    const ok = (stdout: string) => {
      options.onOutput?.(stdout);
      return { stdout, stderr: "", code: 0, timedOut: false };
    };
    if (args[0] === "mcp" && args[1] === "list") {
      return ok(
        JSON.stringify([
          { name: "github", enabled: true, auth_status: "unsupported", transport: { type: "stdio", command: "npx", args: [] } },
          { name: "linear", enabled: true, auth_status: "not_logged_in", transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" } },
        ]),
      );
    }
    if (args[0] === "plugin" && args[1] === "list") return ok(PLUGIN_LIST);
    if (args[0] === "plugin" && args[1] === "add") return ok("Installed google-drive. Link it at https://chatgpt.com/apps/link/google-drive\n");
    return { stdout: "", stderr: "no", code: 1, timedOut: false };
  };
  return { run, calls };
}

describe("ChatGPT apps", () => {
  it("parses only openai-curated-remote connector plugins", () => {
    const names = parsePluginList(PLUGIN_LIST).map((e) => `${e.name}:${e.installed ? "i" : "-"}${e.enabled ? "e" : "-"}`);
    expect(names).toEqual([
      "gmail:ie",
      "google-calendar:ie",
      "slack:ie",
      "linear:ie",
      "github:ie",
      "figma:i-",
      "google-drive:--",
      "outlook-email:--",
      "plugin-creator:--",
    ]);
  });

  it("uses installed apps, skips Slack and duplicates of working connections, and replaces a signed-out login", async () => {
    const connections = new Connections({ mode: "inherit", exclude: [], run: fakeCodex().run, codexHome: codexHome() });
    await connections.refresh(true);
    // GitHub already works through MCP, so its app is skipped. Linear's MCP is signed out, so its app takes over.
    expect(connections.apps).toEqual([
      { name: "gmail", appId: "connector_gmail1" },
      { name: "google-calendar", appId: "connector_cal1" },
      { name: "linear", appId: "connector_linear1" },
    ]);
    expect(connections.connected).toEqual(["github", "gmail", "google-calendar", "linear"]);
    expect(connections.needsLogin).toEqual([]);
    // Developer tools are never offered.
    expect(connections.availableApps).toEqual(["google-drive", "outlook-email"]);
  });

  it("installs an available app with codex plugin add and passes the sign-in link on", async () => {
    const { run, calls } = fakeCodex();
    const connections = new Connections({ mode: "inherit", exclude: [], run, codexHome: codexHome() });
    await connections.refresh(true);
    const urls: string[] = [];
    await connections.login("google-drive", (url) => urls.push(url));
    expect(calls).toContainEqual(["codex", "plugin", "add", "google-drive@openai-curated-remote"]);
    expect(urls).toEqual(["https://chatgpt.com/apps/link/google-drive"]);
  });

  it("turns on only the requested apps, with every other app off", async () => {
    expect(codexAppArgs([])).toEqual([]);
    const backend = new CodexCliBackend({
      apps: () => [
        { name: "gmail", appId: "connector_gmail1" },
        { name: "google-calendar", appId: "connector_cal1" },
      ],
    });
    const withCal = backend.args("/tmp/o", { system: "", prompt: "", timeoutMs: 1, connections: ["google-calendar"] }).join(" ");
    expect(withCal).toContain("--enable apps --enable plugins -c apps._default.enabled=false -c apps.connector_cal1.enabled=true");
    expect(withCal).not.toContain("connector_gmail1");
    expect(withCal).not.toContain("--disable apps");

    const none = backend.args("/tmp/o", { system: "", prompt: "", timeoutMs: 1, connections: [] }).join(" ");
    expect(none).toContain("--disable apps");
    expect(none).toContain("--disable plugins");
    expect(none).not.toContain("--enable apps");
  });

  it("routes email and calendar questions to Gmail and Google Calendar", () => {
    const all = ["gmail", "google-calendar", "google-drive", "granola"];
    expect(pickConnections(all, "any unread emails from Marcus?")).toEqual(["gmail"]);
    expect(pickConnections(all, "am I free tomorrow at 3?")).toEqual(["google-calendar"]);
    expect(pickConnections(all, "what meetings do I have this week")).toEqual(["google-calendar", "granola"]);
    expect(pickConnections(all, "google the best CRM")).toEqual([]);
  });

  it("shows what is available to connect in the prompt", () => {
    const { prompt, system } = buildPrompt({
      question: "find the pitch deck",
      askerName: "Kevin",
      channelName: "general",
      isThread: false,
      thread: [],
      recent: [],
      retrieved: [],
      teamUrl: "https://x.slack.com/",
      budget: 4000,
      connections: { connected: ["gmail"], needsLogin: [], available: ["google-drive", "outlook-email"] },
    });
    expect(prompt).toContain("Available to connect: google-drive, outlook-email");
    expect(system).toContain("if you connect Google Drive. Want me to?");
  });
});
