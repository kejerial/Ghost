import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { FileReader, tableBlocksText, type SlackFile } from "../src/slack/files.js";
import { Ghost, type GhostDeps } from "../src/pipeline/ghost.js";
import { FtsRetriever } from "../src/retrieval/search.js";
import { UserDirectory } from "../src/slack/users.js";
import { Limiter } from "../src/util/limiter.js";
import { BOT_ID, BOT_USER, FakeBackend, FakeSlack, memoryStore, TEAM_URL, tempProfiles, tsDaysAgo } from "./fakes.js";

/** A one-page PDF. With `text`, the page has a real text layer; without it, the page is blank (like a scan). */
function pdf(text?: string): Buffer {
  const content = text ? `BT /F1 12 Tf 40 700 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function fakeFetch(files: Record<string, { body: Buffer; type: string }>, calls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    const f = files[url];
    if (!f) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(f.body), { status: 200, headers: { "content-type": f.type } });
  }) as typeof fetch;
}

const file = (id: string, filetype: string, extra: Partial<SlackFile> = {}): SlackFile => ({
  id,
  name: `${id}.${filetype}`,
  filetype,
  size: 100,
  url_private_download: `https://files.slack.com/${id}`,
  ...extra,
});

async function xlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Pipeline");
  sheet.addRow(["Company", "Stage", "ARR"]);
  sheet.addRow(["Acme", "Pilot", 12000]);
  sheet.addRow(["Globex", "Closed", { formula: "1+1", result: 2 }]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("FileReader", () => {
  it("extracts text from PDF, Word, Excel, and CSV files, and turns images into JPEGs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-files-"));
    const txt = join(dir, "memo.txt");
    writeFileSync(txt, "Memo: the Lin pilot starts November 3.");
    execFileSync("textutil", ["-convert", "docx", txt, "-output", join(dir, "memo.docx")]);
    const reader = new FileReader(
      "xoxb-test",
      join(dir, "cache"),
      fakeFetch({
        "https://files.slack.com/FPDF": { body: pdf("Invoice total 4200 dollars for Acme Corp due November 3"), type: "application/pdf" },
        "https://files.slack.com/FDOC": { body: readFileSync(join(dir, "memo.docx")), type: "application/octet-stream" },
        "https://files.slack.com/FXLS": { body: await xlsx(), type: "application/octet-stream" },
        "https://files.slack.com/FCSV": { body: Buffer.from("name,score\nAna,9\n"), type: "text/csv" },
        "https://files.slack.com/FPNG": { body: PNG_1PX, type: "image/png" },
      }),
    );

    expect((await reader.read(file("FPDF", "pdf"))).text).toContain("Invoice total 4200 dollars");
    expect((await reader.read(file("FDOC", "docx"))).text).toContain("the Lin pilot starts November 3");
    const sheet = (await reader.read(file("FXLS", "xlsx"))).text!;
    expect(sheet).toContain('sheet "Pipeline"');
    expect(sheet).toContain("Acme | Pilot | 12000");
    expect(sheet).toContain("Globex | Closed | 2");
    expect((await reader.read(file("FCSV", "csv"))).text).toBe("name,score\nAna,9");
    const image = await reader.read(file("FPNG", "png"));
    expect(image.imagePath).toMatch(/image\.jpg$/);
    expect(existsSync(image.imagePath!)).toBe(true);
  });

  it("sends a scanned PDF (no text layer) as an image of its first page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-files-"));
    const reader = new FileReader("xoxb-test", dir, fakeFetch({ "https://files.slack.com/FSCAN": { body: pdf(), type: "application/pdf" } }));
    const scan = await reader.read(file("FSCAN", "pdf"));
    expect(scan.imagePath).toMatch(/image\.jpg$/);
    expect(scan.note).toBeUndefined();
  });

  it("returns an absolute image path, because the model runs in another folder", async () => {
    const dir = relative(process.cwd(), mkdtempSync(join(tmpdir(), "ghost-files-")));
    const reader = new FileReader("xoxb-test", dir, fakeFetch({ "https://files.slack.com/FSCAN": { body: pdf(), type: "application/pdf" } }));
    const scan = await reader.read(file("FSCAN", "pdf"));
    expect(isAbsolute(scan.imagePath!)).toBe(true);
  });

  it("caches by file ID, so a follow-up question does not download again", async () => {
    const calls: string[] = [];
    const reader = new FileReader(
      "xoxb-test",
      mkdtempSync(join(tmpdir(), "ghost-files-")),
      fakeFetch({ "https://files.slack.com/FCSV": { body: Buffer.from("a,b\n1,2"), type: "text/csv" } }, calls),
    );
    await reader.read(file("FCSV", "csv"));
    expect((await reader.read(file("FCSV", "csv"))).text).toBe("a,b\n1,2");
    expect(calls).toHaveLength(1);
  });

  it("explains files it cannot read instead of failing", async () => {
    const reader = new FileReader(
      "xoxb-test",
      mkdtempSync(join(tmpdir(), "ghost-files-")),
      fakeFetch({ "https://files.slack.com/FAUTH": { body: Buffer.from("<html>sign in</html>"), type: "text/html; charset=utf-8" } }),
    );
    expect((await reader.read(file("FAUTH", "pdf"))).note).toContain("files:read");
    expect((await reader.read(file("FZIP", "zip"))).note).toContain("unsupported file type");
    expect((await reader.read(file("FBIG", "pdf", { size: 30 * 1024 * 1024 }))).note).toContain("25 MB");
    expect((await reader.read(file("FEXT", "gdoc", { is_external: true }))).note).toContain("external");
    expect((await reader.read(file("FGONE", "pdf"))).note).toContain("HTTP 404");
  });
});

