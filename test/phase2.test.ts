import { describe, expect, it } from "vitest";
import { extractDirectives } from "../src/pipeline/directives.js";
import { claudeMcpConfig, codexMcpArgs, Connections, fromCodexList, mcpEnv } from "../src/integrations/mcp.js";
import { localTime } from "../src/pipeline/prompt.js";
import { Scheduler, nextCron } from "../src/schedule/scheduler.js";
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
