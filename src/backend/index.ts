import type { Config } from "../config.js";
import { ClaudeCliBackend } from "./claude.js";
import { CodexCliBackend } from "./codex.js";
import { OpenAICompatibleBackend } from "./openai-compatible.js";
import type { ModelBackend } from "./types.js";

export type { ModelBackend } from "./types.js";

export function createBackend(config: Pick<Config, "backend" | "model" | "proxyUrl" | "proxyApiKey">): ModelBackend {
  switch (config.backend) {
    case "claude":
      return new ClaudeCliBackend({ model: config.model });
    case "codex":
      return new CodexCliBackend({ model: config.model });
    case "openai-compatible":
      return new OpenAICompatibleBackend({ baseUrl: config.proxyUrl, apiKey: config.proxyApiKey, model: config.model });
  }
}
