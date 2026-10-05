import { CronExpressionParser } from "cron-parser";
import type { DB } from "../store/db.js";
import type { SlackApi } from "../slack/api.js";
import type { ScheduleSpec } from "../pipeline/directives.js";
import { errorFields, log } from "../log.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  text             TEXT NOT NULL,
  cron             TEXT,
  tz               TEXT NOT NULL,
  next_run         INTEGER NOT NULL,
  slack_message_id TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);`;

/** Slack schedules messages at most 120 days ahead. */
const SLACK_HORIZON_MS = 119 * 24 * 60 * 60 * 1000;
const TICK_MS = 30_000;
const LATE_MS = 5 * 60_000;
/** A reminder this close to now is posted directly instead of through Slack's scheduler. */
const POST_NOW_MS = 15_000;

export interface Schedule {
  id: number;
  userId: string;
  channelId: string;
  kind: "reminder" | "task";
  text: string;
  cron: string | null;
  tz: string;
  nextRun: number;
  slackMessageId: string | null;
}

/** Runs a scheduled task through the answer pipeline and returns the reply text. */
export type TaskRunner = (schedule: Schedule) => Promise<string>;

/**
 * Reminders: Slack's own scheduler posts them (chat.scheduleMessage), so they are on time
 * even while this Mac sleeps. Ghost keeps the next run of a repeating reminder queued in Slack.
 * Tasks: Ghost runs them itself every 30 seconds. A task missed during sleep runs on wake, marked late.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  /** Rows that a create() or tick() is handing to Slack right now. Others skip them. */
  private readonly queuing = new Set<number>();

  constructor(
    private readonly db: DB,
    private readonly api: SlackApi,
    private readonly runTask: TaskRunner,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async create(spec: ScheduleSpec, context: { userId: string; channelId: string; tz: string }): Promise<Schedule> {
    const nextRun = spec.cron ? nextCron(spec.cron, context.tz, this.now()) : parseLocalTime(spec.at!, context.tz);
    if (!Number.isFinite(nextRun)) throw new Error(`invalid time: ${spec.at}`);
    if (nextRun < this.now() - 60_000) throw new Error("that time is in the past");
    const result = this.db
      .prepare(`INSERT INTO schedules (user_id, channel_id, kind, text, cron, tz, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(context.userId, context.channelId, spec.kind, spec.text, spec.cron ?? null, context.tz, nextRun, this.now());
    const id = Number(result.lastInsertRowid);
    const schedule = this.get(id)!;
    if (schedule.kind === "reminder") {
      try {
        await this.queueReminder(schedule);
      } catch (error) {
        // The user sees the failure and may retry, so do not leave a copy that a later tick would queue.
        this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
        throw error;
      }
    }
    return this.getAny(id)!;
  }

  list(userId: string): Schedule[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE user_id = ? AND active = 1 ORDER BY next_run`).all(userId) as Row[]).map(toSchedule);
  }

  /** Cancel one of the user's own schedules. Returns false when the ID is not theirs or not active. */
  async cancel(userId: string, id: number): Promise<boolean> {
    const schedule = this.get(id);
    if (!schedule || schedule.userId !== userId) return false;
    if (schedule.slackMessageId) {
      await this.api
        .deleteScheduledMessage(schedule.channelId, schedule.slackMessageId)
        .catch((error) => log.warn("deleteScheduledMessage failed", { id, ...errorFields(error) }));
    }
    this.db.prepare(`UPDATE schedules SET active = 0 WHERE id = ?`).run(id);
    return true;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const ids = (this.db.prepare(`SELECT id FROM schedules WHERE active = 1`).all() as Array<{ id: number }>).map((r) => r.id);
      for (const id of ids) {
        // Re-read each row: an earlier task in this tick can take minutes, and the user can cancel meanwhile.
        const schedule = this.get(id);
        if (!schedule) continue;
        try {
          if (schedule.kind === "reminder") await this.tickReminder(schedule);
          else if (schedule.nextRun <= this.now()) await this.runDueTask(schedule);
        } catch (error) {
          log.error("schedule failed", { id: schedule.id, ...errorFields(error) });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickReminder(schedule: Schedule): Promise<void> {
    if (schedule.slackMessageId) {
      if (schedule.nextRun > this.now()) return; // queued in Slack, not yet due
      this.advance(schedule); // Slack already posted it
      const next = this.get(schedule.id);
      if (next) await this.queueReminder(next);
    } else {
      await this.queueReminder(schedule);
    }
  }

  /** Hand the next run to Slack, or post it now when it is due. Repeats until the next run is in the future. */
  private async queueReminder(schedule: Schedule): Promise<void> {
    if (this.queuing.has(schedule.id)) return;
    this.queuing.add(schedule.id);
    try {
      await this.queueReminderNow(schedule);
    } finally {
      this.queuing.delete(schedule.id);
    }
  }

  private async queueReminderNow(schedule: Schedule): Promise<void> {
    let current: Schedule | undefined = schedule;
    while (current && !current.slackMessageId) {
      if (current.nextRun - this.now() > SLACK_HORIZON_MS) return; // too far ahead; a later tick queues it
      const text = `⏰ <@${current.userId}> ${escape(current.text)}`;
      if (current.nextRun > this.now() + POST_NOW_MS) {
        const id = await this.api.scheduleMessage(current.channelId, Math.floor(current.nextRun / 1000), text);
        this.db.prepare(`UPDATE schedules SET slack_message_id = ? WHERE id = ?`).run(id, current.id);
        return;
      }
      await this.api.post(current.channelId, undefined, text);
      this.advance(current);
      current = this.get(current.id);
    }
  }

  private async runDueTask(schedule: Schedule): Promise<void> {
    const lateBy = this.now() - schedule.nextRun;
    this.advance(schedule); // advance first, so a failing task does not retry every 30 seconds
    const answer = await this.runTask(schedule);
    const late = lateBy > LATE_MS ? ` _(late by ${Math.round(lateBy / 60_000)} min; this Mac was asleep)_` : "";
    await this.api.post(schedule.channelId, undefined, `🗓️ *${escape(schedule.text)}*${late}\n\n${answer}`);
  }

  /** Move a repeating schedule to its next run, or finish a one-time schedule. */
  private advance(schedule: Schedule): void {
    if (schedule.cron) {
      const next = nextCron(schedule.cron, schedule.tz, Math.max(this.now(), schedule.nextRun));
      this.db.prepare(`UPDATE schedules SET next_run = ?, slack_message_id = NULL WHERE id = ?`).run(next, schedule.id);
    } else {
      this.db.prepare(`UPDATE schedules SET active = 0 WHERE id = ?`).run(schedule.id);
    }
  }

  private get(id: number): Schedule | undefined {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ? AND active = 1`).get(id) as Row | undefined;
    return row ? toSchedule(row) : undefined;
  }

  private getAny(id: number): Schedule | undefined {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as Row | undefined;
    return row ? toSchedule(row) : undefined;
  }
}

