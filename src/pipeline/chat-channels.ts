import { errorFields, log } from "../log.js";
import type { SlackApi } from "../slack/api.js";
import type { UserDirectory } from "../slack/users.js";

const TTL_MS = 10 * 60 * 1000;

/**
 * Decides where Ghost chats without a tag. A channel is a chat channel when it is
 * GHOST_HOME_CHANNEL, or when the person writing is its only human member
 * (a personal channel with just you and Ghost). Membership is cached for 10 minutes.
 */
export class ChatChannels {
  private readonly cache = new Map<string, { humans: string[]; at: number }>();

  constructor(
    private readonly api: SlackApi,
    private readonly users: UserDirectory,
    private readonly botUserId: string,
    private readonly homeChannelId?: string,
  ) {}

  async isChat(channelId: string, userId: string | undefined): Promise<boolean> {
    if (channelId === this.homeChannelId) return true;
    if (!userId) return false;
    try {
      const humans = await this.humans(channelId);
      return humans.length === 1 && humans[0] === userId;
    } catch (error) {
      log.warn("channel member check failed", { channel: channelId, ...errorFields(error) });
      return false;
    }
  }

  /** Forget cached membership, for example when someone joins the channel. */
  forget(channelId: string): void {
    this.cache.delete(channelId);
  }

  private async humans(channelId: string): Promise<string[]> {
    const hit = this.cache.get(channelId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.humans;
    const members = (await this.api.channelMembers(channelId)).filter((id) => id !== this.botUserId);
    const flags = await Promise.all(members.map((id) => this.users.isBot(id)));
    const humans = members.filter((_, i) => !flags[i]);
    this.cache.set(channelId, { humans, at: Date.now() });
    return humans;
  }
}
