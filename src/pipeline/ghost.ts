import type { ModelBackend } from "../backend/types.js";
import { errorFields, log } from "../log.js";
import type { Retriever } from "../retrieval/search.js";
import type { SlackApi, SlackMessage } from "../slack/api.js";
import { cleanSlackText, renderAnswer, stripMention, type CitableSource } from "../slack/text.js";
import type { UserDirectory } from "../slack/users.js";
import type { Store } from "../store/db.js";
import type { Identity } from "../store/sync.js";
import type { Limiter } from "../util/limiter.js";
import { gatherRecent, gatherThread, type ContextMessage } from "./context.js";
import { displayName, type Connections } from "../integrations/mcp.js";
import { pickConnections } from "../integrations/router.js";
import type { ProgressStep } from "../backend/types.js";
import { PROFILE_PROMPT, type Profiles } from "../memory/profiles.js";
import { describe as describeSchedule, type Scheduler } from "../schedule/scheduler.js";
import { extractDirectives, type CanvasSpec, type Directive, type SlackActionSpec } from "./directives.js";
import { buildPrompt, type PromptAttachment } from "./prompt.js";
import { fetchWebImage, webImageDir } from "../util/web-image.js";
import { isCanvas, type Attachment, type FileReader, type SlackFile } from "../slack/files.js";

/** At most this many files per answer, newest first, and at most this many of them as images. */
const MAX_FILES = 6;
const MAX_IMAGES = 4;
/** At most this many canvas tabs are read per answer. */
const MAX_CANVASES = 4;
/** Total extracted-text budget across all attachments. */
const MAX_ATTACHMENT_CHARS = 40000;
const FILE_ONLY_QUESTION = "(No message text. Look at the attached file(s) and respond helpfully: say what it is and what stands out.)";