describe("tableBlocksText", () => {
  it("renders Slack table blocks as rows", () => {
    const cell = (text: string) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }] });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "ignored" } },
      { type: "table", rows: [[{ type: "raw_text", text: "Plan" }, { type: "raw_text", text: "Price" }], [cell("Pro"), cell("$49")]] },
    ];
    expect(tableBlocksText(blocks)).toBe("Plan | Price\nPro | $49");
    expect(tableBlocksText(undefined)).toBe("");
  });
});

describe("Ghost with attachments", () => {
  it("puts file text in the prompt and passes images to the model, newest and current files first", async () => {
    const slack = new FakeSlack();
    slack.addUser("UK", "Kevin");
    slack.addUser("U1", "Ana");
    slack.addChannel("CGEN", "general");
    const old = file("FCSV", "csv", { name: "pipeline.csv" });
    slack.say("CGEN", { ts: tsDaysAgo(0.2), user: "U1", text: "here's the pipeline", files: [old] });
    const store = memoryStore();
    const users = new UserDirectory(slack, store);
    const backend = new FakeBackend(() => "The scan shows a receipt.");
    const deps: GhostDeps = {
      api: slack,
      store,
      users,
      retriever: new FtsRetriever(store),
      backend,
      limiter: new Limiter(2),
      identity: { botUserId: BOT_USER, botId: BOT_ID, teamUrl: TEAM_URL },
      contextChars: 24000,
      modelTimeoutMs: 1000,
      profiles: tempProfiles(),
      files: new FileReader(
        "xoxb-test",
        mkdtempSync(join(tmpdir(), "ghost-files-")),
        fakeFetch({
          "https://files.slack.com/FCSV": { body: Buffer.from("company,stage\nAcme,pilot"), type: "text/csv" },
          "https://files.slack.com/FPNG": { body: PNG_1PX, type: "image/png" },
        }),
      ),
    };
    const ghost = new Ghost(deps);
    const ts = tsDaysAgo(0);
    const screenshot = file("FPNG", "png", { name: "receipt.png" });
    slack.say("CGEN", { ts, user: "UK", text: "", files: [screenshot] });

    // A file with no message text in a chat channel still gets an answer.
    await ghost.handleMention({ channel: "CGEN", ts, user: "UK", text: "", files: [screenshot] }, "channel");

    const request = backend.requests[0]!;
    expect(request.images).toHaveLength(1);
    expect(request.prompt).toMatch(/<file name="receipt.png" from="Kevin" \(in your message\)>\n\(shown to you as image 1\)/);
    expect(request.prompt).toContain('<file name="pipeline.csv" from="Ana">\ncompany,stage\nAcme,pilot');
    expect(request.prompt.indexOf("receipt.png")).toBeLessThan(request.prompt.indexOf('<file name="pipeline.csv"'));
    expect(request.prompt).toContain("here's the pipeline (attached: pipeline.csv)");
    expect(slack.posts.at(-1)?.text).toBe("The scan shows a receipt.");
  });
});
