export interface CompletionRequest {
  /** Stable instructions: persona, citation rules, output format. */
  system: string;
  /** The packed context and the question. Contains untrusted Slack text. */
  prompt: string;
  timeoutMs: number;
  /** Connection names to attach to this call. Undefined attaches all of them. */
  connections?: string[];
  /** Called as the model works: each web search or connection tool call. */
  onProgress?: (step: ProgressStep) => void;
  /** Local image files to show the model (JPEG). Backends without image input ignore them. */
  images?: string[];
}

export type ProgressStep = ({ kind: "web" } | { kind: "connection"; name: string }) & {
  /** "done" when the step finished. Steps can overlap: Codex may run several tool calls at once. */
  phase?: "started" | "done";
};

/**
 * One model call. Implementations: the `claude` CLI, the `codex` CLI, and an
 * OpenAI-compatible HTTP endpoint (for a local subscription proxy).
 */
export interface ModelBackend {
  readonly name: string;
  complete(request: CompletionRequest): Promise<string>;
  /** A short health check for `npm run doctor`. Returns a version or status line. */
  check(): Promise<string>;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
