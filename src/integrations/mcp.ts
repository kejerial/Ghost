import { errorFields, log } from "../log.js";
import { childEnv, modelSandboxDir, runProcess, type Runner } from "../backend/subprocess.js";

/** One MCP server (a connection such as GitHub, Linear, or Apollo) handed to the model CLI. */
export interface McpServer {
  name: string;
  type: "http" | "stdio";
  url?: string;
  /** Name of an env var that holds a bearer token (http only). */
  bearerEnvVar?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Env vars the server process needs. Values travel in the child environment, never in argv. */
  env?: Record<string, string>;
  /** Env var names to pass through from Ghost's environment. */
  envVars?: string[];
}

/**
 * Connections that control this Mac or run code. Ghost never hands these to the model,
 * because Slack messages written by other people could steer the model into using them.
 */
export const LOCAL_CONTROL_SERVERS = ["node_repl", "cua_repl", "messages", "computer-use", "codex_app", "playwright", "code-review"];

interface CodexMcpEntry {
  name: string;
  enabled: boolean;
  auth_status?: string;
  transport: {
    type: string;
    url?: string;
    bearer_token_env_var?: string | null;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
    env_vars?: string[];
    cwd?: string | null;
  };
}

/**
 * Convert `codex mcp list --json` output into servers. Skips disabled ones, local-control ones,
 * and OAuth connections you have not logged in to (they would fail on every call).
 */
export function fromCodexList(entries: CodexMcpEntry[], exclude: string[] = []): McpServer[] {
  const servers: McpServer[] = [];
  for (const entry of usable(entries, exclude)) {
    if (entry.auth_status === "not_logged_in") continue;
    const t = entry.transport;
    if (t.type === "streamable_http" && t.url) {
      servers.push({ name: entry.name, type: "http", url: t.url, bearerEnvVar: t.bearer_token_env_var ?? undefined });
    } else if (t.type === "stdio" && t.command) {
      servers.push({
        name: entry.name,
        type: "stdio",
        command: t.command,
        args: t.args ?? [],
        cwd: t.cwd ?? undefined,
        env: t.env ?? undefined,
        envVars: t.env_vars ?? [],
      });
    }
  }
  return servers;
}

/** Remote (OAuth-capable) connections: the ones `codex mcp login <name>` can sign in to. */
export function loginStatus(entries: CodexMcpEntry[], exclude: string[] = []): { loginable: string[]; needsLogin: string[] } {
  const remote = usable(entries, exclude).filter((e) => e.transport.type === "streamable_http");
  return {
    loginable: remote.map((e) => e.name),
    needsLogin: remote.filter((e) => e.auth_status === "not_logged_in").map((e) => e.name),
  };
}

function usable(entries: CodexMcpEntry[], exclude: string[]): CodexMcpEntry[] {
  const blocked = new Set([...LOCAL_CONTROL_SERVERS, ...exclude]);
  return entries.filter((e) => e.enabled && !blocked.has(e.name) && /^[A-Za-z0-9_-]+$/.test(e.name));
}

const REFRESH_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * The connections Ghost can use, kept current:
 * 1. Every connection configured in your Codex CLI, minus local-control and logged-out ones.
 * 2. GitHub (read-only) through your `gh` login, if Codex has no "github" connection.
 * It also knows which connections need a login, and can start one (`codex mcp login`).
 */
