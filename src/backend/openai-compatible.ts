import { BackendError, type CompletionRequest, type ModelBackend } from "./types.js";

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint. Use this backend with a
 * local proxy that serves a Claude or ChatGPT subscription over HTTP.
 */
export class OpenAICompatibleBackend implements ModelBackend {
  readonly name = "openai-compatible";

  constructor(
    private readonly options: { baseUrl: string; apiKey?: string; model?: string; fetch?: typeof fetch },
  ) {}

  async complete(request: CompletionRequest): Promise<string> {
    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model ?? "default",
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    }).catch((error: unknown) => {
      throw new BackendError(`proxy request failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok) {
      throw new BackendError(`proxy returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new BackendError("proxy returned no content");
    return content.trim();
  }

  async check(): Promise<string> {
    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(`${this.options.baseUrl.replace(/\/$/, "")}/models`, {
      headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new BackendError(`proxy /models returned HTTP ${response.status}`);
    return `proxy reachable at ${this.options.baseUrl}`;
  }
}