/**
 * Resolve the model's time. Local wall time without an offset ("2026-11-10T09:00") is read in the
 * user's timezone, so a reminder after a DST change keeps its local hour. A time with an explicit
 * offset or "Z" is an exact instant and is used as is.
 */
export function parseLocalTime(at: string, tz: string): number {
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(at.trim())) return Date.parse(at);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at.trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map((part) => Number(part ?? 0));
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  // Find the instant whose local time in `tz` is `wall`. Two passes settle DST boundaries.
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}

function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return local - Math.floor(instant / 1000) * 1000;
}

export function nextCron(cron: string, tz: string, after: number): number {
  return CronExpressionParser.parse(cron, { currentDate: new Date(after), tz }).next().getTime();
}

/** One line per schedule, in the user's timezone, for the prompt. */
export function describe(schedule: Schedule): string {
  const when = new Date(schedule.nextRun).toLocaleString("en-US", {
    timeZone: schedule.tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const repeat = schedule.cron ? `, repeats (cron "${schedule.cron}")` : "";
  return `#${schedule.id} ${schedule.kind}: "${schedule.text}", next ${when}${repeat}`;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Row {
  id: number;
  user_id: string;
  channel_id: string;
  kind: "reminder" | "task";
  text: string;
  cron: string | null;
  tz: string;
  next_run: number;
  slack_message_id: string | null;
}

function toSchedule(row: Row): Schedule {
  return {
    id: row.id,
    userId: row.user_id,
    channelId: row.channel_id,
    kind: row.kind,
    text: row.text,
    cron: row.cron,
    tz: row.tz,
    nextRun: row.next_run,
    slackMessageId: row.slack_message_id,
  };
}
