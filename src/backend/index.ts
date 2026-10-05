import type { Config } from "../config.js";
import { ClaudeCliBackend } from "./claude.js";
import { CodexCliBackend } from "./codex.js";
import { OpenAICompatibleBackend } from "./openai-compatible.js";
import type { McpServer } from "../integrations/mcp.js";
import type { ModelBackend } from "./types.js";

export type { ModelBackend } from "./types.js";

export function createBackend(
  config: Pick<Config, "backend" | "model" | "proxyUrl" | "proxyApiKey">,
  mcpServers: () => McpServer[] = () => [],
): ModelBackend {
  switch (config.backend) {
    case "claude":
      return new ClaudeCliBackend({ model: config.model, mcpServers });
    case "codex":
      return new CodexCliBackend({ model: config.model, mcpServers });
    case "openai-compatible":
      return new OpenAICompatibleBackend({ baseUrl: config.proxyUrl, apiKey: config.proxyApiKey, model: config.model });
  }
}
