import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ClaudeCliBackend } from "../src/backend/claude.js";
import { CodexCliBackend } from "../src/backend/codex.js";
import { OpenAICompatibleBackend } from "../src/backend/openai-compatible.js";
import { childEnv, type RunOptions, type RunResult } from "../src/backend/subprocess.js";

const request = { system: "SYS", prompt: "PROMPT with [S1]", timeoutMs: 5000 };

function recorder(result: Partial<RunResult>, effect?: (args: string[]) => Promise<void>) {
  const calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
  const run = async (command: string, args: string[], options: RunOptions): Promise<RunResult> => {
    calls.push({ command, args, options });
    await effect?.(args);
    return { stdout: "", stderr: "", code: 0, timedOut: false, ...result };
  };
  return { calls, run };
}

describe("childEnv", () => {
  it("removes Slack, Ghost, and parent Claude Code session variables", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/h",
      SLACK_BOT_TOKEN: "xoxb",
      GHOST_PROXY_API_KEY: "k",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CONFIG_DIR: "/c",
      ANTHROPIC_BASE_URL: "http://proxy",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_BASE_URL: "http://proxy" });
  });
});

describe("ClaudeCliBackend", () => {
  it("runs with no tools or settings, sends the prompt on stdin, and parses the JSON result", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ type: "result", is_error: false, result: " Answer [S1] " }) });
    const backend = new ClaudeCliBackend({ run, model: "sonnet" });
    await expect(backend.complete(request)).resolves.toBe("Answer [S1]");
    const { command, args, options } = calls[0]!;
    expect(command).toBe("claude");
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args.join(" ")).not.toContain("PROMPT");
    expect(options.stdin).toBe(request.prompt);
    expect(Object.keys(options.env).some((k) => k.startsWith("SLACK_"))).toBe(false);
  });

  it("reports CLI errors", async () => {
    const { run } = recorder({ code: 1, stdout: JSON.stringify({ is_error: true, result: "401 OAuth access token is invalid" }) });
    await expect(new ClaudeCliBackend({ run }).complete(request)).rejects.toThrow(/401/);
  });

  it("reports timeouts", async () => {
    const { run } = recorder({ timedOut: true, code: null });
    await expect(new ClaudeCliBackend({ run }).complete(request)).rejects.toThrow(/timed out/);
  });
});

describe("CodexCliBackend", () => {
  it("disables every tool feature, skips user config, and reads the last message file", async () => {
    const { calls, run } = recorder({}, async (args) => {
      await writeFile(args[args.indexOf("-o") + 1]!, "Codex answer\n");
    });
    const backend = new CodexCliBackend({ run });
    await expect(backend.complete(request)).resolves.toBe("Codex answer");
    const { args, options } = calls[0]!;
    expect(args.slice(0, 2)).toEqual(["exec", "--ignore-user-config"]);
    for (const feature of ["shell_tool", "unified_exec", "view_image", "apps", "plugins"]) {
      expect(args).toContain(feature);
    }
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args).toContain('web_search="live"');
    expect(args.at(-1)).toBe("-");
    expect(options.stdin).toContain("<instructions>\nSYS\n</instructions>");
    expect(options.stdin).toContain("PROMPT with [S1]");
  });

  it("fails when Codex writes no answer", async () => {
    const { run } = recorder({ code: 1, stderr: "not logged in" });
    await expect(new CodexCliBackend({ run }).complete(request)).rejects.toThrow(/not logged in/);
  });
});

describe("OpenAICompatibleBackend", () => {
  it("posts chat messages and returns the first choice", async () => {
    let body: unknown;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Proxy answer" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const backend = new OpenAICompatibleBackend({ baseUrl: "http://127.0.0.1:1/v1/", model: "m", fetch: fakeFetch });
    await expect(backend.complete(request)).resolves.toBe("Proxy answer");
    expect(body).toEqual({
      model: "m",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "PROMPT with [S1]" },
      ],
    });
  });
});
