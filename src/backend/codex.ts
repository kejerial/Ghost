import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError, type CompletionRequest, type ModelBackend } from "./types.js";
import { codexMcpArgs, mcpEnv, type McpServer } from "../integrations/mcp.js";
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
    } = {},
  ) {}

  args(outputFile: string): string[] {
    const args = [
      "exec",
      // Skip ~/.codex/config.toml: no MCP servers, hooks, or profiles. Auth still comes from CODEX_HOME.
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color", "never",
      "-s", "read-only",
      // Live web search is the only tool left on. Shell, files, and apps stay off (see DISABLED_FEATURES).
      "-c", "web_search=\"live\"",
      "-c", `model_reasoning_effort="${this.options.reasoningEffort ?? "medium"}"`,
      "-C", modelSandboxDir(),
      "-o", outputFile,
    ];
    for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
    args.push(...codexMcpArgs(this.options.mcpServers?.() ?? []));
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
      const result = await run(this.options.command ?? "codex", this.args(outputFile), {
        stdin,
        cwd: modelSandboxDir(),
        env: { ...childEnv(), ...mcpEnv(this.options.mcpServers?.() ?? []) },
        timeoutMs: request.timeoutMs,
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
