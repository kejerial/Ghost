import type { ModelBackend } from "../backend/types.js";
import { errorFields, log } from "../log.js";
import type { Retriever } from "../retrieval/search.js";
import type { SlackApi, SlackMessage } from "../slack/api.js";
import { cleanSlackText, renderAnswer, stripMention } from "../slack/text.js";
import type { UserDirectory } from "../slack/users.js";
import type { Store } from "../store/db.js";
import type { Identity } from "../store/sync.js";
import type { Limiter } from "../util/limiter.js";
import { gatherRecent, gatherThread, type ContextMessage } from "./context.js";
import { buildPrompt } from "./prompt.js";

export interface MentionEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text: string;
}

export interface GhostDeps {
  api: SlackApi;
  store: Store;
  users: UserDirectory;
  retriever: Retriever;
  backend: ModelBackend;
  limiter: Limiter;
  identity: Identity & { teamUrl: string };
  contextChars: number;
  modelTimeoutMs: number;
}

const WORKING_REACTION = "eyes";

export const HELP_TEXT =
  "Hi, I'm Ghost. Ask me anything with `@ghost <question>`. For example: `@ghost what did we decide about pricing?`, " +
  "`@ghost summarize this thread`, or a general question. I cite the Slack messages I use.";

export interface Answer {
  text: string;
  sourceCount: number;
  citedCount: number;
}

export class Ghost {
  constructor(private readonly deps: GhostDeps) {}

  private isGhost = (m: SlackMessage): boolean =>
    m.user === this.deps.identity.botUserId || (this.deps.identity.botId !== undefined && m.bot_id === this.deps.identity.botId);

  /**
   * Handle one question end to end. Never throws.
   * - `thread` (default, for @mentions): reply in the message's thread.
   * - `channel` (home channel): reply in the channel, or in the thread when the message is in one.
   */
  async handleMention(event: MentionEvent, placement: "thread" | "channel" = "thread"): Promise<void> {
    const { api, store } = this.deps;
    if (!store.claimEvent(`mention:${event.channel}:${event.ts}`)) {
      log.debug("duplicate mention ignored", { channel: event.channel, ts: event.ts });
      return;
    }
    const replyThreadTs = placement === "channel" ? event.thread_ts : (event.thread_ts ?? event.ts);

    const question = stripMention(event.text, this.deps.identity.botUserId);
    if (!question) {
      if (placement === "channel") return; // a file or an empty message in the home channel
      await api.post(event.channel, replyThreadTs, HELP_TEXT).catch((error) => log.warn("help post failed", errorFields(error)));
      return;
    }

    // A reaction shows that Ghost is working. The answer is then posted once, as a new message,
    // so the post-time safety flags (no unfurls, no parsing) apply to it. chat.update has no unfurl flag.
    await api.addReaction(event.channel, event.ts, WORKING_REACTION).catch((error) => log.warn("addReaction failed", errorFields(error)));
    try {
      const started = Date.now();
      const answer = await this.answer(event, question);
      await api.post(event.channel, replyThreadTs, answer.text);
      log.info("answered", {
        channel: event.channel,
        ts: event.ts,
        ms: Date.now() - started,
        sources: answer.sourceCount,
        cited: answer.citedCount,
        backend: this.deps.backend.name,
      });
    } catch (error) {
      log.error("answer failed", { channel: event.channel, ts: event.ts, ...errorFields(error) });
      const message = "Sorry, I couldn't answer that. Something went wrong on my side. Please try again in a minute.";
      await api.post(event.channel, replyThreadTs, message).catch(() => undefined);
    } finally {
      await api.removeReaction(event.channel, event.ts, WORKING_REACTION).catch(() => undefined);
    }
  }

  /** Gather context, call the model, and render the reply. Separate from Slack posting so `npm run ask` can reuse it. */
  async answer(event: MentionEvent, rawQuestion: string): Promise<Answer> {
    const { api, users, retriever, backend, limiter, identity } = this.deps;
    // Resolve <@U123>, <#C123|name>, and &amp; so the model and the search both see plain text.
    await users.warm([], [rawQuestion]);
    const question = cleanSlackText(rawQuestion, (id) => users.cached(id));
    const isThread = event.thread_ts !== undefined && event.thread_ts !== event.ts;
    const threadRootTs = event.thread_ts ?? event.ts;

    const [thread, recent, askerName, channel] = await Promise.all([
      isThread ? gatherThread(api, users, this.isGhost, event.channel, threadRootTs) : Promise.resolve<ContextMessage[]>([]),
      gatherRecent(api, users, this.isGhost, event.channel, threadRootTs),
      event.user ? users.name(event.user) : Promise.resolve("someone"),
      this.channel(event.channel),
    ]);

    // Do not show the mention itself as context. The question section already holds it.
    const threadContext = thread.filter((m) => m.ts !== event.ts);
    const exclude = new Set([...thread, ...recent].map((m) => `${m.channelId}:${m.ts}`));
    exclude.add(`${event.channel}:${event.ts}`);

    const retrieved = retriever.search({ question, channelId: event.channel, exclude });
    const built = buildPrompt({
      question,
      askerName,
      channelName: channel.name,
      isThread,
      thread: threadContext,
      recent: recent.filter((m) => m.ts !== threadRootTs || !isThread),
      retrieved,
      teamUrl: identity.teamUrl,
      budget: this.deps.contextChars,
    });
    log.debug("prompt built", { chars: built.prompt.length, sources: built.sources.length, retrieved: retrieved.length });

    const raw = await limiter.run(() =>
      backend.complete({ system: built.system, prompt: built.prompt, timeoutMs: this.deps.modelTimeoutMs }),
    );
    const rendered = renderAnswer(raw, built.sources);
    return { text: rendered.text, sourceCount: built.sources.length, citedCount: rendered.cited };
  }

  private async channel(channelId: string): Promise<{ name: string }> {
    const known = this.deps.store.getChannel(channelId);
    if (known) return known;
    const info = await this.deps.api.channelInfo(channelId);
    this.deps.store.upsertChannel(info);
    return info;
  }
}
