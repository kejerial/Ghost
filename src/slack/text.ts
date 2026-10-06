/**
 * Slack text helpers: clean incoming mrkdwn for indexing and prompting,
 * and render model output as safe Slack mrkdwn.
 */

export type NameResolver = (id: string) => string | undefined;

/** Convert Slack markup in an incoming message into plain readable text. */
export function cleanSlackText(raw: string, userName: NameResolver = () => undefined): string {
  const text = raw
    // <@U123|name> or <@U123>
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${label ?? userName(id) ?? id}`)
    // <#C123|name> or <#C123>
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `#${label || id}`)
    // <!subteam^S123|@group>, <!here>, <!channel>, <!date^...|fallback>
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, label?: string) => label ?? "@group")
    .replace(/<!date\^[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, "@$1")
    // <https://x|label> or <https://x> or <mailto:a@b|a@b>
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
      label === url || url === `mailto:${label}` ? label : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1");
  return decodeEntities(text).trim();
}

export function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build a Slack message permalink without an API call. */
export function permalink(teamUrl: string, channelId: string, ts: string, threadTs?: string): string {
  const base = teamUrl.endsWith("/") ? teamUrl : `${teamUrl}/`;
  const url = `${base}archives/${channelId}/p${ts.replace(".", "")}`;
  if (threadTs && threadTs !== ts) return `${url}?thread_ts=${threadTs}&cid=${channelId}`;
  return url;
}

export interface CitableSource {
  /** Prompt-side ID, for example "S3". */
  id: string;
  url: string;
  label: string;
}

/**
 * Render model output as Slack mrkdwn.
 *
 * The function escapes all model text first. This removes every Slack control
 * sequence the model could emit (<!channel>, <@U123>, <url|label>). After
 * that, the only markup in the message is markup that this function creates:
 * citation links and http(s) links from Markdown link syntax.
 */
export function renderAnswer(modelText: string, sources: CitableSource[]): { text: string; cited: number } {
  const byId = new Map(sources.map((s) => [s.id.toUpperCase(), s]));
  const cited: CitableSource[] = [];
  const numberOf = (source: CitableSource): number => {
    const index = cited.indexOf(source);
    if (index >= 0) return index + 1;
    cited.push(source);
    return cited.length;
  };

  const webSources = new Map<string, CitableSource>();
  let text = escapeMrkdwn(modelText.trim());

  // Keep blockquotes: a ">" at the start of a line is formatting, not a control sequence.
  text = text.replace(/^&gt; /gm, "> ");

  // [S1], [S1, S4], [S1][S2] → numbered Slack links. Unknown IDs disappear.
  text = text.replace(/\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/gi, (_m, group: string) => {
    const links = group
      .split(/[,;]/)
      .map((id) => byId.get(id.trim().toUpperCase()))
      .filter((s): s is CitableSource => s !== undefined)
      .map((s) => `<${s.url}|[${numberOf(s)}]>`);
    return links.join("");
  });

  // Markdown → Slack mrkdwn.
  text = text
    // Web links become numbered citations too. The label stays in the sentence; the number is the link.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)|]+)\)/g, (_m, label: string, url: string) => {
      const source = webSources.get(url) ?? { id: url, url, label: decodeEntities(label) };
      webSources.set(url, source);
      return `${label} <${url}|[${numberOf(source)}]>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");

  // No sources list at the end: each inline [n] already links to its source.
  return { text: truncate(text, 12000), cited: cited.length };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20).trimEnd()}\n… (truncated)`;
}

/** Remove the bot mention from the question text. */
export function stripMention(raw: string, botUserId: string): string {
  return raw.replace(new RegExp(`<@${botUserId}(?:\\|[^>]+)?>`, "g"), " ").replace(/\s+/g, " ").trim();
}

export function formatDate(ts: string): string {
  const date = new Date(Number(ts) * 1000);
  return date.toISOString().slice(0, 10);
}
