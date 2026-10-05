import { describe, expect, it } from "vitest";
import { extractDirectives } from "../src/pipeline/directives.js";
import { pickConnections } from "../src/integrations/router.js";
import { CodexCliBackend, progressReader } from "../src/backend/codex.js";
import { claudeMcpConfig, codexMcpArgs, Connections, displayName, fromCodexList, mcpEnv } from "../src/integrations/mcp.js";
import { localTime } from "../src/pipeline/prompt.js";
import { Scheduler, nextCron, parseLocalTime } from "../src/schedule/scheduler.js";
import { FakeSlack, memoryStore, tempProfiles } from "./fakes.js";

describe("extractDirectives", () => {
  it("pulls out directives and removes them from the text", () => {
    const { text, directives } = extractDirectives(
      'Got it, I will remind you at 9am.\n<<remember: prefers short answers>>\n<<schedule: {"kind":"reminder","text":"Email the principal","at":"2026-10-06T09:00:00-04:00"}>>\n<<cancel: #4>>',
    );
    expect(text).toBe("Got it, I will remind you at 9am.");
    expect(directives).toEqual([
      { type: "remember", text: "prefers short answers" },
      { type: "schedule", spec: { kind: "reminder", text: "Email the principal", at: "2026-10-06T09:00:00-04:00", cron: undefined } },
      { type: "cancel", id: 4 },
    ]);
  });

  it("reports malformed schedules instead of throwing", () => {
    const { directives } = extractDirectives('<<schedule: {"kind":"reminder","text":"x"}>>');
    expect(directives[0]).toMatchObject({ type: "invalid", reason: "give exactly one of at or cron" });
  });
});

describe("Profiles", () => {
  it("keeps memories when the profile body is rewritten, and forgets by phrase", () => {
    const profiles = tempProfiles();
    profiles.remember("UK", "Kevin", "prefers short answers", new Date("2026-10-05T12:00:00Z"));
    profiles.remember("UK", "Kevin", "Lin pilot starts Nov 3", new Date("2026-10-05T12:00:00Z"));
    profiles.writeProfile("UK", "Kevin", "## Who they are\n- Founder at Snowfish");
    const text = profiles.read("UK")!;
    expect(text).toContain("# Kevin\n\n## Who they are\n- Founder at Snowfish");
    expect(text).toContain("- 2026-10-05: prefers short answers\n- 2026-10-05: Lin pilot starts Nov 3");
    expect(profiles.forget("UK", "SHORT answers")).toBe(1);
    expect(profiles.read("UK")).not.toContain("short answers");
    expect(profiles.read("UK")).toContain("Lin pilot");
  });

  it("rejects file names that are not Slack user IDs", () => {
    expect(() => tempProfiles().read("../../etc/passwd")).toThrow(/invalid user id/);
  });
});

