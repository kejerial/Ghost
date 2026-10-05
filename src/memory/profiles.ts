import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MEMORIES = "## Memories";
const MAX_PROMPT_CHARS = 6000;
const MAX_MEMORY_CHARS = 3000;
const MIN_FORGET_CHARS = 3;

/**
 * One editable Markdown file per Slack user: `data/profiles/<USER_ID>.md`.
 * The top part is the profile (who they are). The "## Memories" section holds
 * dated facts and preferences that Ghost adds when the user says "remember".
 */
export class Profiles {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(userId: string): string {
    if (!/^[UW][A-Z0-9]+$/.test(userId)) throw new Error(`invalid user id: ${userId}`);
    return join(this.dir, `${userId}.md`);
  }

  exists(userId: string): boolean {
    return existsSync(this.path(userId));
  }

  read(userId: string): string | undefined {
    if (!this.exists(userId)) return undefined;
    const text = readFileSync(this.path(userId), "utf8").trim();
    if (text.length <= MAX_PROMPT_CHARS) return text;
    // Over the cap: keep the newest memories (they are appended last), then fill with the profile body.
    const [head = "", tail = ""] = text.split(MEMORIES);
    const memories: string[] = [];
    let used = 0;
    for (const line of tail.split("\n").filter((l) => l.startsWith("- ")).reverse()) {
      if (used + line.length + 1 > MAX_MEMORY_CHARS) break;
      memories.unshift(line);
      used += line.length + 1;
    }
    const body = head.trim().slice(0, MAX_PROMPT_CHARS - used - MEMORIES.length - 10);
    return `${body}\n…\n\n${MEMORIES}\n${memories.join("\n")}`;
  }

  /** Write a new profile body. Existing memories are kept. */
  writeProfile(userId: string, name: string, body: string): void {
    const memories = this.memoryLines(userId);
    const profile = body.trim() ? `${body.trim()}\n\n` : "";
    writeFileSync(this.path(userId), `# ${name}\n\n${profile}${MEMORIES}\n${memories.join("\n")}${memories.length ? "\n" : ""}`);
  }

  remember(userId: string, name: string, fact: string, now = new Date()): void {
    if (!this.exists(userId)) this.writeProfile(userId, name, "");
    const line = `- ${now.toISOString().slice(0, 10)}: ${fact.replace(/\s+/g, " ").trim()}`;
    const text = readFileSync(this.path(userId), "utf8");
    const withSection = text.includes(MEMORIES) ? text : `${text.trimEnd()}\n\n${MEMORIES}\n`;
    writeFileSync(this.path(userId), `${withSection.trimEnd()}\n${line}\n`);
  }

  /** Remove memory lines that contain `phrase` (case-insensitive). Returns how many were removed. */
  forget(userId: string, phrase: string): number {
    const needle = phrase.trim().toLowerCase();
    if (!this.exists(userId) || needle.length < MIN_FORGET_CHARS) return 0;
    const text = readFileSync(this.path(userId), "utf8");
    const [head, tail = ""] = text.split(MEMORIES);
    const lines = tail.split("\n");
    // Match the memory text only, not the "- 2026-10-05: " date prefix.
    const memoryText = (line: string) => line.replace(/^- \d{4}-\d{2}-\d{2}: /, "").toLowerCase();
    const kept = lines.filter((l) => !(l.startsWith("- ") && memoryText(l).includes(needle)));
    if (kept.length === lines.length) return 0;
    writeFileSync(this.path(userId), `${head}${MEMORIES}${kept.join("\n")}`);
    return lines.length - kept.length;
  }

  private memoryLines(userId: string): string[] {
    if (!this.exists(userId)) return [];
    const [, tail = ""] = readFileSync(this.path(userId), "utf8").split(MEMORIES);
    return tail.split("\n").filter((l) => l.startsWith("- "));
  }
}

export const PROFILE_PROMPT = `You write a short profile of one Slack user from messages they wrote. Ghost, their assistant, reads this profile before every answer.

Write Markdown with these sections, and include only facts the messages support:
## Who they are
Role, company, team, location if stated.
## Current work
Projects, customers, goals, deadlines.
## People
Who they work with most and in what capacity.
## Style and preferences
How they write and what they seem to care about.
## Open threads
Unresolved questions or todos they mentioned.

Keep it under 250 words. Use short bullets. Do not invent anything. Output only the Markdown.`;
