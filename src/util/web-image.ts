import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toJpeg } from "../slack/files.js";

const exec = promisify(execFile);

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** True for loopback, private, link-local, and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Refuse anything that is not a public https host, so the model can never reach this Mac or the local network. */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("only https images");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) throw new Error("local address");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error("local address");
}

/** GET a public URL. Redirects are followed one hop at a time, and each hop is checked. */
async function fetchPublic(rawUrl: string, fetchImpl: typeof fetch): Promise<{ response: Response; url: URL }> {
  let url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "Mozilla/5.0 Ghost" } });
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!next) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { response, url };
    }
    url = new URL(next, url);
  }
  throw new Error("too many redirects");
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
  /** Absolute image URLs on the page, with alt text or role ("icon", "og:image"). */
  images: { url: string; label: string }[];
}

const MAX_PAGE_CHARS = 12000;
const MAX_PAGE_IMAGES = 25;

/** Open a public web page: its title, readable text, and the images on it. */
export async function fetchWebPage(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<WebPage> {
  const { response, url } = await fetchPublic(rawUrl, fetchImpl);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("html") && !type.startsWith("text/")) throw new Error(`not a web page (${type || "unknown type"})`);
  const html = (await response.text()).slice(0, 3_000_000);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const images: WebPage["images"] = [];
  const add = (src: string | undefined, label: string) => {
    if (!src || src.startsWith("data:")) return;
    try {
      const abs = new URL(src, url).toString();
      if (!images.some((i) => i.url === abs)) images.push({ url: abs, label });
    } catch {
      // not a URL
    }
  };
  for (const tag of html.match(/<meta[^>]+>/gi) ?? []) if (/og:image|twitter:image/i.test(tag)) add(attr(tag, "content"), "og:image");
  for (const tag of html.match(/<link[^>]+>/gi) ?? []) if (/icon/i.test(attr(tag, "rel") ?? "")) add(attr(tag, "href"), "icon");
  for (const tag of html.match(/<img[^>]+>/gi) ?? []) add(attr(tag, "src"), attr(tag, "alt") || "image");
  const text = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  return { url: url.toString(), title, text: text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n…(truncated)` : text, images: images.slice(0, MAX_PAGE_IMAGES) };
}

/**
 * Download a public web image and convert it to a JPEG the model can see.
 * Returns the JPEG path inside `dir`.
 */
export async function fetchWebImage(rawUrl: string, dir: string, index: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { response } = await fetchPublic(rawUrl, fetchImpl);
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "unknown type"})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error("image larger than 25 MB");
  const original = join(dir, `web-${index}.${type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "img"}`);
  const jpeg = join(dir, `web-${index}.jpg`);
  await writeFile(original, body);
  if (type.includes("svg")) {
    // sips cannot read SVG. Quick Look renders it to "<name>.png" next to the original.
    await exec("qlmanage", ["-t", "-s", "1200", "-o", dir, original]);
    await toJpeg(`${original}.png`, jpeg);
    await rm(`${original}.png`, { force: true });
  } else await toJpeg(original, jpeg);
  await rm(original, { force: true });
  return jpeg;
}

export async function webImageDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ghost-web-images-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