export class Connections {
  servers: McpServer[] = [];
  needsLogin: string[] = [];
  private loginable: string[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | undefined;

  constructor(private readonly options: { mode: "inherit" | "off"; exclude: string[]; run?: Runner }) {}

  /** Reload from the Codex CLI. Without `force`, at most every 5 minutes. */
  refresh(force = false): Promise<void> {
    if (this.options.mode === "off") return Promise.resolve();
    if (!force && Date.now() - this.loadedAt < REFRESH_MS) return Promise.resolve();
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  /**
   * Run `codex mcp login`, which opens the sign-in page in the browser on this Mac.
   * `onUrl` receives the sign-in link as soon as Codex prints it, so Ghost can also post it.
   * Resolves when the login finishes or times out (5 minutes).
   */
  async login(name: string, onUrl?: (url: string) => void, onSignedIn?: () => void): Promise<boolean> {
    await this.refresh();
    if (!this.loginable.includes(name)) throw new Error(`"${name}" is not a connection that supports login`);
    let seen = false;
    const onOutput = (chunk: string) => {
      const url = /https:\/\/[^\s"'<>]+/.exec(chunk)?.[0];
      if (url && !seen) {
        seen = true;
        onUrl?.(url);
      }
    };
    const run = this.options.run ?? runProcess;
    const result = await run("codex", ["mcp", "login", name], {
      stdin: "",
      cwd: modelSandboxDir(),
      env: childEnv(),
      timeoutMs: LOGIN_TIMEOUT_MS,
      onOutput,
    }).catch(() => undefined);
    if (result?.code === 0) onSignedIn?.(); // before the reload, so the user hears back at once
    await this.refresh(true);
    return result?.code === 0 && this.servers.some((s) => s.name === name);
  }

  private exec(command: string, args: string[], timeoutMs = 20_000) {
    const run = this.options.run ?? runProcess;
    return run(command, args, { stdin: "", cwd: modelSandboxDir(), env: childEnv(), timeoutMs }).catch(() => undefined);
  }

  private async load(): Promise<void> {
    const servers: McpServer[] = [];
    let status = { loginable: [] as string[], needsLogin: [] as string[] };
    const codex = await this.exec("codex", ["mcp", "list", "--json"]);
    if (codex?.code === 0) {
      try {
        const entries = JSON.parse(codex.stdout) as CodexMcpEntry[];
        servers.push(...fromCodexList(entries, this.options.exclude));
        status = loginStatus(entries, this.options.exclude);
      } catch (error) {
        log.warn("could not read codex mcp list", errorFields(error));
      }
    }
    if (!servers.some((s) => s.name === "github") && !this.options.exclude.includes("github")) {
      const gh = await this.exec("gh", ["auth", "token"]);
      const token = gh?.code === 0 ? gh.stdout.trim() : "";
      if (token) {
        servers.push({
          name: "github",
          type: "http",
          url: "https://api.githubcopilot.com/mcp/readonly",
          bearerEnvVar: "GITHUB_MCP_TOKEN",
          env: { GITHUB_MCP_TOKEN: token },
        });
      }
    }
    const changed = servers.map((s) => s.name).join() !== this.servers.map((s) => s.name).join();
    this.servers = servers;
    this.loginable = status.loginable;
    this.needsLogin = status.needsLogin;
    this.loadedAt = Date.now();
    if (changed) log.info("connections loaded", { connections: servers.map((s) => s.name), needsLogin: status.needsLogin });
  }
}

/** A readable name for a connection: "figma-remote-mcp" → "Figma", "linear" → "Linear". */
export function displayName(name: string): string {
  const words = name
    .split(/[-_]/)
    .filter((w) => w && !["mcp", "remote", "server"].includes(w.toLowerCase()));
  const pretty = (words.length ? words : [name]).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  return pretty;
}

/** Env values that every model call needs for its connections. */
export function mcpEnv(servers: McpServer[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of servers) {
    for (const [key, value] of Object.entries(s.env ?? {})) {
      // The model CLI shares this environment: never let a connection change it, or another connection's secret.
      if (PROTECTED_ENV.has(key)) continue;
      if (key in env && env[key] !== value) {
        log.warn("connection env var conflict; keeping the first value", { key, server: s.name });
        continue;
      }
      env[key] = value;
    }
  }
  return env;
}

const PROTECTED_ENV = new Set(["PATH", "HOME", "USER", "SHELL", "TMPDIR", "CODEX_HOME", "NODE_OPTIONS"]);

const toml = (value: unknown) => JSON.stringify(value);

/** `codex exec -c` flags that define the servers. Secret values stay in the environment. */
export function codexMcpArgs(servers: McpServer[]): string[] {
  const args: string[] = [];
  const set = (name: string, key: string, value: unknown) => args.push("-c", `mcp_servers.${name}.${key}=${toml(value)}`);
  for (const s of servers) {
    // `codex exec` cannot show approval prompts (its approval policy is fixed to "never"), so a tool
    // that asks for approval would always be refused. Approve connection tools up front; the system
    // prompt limits changes to what the asker explicitly requests.
    set(s.name, "default_tools_approval_mode", "approve");
    if (s.type === "http") {
      set(s.name, "url", s.url);
      if (s.bearerEnvVar) set(s.name, "bearer_token_env_var", s.bearerEnvVar);
    } else {
      set(s.name, "command", s.command);
      set(s.name, "args", s.args ?? []);
      if (s.cwd) set(s.name, "cwd", s.cwd);
      const names = [...new Set([...(s.envVars ?? []), ...Object.keys(s.env ?? {})])];
      if (names.length) set(s.name, "env_vars", names);
    }
  }
  return args;
}

/** `claude --mcp-config` JSON. Secrets use ${VAR} expansion from the environment. Skips Codex OAuth servers. */
export function claudeMcpConfig(servers: McpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    // Codex OAuth logins live in the Codex credential store; Claude cannot use them.
    if (s.type === "http" && !s.bearerEnvVar) continue;
    if (s.type === "http") {
      mcpServers[s.name] = {
        type: "http",
        url: s.url,
        ...(s.bearerEnvVar ? { headers: { Authorization: `Bearer \${${s.bearerEnvVar}}` } } : {}),
      };
    } else {
      const names = [...new Set([...(s.envVars ?? []), ...Object.keys(s.env ?? {})])];
      mcpServers[s.name] = {
        command: s.command,
        args: s.args ?? [],
        ...(names.length ? { env: Object.fromEntries(names.map((n) => [n, `\${${n}}`])) } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers });
}
