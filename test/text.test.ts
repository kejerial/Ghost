import { describe, expect, it } from "vitest";
import { cleanSlackText, permalink, renderAnswer, stripMention } from "../src/slack/text.js";

describe("cleanSlackText", () => {
  const names: Record<string, string> = { U1: "Ana" };
  const resolve = (id: string) => names[id];

  it("resolves mentions, channels, links, and entities", () => {
    const raw = "<@U1> see <#C9|pricing> and <https://x.com/a|the doc> &amp; <https://y.com> &lt;3";
    expect(cleanSlackText(raw, resolve)).toBe("@Ana see #pricing and the doc (https://x.com/a) & https://y.com <3");
  });

  it("keeps the label for labeled mentions and falls back to the ID", () => {
    expect(cleanSlackText("<@U2|bob> and <@U3>", resolve)).toBe("@bob and @U3");
  });

  it("turns broadcast and group markup into plain text", () => {
    expect(cleanSlackText("<!here> <!channel> <!subteam^S1|@eng>")).toBe("@here @channel @eng");
  });
});

describe("permalink", () => {
  it("builds message and thread-reply links", () => {
    expect(permalink("https://acme.slack.com/", "C1", "1700000000.123456")).toBe(
      "https://acme.slack.com/archives/C1/p1700000000123456",
    );
    expect(permalink("https://acme.slack.com", "C1", "1700000001.000100", "1700000000.123456")).toBe(
      "https://acme.slack.com/archives/C1/p1700000001000100?thread_ts=1700000000.123456&cid=C1",
    );
  });
});

describe("renderAnswer", () => {
  const sources = [
    { id: "S1", url: "https://acme.slack.com/archives/C1/p1", label: "#pricing · Ana · 2026-03-01" },
    { id: "S2", url: "https://acme.slack.com/archives/C1/p2", label: "#pricing · Bo · 2026-09-01" },
  ];

  it("numbers citations by first use and lists only cited sources", () => {
    const { text, cited } = renderAnswer("We moved to annual [S2]. Earlier it was monthly [S1, S2].", sources);
    expect(cited).toBe(2);
    expect(text).toContain("annual <https://acme.slack.com/archives/C1/p2|[1]>.");
    expect(text).toContain("monthly <https://acme.slack.com/archives/C1/p1|[2]><https://acme.slack.com/archives/C1/p2|[1]>.");
    expect(text).toContain("*Sources*\n1. <https://acme.slack.com/archives/C1/p2|#pricing · Bo · 2026-09-01>\n2. <");
  });

  it("drops unknown citation IDs and adds no Sources list when nothing is cited", () => {
    const { text, cited } = renderAnswer("Generally, yes [S9].", sources);
    expect(cited).toBe(0);
    expect(text).toBe("Generally, yes .");
    expect(text).not.toContain("Sources");
  });

  it("neutralizes every Slack control sequence from the model", () => {
    const { text } = renderAnswer("<!channel> ping <@U123> and <https://evil.test|click> <!subteam^S1>", []);
    expect(text).not.toMatch(/<[!@#h]/);
    expect(text).toContain("&lt;!channel&gt;");
  });

  it("converts Markdown to Slack mrkdwn", () => {
    const { text } = renderAnswer("## Plan\n**Bold** and [docs](https://docs.test/a)\n> quoted", []);
    expect(text).toBe("*Plan*\n*Bold* and <https://docs.test/a|docs>\n> quoted");
  });

  it("does not turn non-http Markdown links into Slack links", () => {
    const { text } = renderAnswer("[x](javascript:alert(1))", []);
    expect(text).not.toContain("<javascript");
  });
});

describe("stripMention", () => {
  it("removes the bot mention anywhere in the text", () => {
    expect(stripMention("<@UGHOST> what did we decide?", "UGHOST")).toBe("what did we decide?");
    expect(stripMention("hey <@UGHOST|ghost>   summarize", "UGHOST")).toBe("hey summarize");
    expect(stripMention("<@UGHOST>", "UGHOST")).toBe("");
  });
});
