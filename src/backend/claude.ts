import { BackendError, type CompletionRequest, type ModelBackend } from "./types.js";
import { claudeMcpConfig, mcpEnv, type McpServer } from "../integrations/mcp.js";
import { childEnv, modelSandboxDir, runProcess, tail, type Runner } from "./subprocess.js";

/** Calls the logged-in `claude` CLI in print mode. Uses the Claude subscription, not API billing. */
export class ClaudeCliBackend implements ModelBackend {
  readonly name = "claude";

  constructor(
    private readonly options: { model?: string; command?: string; run?: Runner; mcpServers?: () => McpServer[] } = {},
  ) {}

  args(system: string): string[] {
    const servers = this.options.mcpServers?.() ?? [];
    const args = [
      "-p",
      "--output-format", "json",
      // Web search, web fetch, and Ghost's connections only: no shell, no file access.
      "--tools", "WebSearch,WebFetch",
      "--allowedTools", ["WebSearch", "WebFetch", ...servers.map((s) => `mcp__${s.name}`)].join(","),
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      // Do not load user/project settings (hooks, permissions, plugins).
      "--setting-sources", "",
      "--system-prompt", system,
    ];
    if (servers.length) args.push("--mcp-config", claudeMcpConfig(servers));
    if (this.options.model) args.push("--model", this.options.model);
    return args;
  }

  async complete(request: CompletionRequest): Promise<string> {
    const run = this.options.run ?? runProcess;
    const result = await run(this.options.command ?? "claude", this.args(request.system), {
      stdin: request.prompt,
      cwd: modelSandboxDir(),
      env: { ...childEnv(), ...mcpEnv(this.options.mcpServers?.() ?? []) },
      timeoutMs: request.timeoutMs,
    });
    if (result.timedOut) throw new BackendError(`claude timed out after ${request.timeoutMs / 1000}s`);

    let parsed: { is_error?: boolean; result?: string; subtype?: string } | undefined;
    try {
      parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      parsed = undefined;
    }
    if (!parsed || result.code !== 0 || parsed.is_error || typeof parsed.result !== "string") {
      const reason = parsed?.result ?? tail(result.stderr || result.stdout);
      throw new BackendError(`claude failed: ${reason}`, tail(result.stderr));
    }
    return parsed.result.trim();
  }

  async check(): Promise<string> {
    const run = this.options.run ?? runProcess;
    const result = await run(this.options.command ?? "claude", ["--version"], {
      stdin: "",
      cwd: modelSandboxDir(),
      env: childEnv(),
      timeoutMs: 15000,
    });
    if (result.code !== 0) throw new BackendError(`claude --version failed: ${tail(result.stderr)}`);
    return result.stdout.trim();
  }
}
