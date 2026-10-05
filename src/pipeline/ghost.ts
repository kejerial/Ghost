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
import { displayName, type Connections } from "../integrations/mcp.js";
import { PROFILE_PROMPT, type Profiles } from "../memory/profiles.js";
import { describe as describeSchedule, type Scheduler } from "../schedule/scheduler.js";
import { extractDirectives, type Directive } from "./directives.js";
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
  profiles: Profiles;
  connections?: Connections;
  /** Set after construction, because the scheduler runs tasks through this Ghost. */
  scheduler?: Scheduler;
}

/** Ghost drafts a profile once there are this many indexed messages from the user. */
const PROFILE_MIN_MESSAGES = 5;

const WORKING_REACTION = "eyes";

export const HELP_TEXT =
  "Hi, I'm Ghost. Ask me anything with `@ghost <question>`. For example: `@ghost what did we decide about pricing?`, " +
  "`@ghost summarize this thread`, or a general question. I cite the Slack messages I use.";

export interface Answer {
  text: string;
  sourceCount: number;
  citedCount: number;
  /** Connections the model asked to log in to. The caller starts the logins after it posts the answer. */
  logins: string[];
}

export class Ghost {
  private readonly draftingProfiles = new Set<string>();
  /** Answers and logins still running. A shutdown waits for them (see drain). */
  private readonly active = new Set<Promise<unknown>>();

  /** Wait for in-flight work to finish, up to `timeoutMs`. Used on shutdown so a restart loses nothing. */
  async drain(timeoutMs: number): Promise<number> {
    const pending = this.active.size;
    if (pending) await Promise.race([Promise.allSettled([...this.active]), new Promise((r) => setTimeout(r, timeoutMs))]);
    return pending;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  constructor(private readonly deps: GhostDeps) {}

  attachScheduler(scheduler: Scheduler): void {
    this.deps.scheduler = scheduler;
  }

  private isGhost = (m: SlackMessage): boolean =>
    m.user === this.deps.identity.botUserId || (this.deps.identity.botId !== undefined && m.bot_id === this.deps.identity.botId);

  /**
   * Handle one question end to end. Never throws.
   * - `thread` (default, for @mentions): reply in the message's thread.
   * - `channel` (home channel): reply in the channel, or in the thread when the message is in one.
   */
  handleMention(event: MentionEvent, placement: "thread" | "channel" = "thread"): Promise<void> {
    return this.track(this.handleMentionNow(event, placement));
  }

  private async handleMentionNow(event: MentionEvent, placement: "thread" | "channel"): Promise<void> {
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
      for (const name of answer.logins) void this.track(this.loginThenAnswer(name, event, question, replyThreadTs));
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

  /**
   * Gather context, call the model, and render the reply. Separate from Slack posting so `npm run ask` can reuse it.
   * `applyDirectives: false` is for scheduled task runs: they must not create more schedules or
   * change memory. Directives are still removed from the text.
   */
  async answer(event: MentionEvent, rawQuestion: string, options: { applyDirectives?: boolean } = {}): Promise<Answer> {
    const { api, users, retriever, backend, limiter, identity } = this.deps;
    // Resolve <@U123>, <#C123|name>, and &amp; so the model and the search both see plain text.
    await users.warm([], [rawQuestion]);
    const question = cleanSlackText(rawQuestion, (id) => users.cached(id));
    const isThread = event.thread_ts !== undefined && event.thread_ts !== event.ts;
    const threadRootTs = event.thread_ts ?? event.ts;

    const [thread, recent, askerName, channel, timezone] = await Promise.all([
      isThread ? gatherThread(api, users, this.isGhost, event.channel, threadRootTs) : Promise.resolve<ContextMessage[]>([]),
      gatherRecent(api, users, this.isGhost, event.channel, threadRootTs),
      event.user ? users.name(event.user) : Promise.resolve("someone"),
      this.channel(event.channel),
      event.user ? users.timezone(event.user) : Promise.resolve(undefined),
    ]);
    if (event.user) this.draftProfileOnce(event.user, askerName);
    const { connections } = this.deps;
    void connections?.refresh().catch(() => undefined); // picks up logins made outside Ghost, at most every 5 minutes

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
      aboutAsker: event.user ? this.deps.profiles.read(event.user) : undefined,
      timezone,
      schedules: event.user && this.deps.scheduler ? this.deps.scheduler.list(event.user).map(describeSchedule) : undefined,
      connections: connections ? { connected: connections.servers.map((s) => s.name), needsLogin: connections.needsLogin } : undefined,
    });
    log.debug("prompt built", { chars: built.prompt.length, sources: built.sources.length, retrieved: retrieved.length });

    const raw = await limiter.run(() =>
      backend.complete({ system: built.system, prompt: built.prompt, timeoutMs: this.deps.modelTimeoutMs }),
    );
    const { text, directives } = extractDirectives(raw);
    const { notes, logins } =
      event.user && options.applyDirectives !== false
        ? await this.apply(directives, { userId: event.user, name: askerName, channelId: event.channel, tz: timezone ?? "UTC" })
        : { notes: [], logins: [] };
    const rendered = renderAnswer(text, built.sources);
    const footer = notes.length ? `\n\n${notes.map((n) => `_${n}_`).join("\n")}` : "";
    return { text: rendered.text + footer, sourceCount: built.sources.length, citedCount: rendered.cited, logins };
  }

