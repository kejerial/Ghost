import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJpeg } from "../slack/files.js";

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

/**
 * Download a public web image and convert it to a JPEG the model can see.
 * Returns the JPEG path inside `dir`. Redirects are followed one hop at a time, each one checked.
 */
export async function fetchWebImage(rawUrl: string, dir: string, index: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url = new URL(rawUrl);
  let response: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "Mozilla/5.0 Ghost" } });
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!next) break;
    url = new URL(next, url);
  }
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "error"}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "unknown type"})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error("image larger than 25 MB");
  const original = join(dir, `web-${index}.${type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "img"}`);
  const jpeg = join(dir, `web-${index}.jpg`);
  await writeFile(original, body);
  await toJpeg(original, jpeg);
  await rm(original, { force: true });
  return jpeg;
}

export async function webImageDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ghost-web-images-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
