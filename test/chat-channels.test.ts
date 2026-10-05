import { describe, expect, it } from "vitest";
import { ChatChannels } from "../src/pipeline/chat-channels.js";
import { UserDirectory } from "../src/slack/users.js";
import { BOT_USER, FakeSlack, memoryStore } from "./fakes.js";

function setup(homeChannelId?: string) {
  const slack = new FakeSlack();
  slack.addUser("UK", "Kevin");
  slack.addUser("U2", "Bo");
  slack.users.set("UBOT2", { name: "otherbot", isBot: true });
  slack.addChannel("CSOLO", "kevin", { members: [BOT_USER, "UK", "UBOT2"] });
  slack.addChannel("CTEAM", "general", { members: [BOT_USER, "UK", "U2"] });
  const chat = new ChatChannels(slack, new UserDirectory(slack, memoryStore()), BOT_USER, homeChannelId);
  return { slack, chat };
}

describe("ChatChannels", () => {
  it("treats a channel where you are the only human as a chat channel, ignoring other bots", async () => {
    const { chat } = setup();
    expect(await chat.isChat("CSOLO", "UK")).toBe(true);
    expect(await chat.isChat("CTEAM", "UK")).toBe(false);
  });

  it("does not chat with someone else in your personal channel", async () => {
    const { chat } = setup();
    expect(await chat.isChat("CSOLO", "U2")).toBe(false);
  });

  it("honors the GHOST_HOME_CHANNEL override", async () => {
    const { chat } = setup("CTEAM");
    expect(await chat.isChat("CTEAM", "UK")).toBe(true);
  });

  it("caches membership and refreshes it after forget()", async () => {
    const { slack, chat } = setup();
    await chat.isChat("CSOLO", "UK");
    await chat.isChat("CSOLO", "UK");
    expect(slack.calls.filter((c) => c === "members:CSOLO")).toHaveLength(1);

    slack.channels.get("CSOLO")!.members.push("U2");
    chat.forget("CSOLO");
    expect(await chat.isChat("CSOLO", "UK")).toBe(false);
  });
});