  /** Apply the model's directives for this user. Returns notes for anything that failed. */
  private async apply(
    directives: Directive[],
    who: { userId: string; name: string; channelId: string; tz: string },
  ): Promise<{ notes: string[]; logins: string[] }> {
    const { profiles, scheduler } = this.deps;
    const notes: string[] = [];
    const logins: string[] = [];
    for (const d of directives) {
      try {
        if (d.type === "remember") profiles.remember(who.userId, who.name, d.text);
        else if (d.type === "forget") profiles.forget(who.userId, d.text);
        else if (d.type === "schedule") {
          if (!scheduler) throw new Error("scheduling is off");
          const created = await scheduler.create(d.spec, { userId: who.userId, channelId: who.channelId, tz: who.tz });
          log.info("schedule created", { id: created.id, kind: created.kind, nextRun: new Date(created.nextRun).toISOString(), cron: created.cron });
        } else if (d.type === "connect") {
          if (!this.deps.connections) throw new Error("connections are off");
          logins.push(d.name);
        } else if (d.type === "cancel") {
          if (!(await scheduler?.cancel(who.userId, d.id))) notes.push(`⚠️ I couldn't find schedule #${d.id}.`);
        } else {
          log.warn("invalid directive", { raw: d.raw, reason: d.reason });
          notes.push(`⚠️ I couldn't set that up (${d.reason}). Try rephrasing the time.`);
        }
      } catch (error) {
        log.warn("directive failed", { type: d.type, ...errorFields(error) });
        notes.push(`⚠️ I couldn't set that up: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    return { notes, logins: [...new Set(logins)] };
  }

  /**
   * Open the sign-in page for a connection on this Mac. When the user finishes, answer the
   * original question again with the new connection, in the same place as the first reply.
   */
  private async loginThenAnswer(name: string, event: MentionEvent, question: string, replyThreadTs: string | undefined): Promise<void> {
    const { api, connections } = this.deps;
    const label = displayName(name);
    log.info("connection login started", { name });
    let ok = false;
    let announced: Promise<unknown> = Promise.resolve();
    const announce = () =>
      (announced = api.post(event.channel, replyThreadTs, `✅ ${label} is connected. Checking on that now…`).catch(() => undefined));
    try {
      ok = await connections!.login(name, (url) => {
        void api
          .post(event.channel, replyThreadTs, `🔑 <${url}|Sign in to ${label}>. The page should also be open in your browser on your Mac.`)
          .catch(() => undefined);
      }, announce);
    } catch (error) {
      log.warn("connection login failed", { name, ...errorFields(error) });
    }
    log.info("connection login finished", { name, ok });
    if (!ok) {
      await api.post(event.channel, replyThreadTs, `⚠️ The ${label} login didn't finish. Ask again and I'll reopen it.`).catch(() => undefined);
      return;
    }
    // The confirmation went out as soon as the login finished; the answer below can take a while.
    await announced;
    await api.addReaction(event.channel, event.ts, WORKING_REACTION).catch(() => undefined);
    try {
      const started = Date.now();
      const retry = await this.answer(event, question);
      await api.post(event.channel, replyThreadTs, retry.text);
      log.info("answered after login", { name, ms: Date.now() - started });
    } catch (error) {
      log.error("answer after login failed", { name, ...errorFields(error) });
      await api.post(event.channel, replyThreadTs, `Sorry, my answer failed after the ${label} login. Ask again and I'll use it.`).catch(() => undefined);
    } finally {
      await api.removeReaction(event.channel, event.ts, WORKING_REACTION).catch(() => undefined);
    }
  }

  /** Draft a profile from the user's own indexed messages, once, in the background. */
  private draftProfileOnce(userId: string, name: string): void {
    const { profiles, store, backend, limiter } = this.deps;
    if (profiles.exists(userId) || this.draftingProfiles.has(userId)) return;
    const rows = store.db
      .prepare(
        `SELECT c.name AS channel, m.ts, m.clean_text AS text FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE m.user_id = ? ORDER BY m.ts_num DESC LIMIT 300`,
      )
      .all(userId) as Array<{ channel: string; ts: string; text: string }>;
    if (rows.length < PROFILE_MIN_MESSAGES) return;
    this.draftingProfiles.add(userId);
    const corpus = rows
      .reverse()
      .map((r) => `#${r.channel} ${new Date(Number(r.ts) * 1000).toISOString().slice(0, 10)}: ${r.text.slice(0, 500)}`)
      .join("\n")
      .slice(-30_000);
    void limiter
      .run(() => backend.complete({ system: PROFILE_PROMPT, prompt: `Messages written by ${name}:\n${corpus}`, timeoutMs: this.deps.modelTimeoutMs }))
      .then((body) => {
        if (!profiles.exists(userId) || !profiles.read(userId)?.includes("## Who they are")) profiles.writeProfile(userId, name, body);
        log.info("profile drafted", { userId, messages: rows.length });
      })
      .catch((error) => log.warn("profile draft failed", { userId, ...errorFields(error) }))
      .finally(() => this.draftingProfiles.delete(userId));
  }

  private async channel(channelId: string): Promise<{ name: string }> {
    const known = this.deps.store.getChannel(channelId);
    if (known) return known;
    const info = await this.deps.api.channelInfo(channelId);
    this.deps.store.upsertChannel(info);
    return info;
  }
}
