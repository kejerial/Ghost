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
    const nextRun = spec.cron ? nextCron(spec.cron, context.tz, this.now()) : Date.parse(spec.at!);
    if (!Number.isFinite(nextRun)) throw new Error(`invalid time: ${spec.at}`);
    if (nextRun < this.now() - 60_000) throw new Error("that time is in the past");
    const result = this.db
      .prepare(`INSERT INTO schedules (user_id, channel_id, kind, text, cron, tz, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(context.userId, context.channelId, spec.kind, spec.text, spec.cron ?? null, context.tz, nextRun, this.now());
    const id = Number(result.lastInsertRowid);
    const schedule = this.get(id)!;
    if (schedule.kind === "reminder") await this.queueReminder(schedule);
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
      const rows = (this.db.prepare(`SELECT * FROM schedules WHERE active = 1`).all() as Row[]).map(toSchedule);
      for (const schedule of rows) {
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
