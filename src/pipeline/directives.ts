/**
 * The model asks Ghost to act by adding directive lines to its reply:
 *   <<remember: prefers short answers>>
 *   <<forget: short answers>>
 *   <<schedule: {"kind":"reminder","text":"Email the principal","at":"2026-10-06T09:00:00-04:00"}>>
 *   <<cancel: 12>>
 *   <<connect: linear>>   (open the sign-in page for a connection on the owner's Mac)
 *   <<canvas: {"id":"F123","action":"append","markdown":"## Notes\n- item"}>>
 *   <<slack: {"action":"pin","message":"S3"}>>   (pin, unpin, react, bookmark, topic, post, dm, invite, create_channel)
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

export type CanvasSpec =
  /** A new canvas tab in this channel. */
  | { action: "create"; title?: string; markdown: string }
  | { action: "append" | "prepend" | "replace"; id: string; markdown: string }
  | { action: "rename"; id: string; title: string }
  | { action: "delete"; id: string };

/** Channel actions. "message" is a source ID from the prompt, for example "S3". */
export type SlackActionSpec =
  | { action: "pin" | "unpin"; message: string }
  | { action: "react"; message: string; emoji: string }
  | { action: "bookmark"; title: string; url: string }
  | { action: "topic"; text: string }
  | { action: "post"; text: string }
  /** "person" is a name as it appears in Slack; Ghost looks up the account. */
  | { action: "dm"; person: string; text: string }
  | { action: "invite"; person: string }
  | { action: "create_channel"; name: string; private: boolean };

export type Directive =
  | { type: "remember"; text: string }
  | { type: "forget"; text: string }
  | { type: "schedule"; spec: ScheduleSpec }
  | { type: "cancel"; id: number }
  | { type: "connect"; name: string }
  | { type: "canvas"; spec: CanvasSpec }
  | { type: "slack"; spec: SlackActionSpec }
  | { type: "invalid"; raw: string; reason: string };

/** A directive ends at ">>" followed by the end of a line, so ">>" inside a value does not cut it short. */
const PATTERN = /<<\s*(remember|forget|schedule|cancel|connect|canvas|slack)\s*:\s*([\s\S]*?)>>(?=[ \t]*(?:\r?\n|$))/gi;

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
  if (name === "canvas" || name === "slack") {
    try {
      const spec = JSON.parse(body) as Record<string, unknown>;
      return name === "canvas" ? { type: "canvas", spec: canvasSpec(spec) } : { type: "slack", spec: slackSpec(spec) };
    } catch (error) {
      return { type: "invalid", raw, reason: error instanceof Error ? error.message : String(error) };
    }
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

const text = (spec: Record<string, unknown>, key: string): string => {
  const value = spec[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
};

const canvasId = (spec: Record<string, unknown>): string => {
  const id = text(spec, "id");
  if (!/^F[A-Z0-9]+$/.test(id)) throw new Error("bad canvas id");
  return id;
};

function canvasSpec(spec: Record<string, unknown>): CanvasSpec {
  switch (spec.action) {
    case "create":
      return { action: "create", title: typeof spec.title === "string" && spec.title.trim() ? spec.title.trim() : undefined, markdown: text(spec, "markdown") };
    case "append":
    case "prepend":
    case "replace":
      return { action: spec.action, id: canvasId(spec), markdown: text(spec, "markdown") };
    case "rename":
      return { action: "rename", id: canvasId(spec), title: text(spec, "title") };
    case "delete":
      return { action: "delete", id: canvasId(spec) };
    default:
      throw new Error("action must be create, append, prepend, replace, rename, or delete");
  }
}

function slackSpec(spec: Record<string, unknown>): SlackActionSpec {
  const message = () => {
    const id = text(spec, "message");
    if (!/^S\d+$/.test(id)) throw new Error("message must be a source ID like S3");
    return id;
  };
  switch (spec.action) {
    case "pin":
    case "unpin":
      return { action: spec.action, message: message() };
    case "react":
      return { action: "react", message: message(), emoji: text(spec, "emoji").replace(/^:|:$/g, "") };
    case "bookmark": {
      const url = text(spec, "url");
      if (!/^https:\/\//.test(url)) throw new Error("bookmark url must start with https://");
      return { action: "bookmark", title: text(spec, "title"), url };
    }
    case "topic":
      return { action: "topic", text: text(spec, "text") };
    case "post":
      return { action: "post", text: text(spec, "text") };
    case "dm":
      return { action: "dm", person: text(spec, "person"), text: text(spec, "text") };
    case "invite":
      return { action: "invite", person: text(spec, "person") };
    case "create_channel": {
      const name = text(spec, "name").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]+/g, "-").slice(0, 80);
      return { action: "create_channel", name, private: spec.private === true };
    }
    default:
      throw new Error("action must be pin, unpin, react, bookmark, topic, post, dm, invite, or create_channel");
  }
}
