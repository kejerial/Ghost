import type { Store } from "../store/db.js";
import { errorFields, log } from "../log.js";
import type { SlackApi } from "./api.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolves Slack user IDs to display names. Caches in memory and in SQLite. */
export class UserDirectory {
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly api: SlackApi,
    private readonly store: Store,
  ) {}

  /** Synchronous lookup for text cleaning. Returns undefined when the name is not cached yet. */
  cached(userId: string): string | undefined {
    return this.memory.get(userId) ?? this.store.getUser(userId)?.name;
  }

  async name(userId: string): Promise<string> {
    const hit = this.memory.get(userId);
    if (hit) return hit;
    const stored = this.store.getUser(userId);
    if (stored && Date.now() - stored.updatedAt < TTL_MS) {
      this.memory.set(userId, stored.name);
      return stored.name;
    }
    try {
      const user = await this.api.userInfo(userId);
      this.store.upsertUser(user.id, user.name, user.isBot);
      this.memory.set(userId, user.name);
      return user.name;
    } catch (error) {
      log.warn("users.info failed", { userId, ...errorFields(error) });
      return stored?.name ?? userId;
    }
  }

  /** Load names for every user ID that appears as an author or a mention in `texts`. */
  async warm(userIds: Iterable<string | undefined>, texts: Iterable<string | undefined> = []): Promise<void> {
    const ids = new Set<string>();
    for (const id of userIds) if (id) ids.add(id);
    for (const text of texts) for (const m of text?.matchAll(/<@([UW][A-Z0-9]+)/g) ?? []) ids.add(m[1]!);
    await Promise.all([...ids].map((id) => this.name(id)));
  }
}
