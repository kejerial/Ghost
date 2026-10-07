import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { log, errorFields } from "../log.js";

const exec = promisify(execFile);

/** The subset of a Slack file object that Ghost reads. */
export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  is_external?: boolean;
  mode?: string;
  /** Channels where the file is shared (from files.info). */
  channels?: string[];
  groups?: string[];
}

/** One attachment, ready for the prompt: extracted text, an image path, or a note on why it was skipped. */
export interface Attachment {
  id: string;
  name: string;
  text?: string;
  imagePath?: string;
  note?: string;
  /** Set for a Slack canvas: Ghost can edit it with this file ID. */
  canvasId?: string;
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 15000;
const IMAGE_MAX_PIXELS = 2000;
const CACHE_DAYS = 14;

const TEXT_TYPES = new Set(["text", "csv", "tsv", "markdown", "json", "javascript", "typescript", "python", "html", "xml", "yaml", "sql", "shell", "css", "go", "rust", "java", "swift", "ruby", "diff", "log"]);
const TEXTUTIL_TYPES = new Set(["docx", "doc", "rtf", "odt", "html", "webarchive"]);
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "bmp"]);

export const isCanvas = (f: SlackFile): boolean =>
  (f.filetype ?? "").toLowerCase() === "quip" || (f.mimetype ?? "").toLowerCase() === "application/vnd.slack-docs";

const kind = (f: SlackFile): "canvas" | "image" | "pdf" | "xlsx" | "textutil" | "text" | "other" => {
  const type = (f.filetype ?? "").toLowerCase();
  const mime = (f.mimetype ?? "").toLowerCase();
  if (isCanvas(f)) return "canvas";
  if (IMAGE_TYPES.has(type) || mime.startsWith("image/")) return "image";
  if (type === "pdf" || mime === "application/pdf") return "pdf";
  if (type === "xlsx" || type === "xls" || mime.includes("spreadsheetml")) return "xlsx";
  if (TEXTUTIL_TYPES.has(type)) return "textutil";
  if (TEXT_TYPES.has(type) || mime.startsWith("text/") || mime === "application/json") return "text";
  return "other";
};

const clip = (text: string) => {
  const t = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length <= MAX_TEXT_CHARS ? t : `${t.slice(0, MAX_TEXT_CHARS)}\n…(truncated)`;
};

/**
 * Downloads Slack files with the bot token (scope files:read) and turns them into text or images.
 * Results are cached per file ID under `dir`, so follow-up questions do not download again.
 */
export class FileReader {
  private readonly dir: string;

  constructor(
    private readonly token: string,
    dir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // Absolute, because the model runs in another folder and gets image paths as arguments.
    this.dir = resolve(dir);
  }

  async read(file: SlackFile): Promise<Attachment> {
    const name = file.name || file.title || file.id;
    const base: Attachment = { id: file.id, name };
    if (file.is_external || file.mode === "external") return { ...base, note: "external file (for example Google Drive); Ghost cannot open it" };
    if (file.mode === "tombstone" || file.mode === "hidden_by_limit") return { ...base, note: "file is deleted or hidden" };
    const k = kind(file);
    if (k === "other") return { ...base, note: `unsupported file type (${file.filetype ?? file.mimetype ?? "unknown"})` };
    if ((file.size ?? 0) > MAX_DOWNLOAD_BYTES) return { ...base, note: "file is larger than 25 MB" };

    if (k === "canvas") return this.readCanvas(file, base);

    const folder = join(this.dir, file.id.replace(/[^A-Za-z0-9]/g, ""));
    const cachedText = join(folder, "text.txt");
    const cachedImage = join(folder, "image.jpg");
    try {
      const [text, image] = await Promise.all([readFile(cachedText, "utf8").catch(() => undefined), exists(cachedImage)]);
      if (text !== undefined || image) return { ...base, text: text || undefined, imagePath: image ? cachedImage : undefined };

      await mkdir(folder, { recursive: true });
      const original = join(folder, `original.${(file.filetype || "bin").replace(/[^a-z0-9]/gi, "")}`);
      await this.download(file, original);
      const result = await this.extract(k, original, folder);
      if (result.text !== undefined) await writeFile(cachedText, result.text);
      if (result.image) await toJpeg(result.image, cachedImage);
      await rm(original, { force: true });
      if (result.image && result.image !== original) await rm(result.image, { force: true });
      if (!result.text && !result.image) return { ...base, note: "no readable content" };
      return { ...base, text: result.text || undefined, imagePath: result.image ? cachedImage : undefined };
    } catch (error) {
      log.warn("file read failed", { file: file.id, ...errorFields(error) });
      await rm(folder, { recursive: true, force: true });
      return { ...base, note: `could not read it (${error instanceof Error ? error.message : String(error)})` };
    }
  }

