/**
 * Pick the connections a question needs, so each model call starts only those.
 * Codex starts every attached connection before it answers, so each one adds start-up time.
 * The match is cheap and local: no model call.
 */

/** Words that suggest a connection, keyed by a word in the connection's name. */
const HINTS: Record<string, string[]> = {
  github: ["github", "repo", "repos", "repository", "pr", "prs", "pull request", "commit", "commits", "branch", "code", "issue", "issues", "merge"],
  granola: ["granola", "meeting", "meetings", "call", "calls", "notes", "transcript", "standup", "sync", "1:1"],
  linear: ["linear", "ticket", "tickets", "issue", "issues", "sprint", "backlog", "task", "tasks", "bug", "bugs", "roadmap"],
  apollo: ["apollo", "lead", "leads", "prospect", "prospects", "contact", "contacts", "enrich", "sequence", "sequences", "outreach", "pipeline"],
  railway: ["railway", "deploy", "deployed", "deployment", "service", "services", "logs", "server", "prod", "staging"],
  vercel: ["vercel", "deploy", "deployed", "deployment", "preview", "domain", "site"],
  figma: ["figma", "design", "designs", "mockup", "mockups", "frame", "prototype"],
  context7: ["docs", "documentation", "library", "sdk", "api reference"],
  notion: ["notion", "doc", "docs", "wiki", "page"],
  slack: [],
};

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9:]+/g) ?? []);
}

/**
 * Return the connection names to attach. `text` is the question plus the last few
 * messages of the conversation, so a follow-up like "and the second one?" keeps
 * the connection that the previous answer used.
 */
export function pickConnections(available: string[], text: string): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = words(text);
  return available.filter((name) => {
    const parts = name.toLowerCase().split(/[-_]/).filter((p) => p && !["mcp", "remote", "server"].includes(p));
    if (parts.some((p) => tokens.has(p))) return true; // the connection is named, e.g. "granola"
    const hints = parts.flatMap((p) => HINTS[p] ?? []);
    return hints.some((hint) => (hint.includes(" ") ? lower.includes(` ${hint} `) : tokens.has(hint)));
  });
}