export interface MentionEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
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
  /** Downloads web images the model asks to see. Tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** Reads attachments. Without it, Ghost sees only file names. */
  files?: FileReader;
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

    const question = stripMention(event.text, this.deps.identity.botUserId) || (event.files?.length ? FILE_ONLY_QUESTION : "");
    if (!question) {
      if (placement === "channel") return; // an empty message in the home channel
      await api.post(event.channel, replyThreadTs, HELP_TEXT).catch((error) => log.warn("help post failed", errorFields(error)));
      return;
    }

    // A reaction shows that Ghost is working. The answer is then posted once, as a new message,
    // so the post-time safety flags (no unfurls, no parsing) apply to it. chat.update has no unfurl flag.
    log.info("question received", { channel: event.channel, ts: event.ts });
    await api.addReaction(event.channel, event.ts, WORKING_REACTION).catch((error) => log.warn("addReaction failed", errorFields(error)));
    const status = statusLine(api, event.channel, replyThreadTs);
    try {
      const started = Date.now();
      const answer = await this.answer(event, question, { onProgress: status.show });
      await api.post(event.channel, replyThreadTs, answer.text);
      await status.clear();
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
      await status.clear();
      await api.removeReaction(event.channel, event.ts, WORKING_REACTION).catch(() => undefined);
    }
  }

  /**
   * Gather context, call the model, and render the reply. Separate from Slack posting so `npm run ask` can reuse it.
   * `applyDirectives: false` is for scheduled task runs: they must not create more schedules or
   * change memory. Directives are still removed from the text.
   */
  async answer(
    event: MentionEvent,
    rawQuestion: string,
    options: { applyDirectives?: boolean; onProgress?: (step: ProgressStep) => void; forceConnections?: string[] } = {},
  ): Promise<Answer> {
    const { api, users, retriever, backend, limiter, identity } = this.deps;
    // Resolve <@U123>, <#C123|name>, and &amp; so the model and the search both see plain text.
    await users.warm([], [rawQuestion]);
    const question = cleanSlackText(rawQuestion, (id) => users.cached(id));
    const isThread = event.thread_ts !== undefined && event.thread_ts !== event.ts;
    const threadRootTs = event.thread_ts ?? event.ts;

    const [thread, recent, askerName, channel, timezone] = await Promise.all([
      isThread ? gatherThread(api, users, this.isGhost, event.channel, threadRootTs) : Promise.resolve<ContextMessage[]>([]),
      gatherRecent(api, users, this.isGhost, event.channel, threadRootTs, isThread ? 15 : 30),
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
    const currentFiles = event.files ?? thread.find((m) => m.ts === event.ts)?.files ?? [];
    const conversation = [...threadContext, ...recent];
    // Attach only the connections this conversation needs; each one adds start-up time to the call.
    const routingText = [question, ...conversation.slice(-6).map((m) => m.text)].join("\n");
    // Always load the channel's canvases: people call them "my to-do list" or "the planner", not "canvas".
    const channelCanvases = await this.channelCanvases(event.channel);
    const { attachments, images, canvasIds } = await this.readAttachments(currentFiles, askerName, conversation, channelCanvases ?? []);
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
      connections: connections
        ? { connected: connections.connected, needsLogin: connections.needsLogin, available: connections.availableApps }
        : undefined,
      attachments,
      channelHasCanvas: channelCanvases ? channelCanvases.length > 0 : undefined,
    });
    log.debug("prompt built", { chars: built.prompt.length, sources: built.sources.length, retrieved: retrieved.length });

    const attach = connections
      ? [...new Set([...pickConnections(connections.connected, routingText), ...(options.forceConnections ?? [])])]
      : undefined;
    log.debug("connections attached", { attach });
    const ask = (prompt: string, shown: string[]) =>
      limiter.run(() =>
        backend.complete({ system: built.system, prompt, timeoutMs: this.deps.modelTimeoutMs, connections: attach, onProgress: options.onProgress, images: shown }),
      );
    let raw = await ask(built.prompt, images);
    let { text, directives } = extractDirectives(raw);

    // The model asked to see web images: download them and ask once more with the images shown.
    const looks = [...new Set(directives.flatMap((d) => (d.type === "look" ? [d.url] : [])))].slice(0, Math.max(0, MAX_IMAGES - images.length));
    if (looks.length) {
      const { dir, cleanup } = await webImageDir();
      try {
        const results = await Promise.all(
          looks.map((url, i) => fetchWebImage(url, dir, i, this.deps.fetchImpl).then((path) => ({ url, path }), (error: unknown) => ({ url, error: error instanceof Error ? error.message : String(error) }))),
        );
        const shown = [...images];
        const lines = results.map((r) => ("path" in r ? `image ${shown.push(r.path)}: ${r.url}` : `could not load ${r.url} (${r.error})`));
        log.info("web images", { requested: looks.length, shown: shown.length - images.length });
        const followUp = `${built.prompt}\n\n<web_images>\n${lines.join("\n")}\n</web_images>\nYou asked to see these web images. The ones that loaded are now shown to you, numbered after any attached images. Answer the question now, using what you see. Do not add <<look: >> again.`;
        raw = await ask(followUp, shown);
        ({ text, directives } = extractDirectives(raw));
      } finally {
        await cleanup();
      }
    }
    const { notes, logins } =
      event.user && options.applyDirectives !== false
        ? await this.apply(directives, { userId: event.user, name: askerName, channelId: event.channel, tz: timezone ?? "UTC", canvasIds, sources: built.sources })
        : { notes: [], logins: [] };
    const rendered = renderAnswer(text, built.sources);
    const footer = notes.length ? `\n\n${notes.map((n) => `_${n}_`).join("\n")}` : "";
    return { text: rendered.text + footer, sourceCount: built.sources.length, citedCount: rendered.cited, logins };
  }

  /**
   * Read the files on the question first, then the newest files in the conversation.
   * Images go to the model as images; everything else as extracted text.
   */
  private async readAttachments(
    current: SlackFile[],
    askerName: string,
    conversation: ContextMessage[],
    channelCanvases: SlackFile[] = [],
  ): Promise<{ attachments: PromptAttachment[]; images: string[]; canvasIds: Set<string> }> {
    const candidates: { file: SlackFile; from: string; current: boolean }[] = current.map((file) => ({ file, from: askerName, current: true }));
    candidates.unshift(...channelCanvases.map((file) => ({ file, from: "a canvas tab in this channel", current: false })));
    for (const m of [...conversation].sort((a, b) => Number(b.ts) - Number(a.ts))) {
      if (m.isGhost) continue;
      for (const file of m.files ?? []) candidates.push({ file, from: m.userName, current: false });
    }
    const seen = new Set<string>();
    const chosen = candidates.filter((c) => !seen.has(c.file.id) && seen.add(c.file.id)).slice(0, MAX_FILES);
    if (!chosen.length) return { attachments: [], images: [], canvasIds: new Set() };
    const reader = this.deps.files;
    const read: Attachment[] = await Promise.all(
      chosen.map((c) => (reader ? reader.read(c.file) : Promise.resolve({ id: c.file.id, name: c.file.name ?? c.file.id, note: "file reading is off" }))),
    );

    const attachments: PromptAttachment[] = [];
    const images: string[] = [];
    let chars = 0;
    read.forEach((a, i) => {
      const out: PromptAttachment = { name: a.name, from: chosen[i]!.from, current: chosen[i]!.current, note: a.note, canvasId: a.canvasId };
      if (a.imagePath) {
        if (images.length < MAX_IMAGES) out.imageNumber = images.push(a.imagePath);
        else out.note = "image not shown: too many images in this conversation";
      }
      if (a.text) {
        const room = MAX_ATTACHMENT_CHARS - chars;
        if (room <= 200) out.note = "text not included: the attachments are too long in total";
        else {
          const text = a.text.length <= room ? a.text : `${a.text.slice(0, room)}\n…(truncated)`;
          out.text = text;
          chars += text.length;
        }
      }
      attachments.push(out);
    });
    log.info("attachments read", { files: attachments.length, images: images.length, chars, notes: attachments.filter((a) => a.note).map((a) => a.note) });
    // Ghost edits only canvases it read in this channel's conversation.
    const canvasIds = new Set(chosen.filter((c) => isCanvas(c.file)).map((c) => c.file.id));
    return { attachments, images, canvasIds };
  }

  /** Ghost edits only canvases it read in this channel's conversation. */
  private async applyCanvas(spec: CanvasSpec, channelId: string, canvasIds: Set<string>): Promise<void> {
    const { api } = this.deps;
    if (spec.action === "create") {
      const id = await api.createChannelCanvas(channelId, spec.markdown, spec.title);
      log.info("canvas created", { channel: channelId, canvas: id });
      return;
    }
    if (!canvasIds.has(spec.id)) throw new Error("I can only change a canvas from this channel that I have read");
    if (spec.action === "delete") await api.deleteCanvas(spec.id);
    else if (spec.action === "rename") await api.editCanvas(spec.id, { operation: "rename", title: spec.title });
    else {
      const operation = spec.action === "append" ? "insert_at_end" : spec.action === "prepend" ? "insert_at_start" : "replace";
      await api.editCanvas(spec.id, { operation, markdown: spec.markdown });
    }
    log.info("canvas changed", { canvas: spec.id, action: spec.action });
  }

  /** Channel actions. Message actions work only on messages in the asker's channel. */
  private async applySlack(spec: SlackActionSpec, who: { userId: string; channelId: string; sources?: CitableSource[] }): Promise<void> {
    const { api } = this.deps;
    const message = (id: string) => {
      const source = who.sources?.find((s) => s.id === id);
      if (!source?.ts || source.channelId !== who.channelId) throw new Error(`I can only act on messages in this channel (${id})`);
      return source.ts;
    };
    switch (spec.action) {
      case "pin":
        await api.pin(who.channelId, message(spec.message));
        break;
      case "unpin":
        await api.unpin(who.channelId, message(spec.message));
        break;
      case "react":
        await api.addReaction(who.channelId, message(spec.message), spec.emoji);
        break;
      case "bookmark":
        await api.addBookmark(who.channelId, spec.title, spec.url);
        break;
      case "topic":
        await api.setTopic(who.channelId, spec.text);
        break;
      case "post":
        await api.post(who.channelId, undefined, renderAnswer(spec.text, []).text);
        break;
      case "dm": {
        const person = await this.findPerson(spec.person);
        await api.post(await api.openDm(person.id), undefined, renderAnswer(spec.text, []).text);
        break;
      }
      case "invite":
        await api.invite(who.channelId, [(await this.findPerson(spec.person)).id]);
        break;
      case "create_channel": {
        const id = await api.createChannel(spec.name, spec.private);
        // Ghost creates the channel, so it adds the asker; otherwise only Ghost would be in it.
        await api.invite(id, [who.userId]);
        break;
      }
    }
    log.info("slack action", { action: spec.action, channel: who.channelId });
  }

  /** Match a name to exactly one person: display name, full name, or first name. */
  private async findPerson(name: string): Promise<{ id: string; name: string }> {
    const wanted = name.toLowerCase().replace(/^@/, "").trim();
    const people = await this.deps.api.people();
    const names = (p: { name: string; realName?: string }) => [p.name, p.realName].filter(Boolean).map((n) => n!.toLowerCase());
    for (const test of [
      (n: string) => n === wanted,
      (n: string) => n.split(/\s+/)[0] === wanted,
      (n: string) => n.includes(wanted),
    ]) {
      const hits = people.filter((p) => names(p).some(test));
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) throw new Error(`"${name}" matches ${hits.length} people (${hits.slice(0, 4).map((p) => p.realName ?? p.name).join(", ")}); use a full name`);
    }
    throw new Error(`I couldn't find anyone named "${name}"`);
  }

  /** The channel's canvas tabs, with the details needed to download them. Undefined if the lookup failed. */
  private async channelCanvases(channelId: string): Promise<SlackFile[] | undefined> {
    try {
      const ids = (await this.deps.api.channelCanvasIds(channelId)).slice(0, MAX_CANVASES);
      return await Promise.all(ids.map((id) => this.deps.api.fileInfo(id)));
    } catch (error) {
      log.warn("channel canvas lookup failed", { channelId, ...errorFields(error) });
      return undefined;
    }
  }

  /** Apply the model's directives for this user. Returns notes for anything that failed. */
  private async apply(
    directives: Directive[],
    who: { userId: string; name: string; channelId: string; tz: string; canvasIds?: Set<string>; sources?: CitableSource[] },
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
        } else if (d.type === "canvas") {
          await this.applyCanvas(d.spec, who.channelId, who.canvasIds ?? new Set());
        } else if (d.type === "slack") {
          await this.applySlack(d.spec, who);
        } else if (d.type === "look") {
          // Handled before the answer is posted.
        } else if (d.type === "cancel") {
          if (!(await scheduler?.cancel(who.userId, d.id))) notes.push(`⚠️ I couldn't find schedule #${d.id}.`);
        } else {
          log.warn("invalid directive", { raw: d.raw, reason: d.reason });
          notes.push(`⚠️ I couldn't do that (${d.reason}).`);
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
    const status = statusLine(api, event.channel, replyThreadTs);
    try {
      const started = Date.now();
      const retry = await this.answer(event, question, { onProgress: status.show, forceConnections: [name] });
      await api.post(event.channel, replyThreadTs, retry.text);
      await status.clear();
      log.info("answered after login", { name, ms: Date.now() - started });
    } catch (error) {
      log.error("answer after login failed", { name, ...errorFields(error) });
      await api.post(event.channel, replyThreadTs, `Sorry, my answer failed after the ${label} login. Ask again and I'll use it.`).catch(() => undefined);
    } finally {
      await status.clear();
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
      .run(() => backend.complete({ system: PROFILE_PROMPT, prompt: `Messages written by ${name}:\n${corpus}`, timeoutMs: this.deps.modelTimeoutMs, connections: [] }))
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

/**
 * A live status message while Ghost works. It lists every step (web search, each connection),
 * marks finished steps with ✓, and is deleted once the answer is posted.
 */
function statusLine(api: SlackApi, channel: string, threadTs: string | undefined) {
  let ts: string | undefined;
  let last = "";
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  /** Steps in first-seen order, with how many calls of each are still running. */
  const steps = new Map<string, { label: string; running: number }>();
  const render = () =>
    [...steps.values()].map((s) => `• ${s.label}${s.running > 0 ? "…" : " ✓"}`).join("\n");
  return {
    show: (step: ProgressStep) => {
      if (closed) return;
      const key = step.kind === "web" ? "web" : `connection:${step.name}`;
      const label = step.kind === "web" ? "🔎 Searching the web" : `📎 Checking ${displayName(step.name)}`;
      const entry = steps.get(key) ?? { label, running: 0 };
      entry.running = Math.max(0, entry.running + (step.phase === "done" ? -1 : 1));
      steps.set(key, entry);
      const text = render();
      if (text === last) return;
      last = text;
      chain = chain
        .then(async () => {
          if (ts) await api.update(channel, ts, text);
          else ts = (await api.post(channel, threadTs, text)).ts;
        })
        .catch((error) => log.debug("status update failed", errorFields(error)));
    },
    clear: async () => {
      closed = true;
      await chain;
      const posted = ts;
      ts = undefined;
      if (posted) await api.deleteMessage(channel, posted).catch((error) => log.warn("status delete failed", { channel, ts: posted, ...errorFields(error) }));
    },
  };
}