  /** Canvases change, so Ghost reads them fresh every time and never caches them. */
  private async readCanvas(file: SlackFile, base: Attachment): Promise<Attachment> {
    const folder = join(this.dir, `canvas-${file.id.replace(/[^A-Za-z0-9]/g, "")}-${process.pid}-${Date.now()}`);
    try {
      await mkdir(folder, { recursive: true });
      const html = join(folder, "canvas.html");
      await this.download(file, html);
      const { stdout } = await exec("textutil", ["-format", "html", "-inputencoding", "UTF-8", "-convert", "txt", "-stdout", html], { maxBuffer: 50 * 1024 * 1024 });
      return { ...base, canvasId: file.id, text: clip(stdout) || "(empty canvas)" };
    } catch (error) {
      log.warn("canvas read failed", { file: file.id, ...errorFields(error) });
      return { ...base, canvasId: file.id, note: `could not read the canvas (${error instanceof Error ? error.message : String(error)})` };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  private async download(file: SlackFile, path: string): Promise<void> {
    const url = file.url_private_download ?? file.url_private;
    if (!url) throw new Error("no download URL");
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    // Without files:read, Slack answers with its HTML sign-in page instead of the file.
    if ((response.headers.get("content-type") ?? "").includes("text/html") && !["text", "textutil", "canvas"].includes(kind(file))) {
      throw new Error("Slack returned a web page instead of the file; the app needs the files:read scope");
    }
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }

  private async extract(k: ReturnType<typeof kind>, path: string, folder: string): Promise<{ text?: string; image?: string }> {
    if (k === "image") return { image: path };
    if (k === "text") return { text: clip(await readFile(path, "utf8")) };
    if (k === "textutil") {
      const { stdout } = await exec("textutil", ["-convert", "txt", "-stdout", path], { maxBuffer: 50 * 1024 * 1024 });
      return { text: clip(stdout) };
    }
    if (k === "xlsx") return { text: clip(await spreadsheetText(path)) };
    // PDF: text layer first. A scanned PDF has none, so Ghost sends its first page as an image.
    const text = await pdfText(path);
    if (text.replace(/\s/g, "").length >= 40) return { text: clip(text) };
    const page = join(folder, "page1.png");
    await exec("sips", ["-s", "format", "png", path, "--out", page]);
    return { text: text.trim() || undefined, image: page };
  }

  /** Delete cached files older than two weeks. */
  async prune(now = Date.now()): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    for (const entry of entries) {
      const s = await stat(join(this.dir, entry)).catch(() => undefined);
      if (s && now - s.mtimeMs > CACHE_DAYS * 86_400_000) await rm(join(this.dir, entry), { recursive: true, force: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Convert to JPEG with the long side at most 2000 px (also handles HEIC). */
async function toJpeg(input: string, output: string): Promise<void> {
  await exec("sips", ["-s", "format", "jpeg", "-Z", String(IMAGE_MAX_PIXELS), input, "--out", output]);
}

async function pdfText(path: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((page, i) => `--- page ${i + 1} ---\n${page}`).join("\n");
}

async function spreadsheetText(path: string): Promise<string> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow((row) => {
      const values = (row.values as unknown[]).slice(1).map((v) => cellText(v));
      rows.push(values.join(" | "));
    });
    sheets.push(`--- sheet "${sheet.name}" ---\n${rows.join("\n")}`);
  });
  return sheets.join("\n\n");
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: string; richText?: { text: string }[]; hyperlink?: string };
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return cellText(v.result);
    if (v.text) return v.text;
    return "";
  }
  return String(value).replace(/\|/g, "/").replace(/\n/g, " ");
}

/** Slack table blocks are not in the message's plain `text`. Render them as "a | b" rows. */
export function tableBlocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const tables: string[] = [];
  for (const block of blocks as { type?: string; rows?: unknown[][] }[]) {
    if (block?.type !== "table" || !Array.isArray(block.rows)) continue;
    tables.push(block.rows.map((row) => (Array.isArray(row) ? row.map((cell) => collectText(cell).replace(/\|/g, "/")).join(" | ") : "")).join("\n"));
  }
  return tables.join("\n\n");
}

function collectText(node: unknown): string {
  if (typeof node === "string") return "";
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.url === "string" && o.type === "link") return o.url;
    return Object.values(o).map(collectText).join("");
  }
  return "";
}
