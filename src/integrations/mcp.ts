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
 * Log in with `codex mcp login <name>`, then restart Ghost.
 */
export function fromCodexList(entries: CodexMcpEntry[], exclude: string[] = []): McpServer[] {
  const blocked = new Set([...LOCAL_CONTROL_SERVERS, ...exclude]);
  const servers: McpServer[] = [];
  for (const entry of entries) {
    if (!entry.enabled || blocked.has(entry.name) || entry.auth_status === "not_logged_in") continue;
    if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
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

/**
 * Load the connections Ghost can use:
 * 1. Every connection configured in your Codex CLI, minus local-control ones.
 * 2. GitHub (read-only), through your `gh` login, if Codex has no "github" connection.
 */
export async function loadMcpServers(options: { mode: "inherit" | "off"; exclude: string[]; run?: Runner }): Promise<McpServer[]> {
  if (options.mode === "off") return [];
  const run = options.run ?? runProcess;
  const exec = (command: string, args: string[]) =>
    run(command, args, { stdin: "", cwd: modelSandboxDir(), env: childEnv(), timeoutMs: 20_000 }).catch(() => undefined);

  const servers: McpServer[] = [];
  const codex = await exec("codex", ["mcp", "list", "--json"]);
  if (codex?.code === 0) {
    try {
      servers.push(...fromCodexList(JSON.parse(codex.stdout) as CodexMcpEntry[], options.exclude));
    } catch (error) {
      log.warn("could not read codex mcp list", errorFields(error));
    }
  }

  if (!servers.some((s) => s.name === "github") && !options.exclude.includes("github")) {
    const gh = await exec("gh", ["auth", "token"]);
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
  log.info("connections loaded", { connections: servers.map((s) => s.name) });
  return servers;
}

/** Env values that every model call needs for its connections. */
export function mcpEnv(servers: McpServer[]): Record<string, string> {
  return Object.assign({}, ...servers.map((s) => s.env ?? {}));
}

const toml = (value: unknown) => JSON.stringify(value);

/** `codex exec -c` flags that define the servers. Secret values stay in the environment. */
export function codexMcpArgs(servers: McpServer[]): string[] {
  const args: string[] = [];
  const set = (name: string, key: string, value: unknown) => args.push("-c", `mcp_servers.${name}.${key}=${toml(value)}`);
  for (const s of servers) {
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

/** `claude --mcp-config` JSON. Secrets use ${VAR} expansion from the environment. */
export function claudeMcpConfig(servers: McpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
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
