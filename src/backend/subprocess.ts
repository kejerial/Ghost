import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Called with each stdout and stderr chunk as it arrives. */
  onOutput?: (chunk: string) => void;
}

export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** Run a command, write `stdin`, and collect its output. Stops the process on timeout. */
export const runProcess: Runner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      options.onOutput?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      options.onOutput?.(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.on("error", () => {
      // The process can exit before it reads stdin. The close handler reports the result.
    });
    child.stdin.end(options.stdin);
  });

let sandboxDir: string | undefined;

/** An empty working directory. The CLI then finds no project files, CLAUDE.md, or AGENTS.md. */
export function modelSandboxDir(): string {
  sandboxDir ??= mkdtempSync(join(tmpdir(), "ghost-model-"));
  return sandboxDir;
}

/**
 * Environment variables that a model subprocess must not inherit.
 * - Ghost secrets: the child does not need them.
 * - Claude Code session variables: when Ghost starts inside a Claude Code session,
 *   these variables point the child CLI at the parent session and break its own login.
 */
const BLOCKED_ENV = [/^SLACK_/, /^GHOST_/, /^CLAUDECODE$/, /^CLAUDE_CODE_/, /^CLAUDE_AGENT_SDK/, /^CLAUDE_PID$/, /^USE_(STAGING|LOCAL)_OAUTH$/];

export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !BLOCKED_ENV.some((pattern) => pattern.test(key))));
}

export function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}
