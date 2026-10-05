/**
 * The model asks Ghost to act by adding directive lines to its reply:
 *   <<remember: prefers short answers>>
 *   <<forget: short answers>>
 *   <<schedule: {"kind":"reminder","text":"Email the principal","at":"2026-10-06T09:00:00-04:00"}>>
 *   <<cancel: 12>>
 *   <<connect: linear>>   (open the sign-in page for a connection on the owner's Mac)
 * Ghost applies them and removes them from the posted text.
 */

export interface ScheduleSpec {
  kind: "reminder" | "task";
  text: string;
  /** One-time run: ISO 8601 with a UTC offset. */
  at?: string;
  /** Repeating run: 5-field cron in the asker's timezone. */
  cron?: string;
}

export type Directive =
  | { type: "remember"; text: string }
  | { type: "forget"; text: string }
  | { type: "schedule"; spec: ScheduleSpec }
  | { type: "cancel"; id: number }
  | { type: "connect"; name: string }
  | { type: "invalid"; raw: string; reason: string };

const PATTERN = /<<\s*(remember|forget|schedule|cancel|connect)\s*:\s*([\s\S]*?)>>/gi;

export function extractDirectives(modelText: string): { text: string; directives: Directive[] } {
  const directives: Directive[] = [];
  const text = modelText.replace(PATTERN, (raw, name: string, body: string) => {
    directives.push(parse(name.toLowerCase(), body.trim(), raw));
    return "";
  });
  return { text: text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), directives };
}

function parse(name: string, body: string, raw: string): Directive {
  if (name === "remember" || name === "forget") {
    return body ? { type: name, text: body } : { type: "invalid", raw, reason: "empty" };
  }
  if (name === "connect") {
    return /^[A-Za-z0-9_-]+$/.test(body) ? { type: "connect", name: body } : { type: "invalid", raw, reason: "bad connection name" };
  }
  if (name === "cancel") {
    const id = Number(body.replace(/^#/, ""));
    return Number.isInteger(id) && id > 0 ? { type: "cancel", id } : { type: "invalid", raw, reason: "bad id" };
  }
  try {
    const spec = JSON.parse(body) as Partial<ScheduleSpec>;
    if (spec.kind !== "reminder" && spec.kind !== "task") throw new Error("kind must be reminder or task");
    if (typeof spec.text !== "string" || !spec.text.trim()) throw new Error("text is required");
    if (!spec.at === !spec.cron) throw new Error("give exactly one of at or cron");
    return { type: "schedule", spec: { kind: spec.kind, text: spec.text.trim(), at: spec.at, cron: spec.cron } };
  } catch (error) {
    return { type: "invalid", raw, reason: error instanceof Error ? error.message : String(error) };
  }
}
