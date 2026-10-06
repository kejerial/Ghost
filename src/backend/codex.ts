import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError, type CompletionRequest, type ModelBackend, type ProgressStep } from "./types.js";
import { codexMcpArgs, mcpEnv, type McpServer } from "../integrations/mcp.js";
import { codexAppArgs, type AppConnection } from "../integrations/apps.js";
import { childEnv, modelSandboxDir, runProcess, tail, type Runner } from "./subprocess.js";

/**
 * Features that give the Codex agent shell, file, app, or agent tools. Ghost turns them off.
 * code_mode_host stays on: in codex-cli 0.154.0 live web search runs through it.
 * Tested: web search returns live URLs, and a file-read probe still returns "FILE_BLOCKED".
 */
const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "multi_agent",
  "hooks",
  "image_generation",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "goals",
  "sleep_tool",
];

/** Calls the logged-in `codex exec`. Uses the ChatGPT subscription, not API billing. */
export class CodexCliBackend implements ModelBackend {
  readonly name = "codex";

  constructor(
    private readonly options: {
      model?: string;
      command?: string;
      run?: Runner;
      reasoningEffort?: string;
      /** The current connections; read on every call so new logins apply at once. */
      mcpServers?: () => McpServer[];
      /** Installed ChatGPT apps (Gmail, Google Calendar, …); read on every call. */
      apps?: () => AppConnection[];
    } = {},
  ) {}

  private servers(request?: CompletionRequest): McpServer[] {
    const all = this.options.mcpServers?.() ?? [];
    return request?.connections ? all.filter((s) => request.connections!.includes(s.name)) : all;
  }

  private apps(request?: CompletionRequest): AppConnection[] {
    const all = this.options.apps?.() ?? [];
    return request?.connections ? all.filter((a) => request.connections!.includes(a.name)) : all;
  }

  args(outputFile: string, request?: CompletionRequest): string[] {
    const args = [
      "exec",
      // Skip ~/.codex/config.toml: no MCP servers, hooks, or profiles. Auth still comes from CODEX_HOME.
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color", "never",
      "--json", // stream events, so Ghost can show what the model is doing
      "-s", "read-only",
      // Live web search is the only tool left on. Shell, files, and apps stay off (see DISABLED_FEATURES).
      "-c", "web_search=\"live\"",
      "-c", `model_reasoning_effort="${this.options.reasoningEffort ?? "medium"}"`,
      "-C", modelSandboxDir(),
      "-o", outputFile,
    ];
    for (const image of request?.images ?? []) args.push("--image", image);
    // Apps stay off unless this question needs one. Then only that app is on (see codexAppArgs).
    const apps = this.apps(request);
    for (const feature of DISABLED_FEATURES) {
      if (apps.length && (feature === "apps" || feature === "plugins")) continue;
      args.push("--disable", feature);
    }
    args.push(...codexMcpArgs(this.servers(request)));
    args.push(...codexAppArgs(apps));
    if (this.options.model) args.push("-m", this.options.model);
    args.push("-"); // Read the prompt from stdin.
    return args;
  }

  async complete(request: CompletionRequest): Promise<string> {
    const run = this.options.run ?? runProcess;
    const dir = await mkdtemp(join(tmpdir(), "ghost-codex-"));
    const outputFile = join(dir, "last-message.txt");
    try {
      // codex exec has no system-prompt flag, so the instructions lead the prompt.
      const stdin = `<instructions>\n${request.system}\n</instructions>\n\n${request.prompt}`;
      const result = await run(this.options.command ?? "codex", this.args(outputFile, request), {
        stdin,
        cwd: modelSandboxDir(),
        env: { ...childEnv(), ...mcpEnv(this.servers(request)) },
        timeoutMs: request.timeoutMs,
        onOutput: request.onProgress ? progressReader(request.onProgress) : undefined,
      });
      if (result.timedOut) throw new BackendError(`codex timed out after ${request.timeoutMs / 1000}s`);
      const answer = await readFile(outputFile, "utf8").catch(() => "");
      if (result.code !== 0 || !answer.trim()) {
        throw new BackendError(`codex failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}`);
      }
      return answer.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async check(): Promise<string> {
    const run = this.options.run ?? runProcess;
    const result = await run(this.options.command ?? "codex", ["--version"], {
      stdin: "",
      cwd: modelSandboxDir(),
      env: childEnv(),
      timeoutMs: 15000,
    });
    if (result.code !== 0) throw new BackendError(`codex --version failed: ${tail(result.stderr)}`);
    return result.stdout.trim();
  }
}

/** Turn Codex `--json` event lines into progress steps. Unknown events are ignored. */
export function progressReader(onProgress: (step: ProgressStep) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as { type?: string; item?: { type?: string; server?: string; server_name?: string } };
        if ((event.type !== "item.started" && event.type !== "item.completed") || !event.item) continue;
        const phase = event.type === "item.started" ? "started" : "done";
        if (event.item.type === "web_search") onProgress({ kind: "web", phase });
        const server = event.item.server ?? event.item.server_name;
        if (event.item.type?.includes("mcp") && server) onProgress({ kind: "connection", name: server, phase });
      } catch {
        // not an event line
      }
    }
  };
}