describe("Scheduler", () => {
  const start = Date.parse("2026-10-05T12:00:00Z");
  function setup() {
    const slack = new FakeSlack();
    slack.addChannel("C1", "kevin");
    let now = start;
    const tasks: string[] = [];
    const scheduler = new Scheduler(memoryStore().db, slack, async (s) => {
      tasks.push(s.text);
      return "Here is your summary.";
    }, () => now);
    return { slack, scheduler, tasks, advance: (ms: number) => (now += ms) };
  }
  const who = { userId: "UK", channelId: "C1", tz: "America/New_York" };

  it("hands a one-time reminder to Slack's scheduler at the exact time", async () => {
    const { slack, scheduler } = setup();
    const at = "2026-10-06T09:00:00-04:00";
    await scheduler.create({ kind: "reminder", text: "Email <the> principal", at }, who);
    expect(slack.scheduled).toEqual([{ id: "Q1", channel: "C1", postAt: Date.parse(at) / 1000, text: "⏰ <@UK> Email &lt;the&gt; principal" }]);
  });

  it("keeps the next run of a repeating reminder queued in Slack", async () => {
    const { slack, scheduler, advance } = setup();
    await scheduler.create({ kind: "reminder", text: "Standup", cron: "0 9 * * 1-5" }, who);
    expect(slack.scheduled[0]!.postAt).toBe(Date.parse("2026-10-05T13:00:00Z") / 1000); // Mon 9am ET
    advance(2 * 60 * 60 * 1000); // past Monday 9am: Slack posted it
    await scheduler.tick();
    expect(slack.scheduled[1]!.postAt).toBe(Date.parse("2026-10-06T13:00:00Z") / 1000); // Tue 9am ET
  });

  it("cancels only the owner's schedule and deletes it from Slack", async () => {
    const { slack, scheduler } = setup();
    const s = await scheduler.create({ kind: "reminder", text: "x", at: "2026-10-07T09:00:00-04:00" }, who);
    expect(await scheduler.cancel("USOMEONE", s.id)).toBe(false);
    expect(await scheduler.cancel("UK", s.id)).toBe(true);
    expect(slack.scheduled[0]!.deleted).toBe(true);
    expect(scheduler.list("UK")).toHaveLength(0);
  });

  it("runs a due task, posts its result, and marks it late after sleep", async () => {
    const { slack, scheduler, tasks, advance } = setup();
    await scheduler.create({ kind: "task", text: "Summarize #sales", at: "2026-10-05T12:30:00Z" }, who);
    await scheduler.tick();
    expect(tasks).toHaveLength(0);
    advance(60 * 60 * 1000); // the Mac slept through 12:30
    await scheduler.tick();
    expect(tasks).toEqual(["Summarize #sales"]);
    expect(slack.posts[0]!.text).toMatch(/^🗓️ \*Summarize #sales\* _\(late by 30 min; this Mac was asleep\)_\n\nHere is your summary\.$/);
    await scheduler.tick();
    expect(tasks).toHaveLength(1); // one-time task does not repeat
  });

  it("refuses times in the past", async () => {
    const { scheduler } = setup();
    await expect(scheduler.create({ kind: "reminder", text: "x", at: "2026-10-01T09:00:00Z" }, who)).rejects.toThrow(/past/);
  });

  it("computes cron runs in the user's timezone", () => {
    expect(new Date(nextCron("0 9 * * *", "Asia/Seoul", start)).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("connections (MCP)", () => {
  const list = [
    { name: "github", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret" }, env_vars: [] } },
    { name: "linear", enabled: true, transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp", bearer_token_env_var: null } },
    { name: "node_repl", enabled: true, transport: { type: "stdio", command: "node_repl" } },
    { name: "cua_repl", enabled: true, transport: { type: "stdio", command: "node" } },
    { name: "vercel", enabled: false, transport: { type: "streamable_http", url: "https://mcp.vercel.com" } },
    { name: "figma", enabled: true, auth_status: "not_logged_in", transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" } },
  ];

  it("inherits enabled Codex connections but never ones that control the Mac", () => {
    expect(fromCodexList(list).map((s) => s.name)).toEqual(["github", "linear"]);
    expect(fromCodexList(list, ["linear"]).map((s) => s.name)).toEqual(["github"]);
  });

  it("keeps secrets out of argv for both CLIs", () => {
    const servers = fromCodexList(list);
    const codex = codexMcpArgs(servers);
    expect(codex).toContain('mcp_servers.linear.url="https://mcp.linear.app/mcp"');
    expect(codex).toContain('mcp_servers.github.env_vars=["GITHUB_PERSONAL_ACCESS_TOKEN"]');
    expect(codex.join(" ")).not.toContain("secret");
    expect(claudeMcpConfig(servers)).not.toContain("secret");
    expect(claudeMcpConfig(servers)).toContain('"GITHUB_PERSONAL_ACCESS_TOKEN":"${GITHUB_PERSONAL_ACCESS_TOKEN}"');
    expect(mcpEnv(servers)).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "secret" });
  });
});

describe("localTime", () => {
  it("shows the local time with its UTC offset", () => {
    expect(localTime(new Date("2026-10-05T20:55:00Z"), "America/New_York")).toBe("Mon, Oct 5, 2026, 4:55 PM (UTC-04:00)");
    expect(localTime(new Date("2026-10-05T20:55:00Z"), "UTC")).toBe("Mon, Oct 5, 2026, 8:55 PM (UTC+00:00)");
  });
});

describe("Connections login", () => {
  function fakeCodex() {
    let linearLoggedIn = false;
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "gh") return { stdout: "", stderr: "", code: 1, timedOut: false };
      if (args[1] === "login") {
        linearLoggedIn = true;
        return { stdout: "", stderr: "", code: 0, timedOut: false };
      }
      const list = [
        { name: "linear", enabled: true, auth_status: linearLoggedIn ? "o_auth" : "not_logged_in", transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" } },
        { name: "railway", enabled: true, auth_status: "unsupported", transport: { type: "stdio", command: "railway", args: ["mcp"] } },
      ];
      return { stdout: JSON.stringify(list), stderr: "", code: 0, timedOut: false };
    };
    return { run, calls };
  }

  it("reports logged-out connections, runs codex mcp login, and picks up the new connection", async () => {
    const { run, calls } = fakeCodex();
    const connections = new Connections({ mode: "inherit", exclude: [], run });
    await connections.refresh(true);
    expect(connections.servers.map((s) => s.name)).toEqual(["railway"]);
    expect(connections.needsLogin).toEqual(["linear"]);

    expect(await connections.login("linear")).toBe(true);
    expect(calls).toContainEqual(["codex", "mcp", "login", "linear"]);
    expect(connections.servers.map((s) => s.name)).toEqual(["linear", "railway"]);
    expect(connections.needsLogin).toEqual([]);
  });

  it("refuses to log in to stdio or unknown connections", async () => {
    const connections = new Connections({ mode: "inherit", exclude: [], run: fakeCodex().run });
    await expect(connections.login("railway")).rejects.toThrow(/is not a connection that supports login/);
    await expect(connections.login("nope")).rejects.toThrow(/is not a connection that supports login/);
  });

  it("parses the connect directive", () => {
    expect(extractDirectives("Opening it now.\n<<connect: linear>>").directives).toEqual([{ type: "connect", name: "linear" }]);
    expect(extractDirectives("<<connect: ../evil>>").directives[0]).toMatchObject({ type: "invalid" });
  });
});

describe("review fixes", () => {
  const who = { userId: "UK", channelId: "C1", tz: "America/New_York" };
  const start = Date.parse("2026-10-05T12:00:00Z");

  class SlowSlack extends FakeSlack {
    fail = false;
    override async scheduleMessage(channel: string, postAt: number, text: string): Promise<string> {
      await new Promise((r) => setTimeout(r, 20));
      if (this.fail) throw new Error("ratelimited");
      return super.scheduleMessage(channel, postAt, text);
    }
  }

  it("1: a tick during create() does not queue the reminder twice", async () => {
    const slack = new SlowSlack();
    const scheduler = new Scheduler(memoryStore().db, slack, async () => "", () => start);
    await Promise.all([
      scheduler.create({ kind: "reminder", text: "x", at: "2026-10-06T09:00" }, who),
      new Promise((r) => setTimeout(r, 5)).then(() => scheduler.tick()),
    ]);
    expect(slack.scheduled).toHaveLength(1);
  });

  it("2: a failed Slack schedule leaves no row behind", async () => {
    const slack = new SlowSlack();
    slack.fail = true;
    const scheduler = new Scheduler(memoryStore().db, slack, async () => "", () => start);
    await expect(scheduler.create({ kind: "reminder", text: "x", at: "2026-10-06T09:00" }, who)).rejects.toThrow("ratelimited");
    slack.fail = false;
    await scheduler.tick();
    expect(slack.scheduled).toHaveLength(0);
    expect(scheduler.list("UK")).toHaveLength(0);
  });

  it("3: a task cancelled while an earlier task runs does not run", async () => {
    const slack = new FakeSlack();
    slack.addChannel("C1", "kevin");
    let now = start;
    const ran: string[] = [];
    let bId = 0;
    const scheduler: Scheduler = new Scheduler(memoryStore().db, slack, async (s) => {
      ran.push(s.text);
      if (s.text === "A") await scheduler.cancel("UK", bId);
      return "ok";
    }, () => now);
    await scheduler.create({ kind: "task", text: "A", at: "2026-10-05T08:01" }, who);
    bId = (await scheduler.create({ kind: "task", text: "B", at: "2026-10-05T08:02" }, who)).id;
    now += 10 * 60_000;
    await scheduler.tick();
    expect(ran).toEqual(["A"]);
  });

  it("4: local times keep their hour across a DST change", async () => {
    const slack = new FakeSlack();
    const scheduler = new Scheduler(memoryStore().db, slack, async () => "", () => start);
    await scheduler.create({ kind: "reminder", text: "x", at: "2026-11-10T09:00" }, who); // EST after Nov 1
    expect(slack.scheduled[0]!.postAt).toBe(Date.parse("2026-11-10T14:00:00Z") / 1000);
    expect(parseLocalTime("2026-10-06T09:00", "America/New_York")).toBe(Date.parse("2026-10-06T13:00:00Z"));
    expect(parseLocalTime("2026-10-06T09:00:00-04:00", "Asia/Seoul")).toBe(Date.parse("2026-10-06T13:00:00Z"));
    expect(parseLocalTime("next tuesday", "UTC")).toBeNaN();
  });

  it("6: the prompt copy of a long profile keeps the newest memories", () => {
    const profiles = tempProfiles();
    profiles.writeProfile("UK", "Kevin", "x".repeat(4000));
    for (let i = 0; i < 80; i++) profiles.remember("UK", "Kevin", `memory number ${i} with some extra words`);
    const text = profiles.read("UK")!;
    expect(text).toContain("memory number 79");
    expect(text.length).toBeLessThanOrEqual(6100);
  });

  it("7: forget matches memory text only, and ignores very short phrases", () => {
    const profiles = tempProfiles();
    profiles.remember("UK", "Kevin", "likes tea", new Date("2026-10-05T12:00:00Z"));
    profiles.remember("UK", "Kevin", "likes coffee", new Date("2026-10-05T12:00:00Z"));
    expect(profiles.forget("UK", "10-05")).toBe(0);
    expect(profiles.forget("UK", "li")).toBe(0);
    expect(profiles.forget("UK", "coffee")).toBe(1);
    expect(profiles.read("UK")).toContain("likes tea");
  });

  it("8: '>>' inside a directive value does not cut it short", () => {
    const { text, directives } = extractDirectives('Set.\n<<schedule: {"kind":"task","text":"check a >> b","at":"2026-10-06T09:00"}>>');
    expect(text).toBe("Set.");
    expect(directives[0]).toMatchObject({ type: "schedule", spec: { text: "check a >> b" } });
  });

  it("9: connection env vars cannot override the CLI's env or each other", () => {
    const env = mcpEnv([
      { name: "a", type: "stdio", command: "a", env: { API_KEY: "one", PATH: "/evil" } },
      { name: "b", type: "stdio", command: "b", env: { API_KEY: "two" } },
    ]);
    expect(env).toEqual({ API_KEY: "one" });
  });

  it("10: the Claude config skips Codex OAuth servers it cannot authenticate", () => {
    const config = JSON.parse(claudeMcpConfig([{ name: "apollo", type: "http", url: "https://mcp.apollo.io/mcp" }]));
    expect(config.mcpServers).toEqual({});
  });
});

describe("displayName", () => {
  it("makes connection names readable", () => {
    expect(["granola", "figma-remote-mcp", "railway-mcp-server", "linear-kevinjeon", "context7"].map(displayName)).toEqual([
      "Granola",
      "Figma",
      "Railway",
      "Linear Kevinjeon",
      "Context7",
    ]);
  });
});

describe("speed: connection routing and progress", () => {
  const all = ["apollo", "github", "granola", "railway-mcp-server", "linear-kevinjeon"];

  it("attaches only the connections a question needs", () => {
    expect(pickConnections(all, "what were my last 3 meetings about?")).toEqual(["granola"]);
    expect(pickConnections(all, "any open PRs on the Ghost repo?")).toEqual(["github"]);
    expect(pickConnections(all, "find 20 prospects in NYC")).toEqual(["apollo"]);
    expect(pickConnections(all, "is prod deployed?")).toEqual(["railway-mcp-server"]);
    expect(pickConnections(all, "check my linear tickets")).toEqual(["linear-kevinjeon"]);
    expect(pickConnections(all, "what's a good cold email subject line?")).toEqual([]);
  });

  it("keeps a connection for follow-ups through recent conversation text", () => {
    expect(pickConnections(all, "and the second one?\nYour last Granola meeting was the Lin sync")).toEqual(["granola"]);
  });

  it("reads web searches and connection calls from Codex events, across chunk boundaries", () => {
    const steps: unknown[] = [];
    const read = progressReader((s) => steps.push(s));
    read('{"type":"item.started","item":{"type":"web_search"}}\n{"type":"item.sta');
    read('rted","item":{"type":"mcp_tool_call","server":"granola","tool":"list_meetings"}}\n');
    read('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\nnot json\n');
    expect(steps).toEqual([{ kind: "web" }, { kind: "connection", name: "granola" }]);
  });

  it("streams JSON and starts only the requested connections", () => {
    const backend = new CodexCliBackend({
      mcpServers: () => [
        { name: "granola", type: "http", url: "https://mcp.granola.ai/mcp" },
        { name: "apollo", type: "http", url: "https://mcp.apollo.io/mcp" },
      ],
    });
    const args = backend.args("/tmp/out", { system: "", prompt: "", timeoutMs: 1, connections: ["granola"] }).join(" ");
    expect(args).toContain("--json");
    expect(args).toContain("mcp_servers.granola.url");
    expect(args).not.toContain("apollo");
  });
});
