import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Turns a bare URL in a message into something a reader (or a search) can act on: the title and
// site land on the row next to the link, the same way OCR text lands next to an image. Before this,
// a chat full of shared links was a chat full of opaque `x.com/.../status/2099...` strings, and the
// only way to know what any of them were was to open them one at a time.
//
// What this costs, stated plainly because it is the one thing here that reaches outside the
// machine: fetching a link tells that server the link was received, and from which IP. For a link
// someone sends you that is usually harmless, but a sender who controls the host learns their
// message arrived even if it is never opened or replied to. `no_link_preview_jids` in
// state/config.json turns it off per chat for exactly that reason.

const MAX_URLS_PER_MESSAGE = 2;
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 256 * 1024; // enough for any <head>; a huge page is not worth reading to the end
const MAX_REDIRECTS = 3;

// Identifying as a normal browser is what gets a useful <head> back; many sites serve a stub or a
// block page to anything that looks automated.
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};
// ...except on a plain JSON API, where the browser user-agent is what gets refused: vxtwitter sits
// behind Cloudflare, which answers a browser-looking UA with a 403 challenge page and a plain one
// with the JSON. Measured, not guessed — the browser UA returned 403 and this returns 200.
const API_HEADERS = { "user-agent": "whatsapp-mcp-personal/0.1", accept: "application/json" };

// Deliberately conservative: trailing punctuation is far more likely to be a sentence ending than
// part of the URL, and over-trimming costs a preview while under-trimming fetches a 404.
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractUrls(text) {
  if (typeof text !== "string") return [];
  const seen = new Set();
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[).,;:!?\]]+$/, "");
    if (!seen.has(url)) seen.add(url);
    if (seen.size >= MAX_URLS_PER_MESSAGE) break;
  }
  return [...seen];
}

// Anything that resolves inside the network this machine sits on. A message is untrusted input from
// whoever is on the other end of the chat, so a link is an instruction to make this server issue a
// request — "http://192.168.1.1/reboot" or a cloud metadata endpoint is the obvious abuse, and it
// costs nothing to refuse.
function isPrivateAddress(ip) {
  if (ip === "::1" || ip === "0.0.0.0") return true;
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    // Unique-local (fc00::/7) and link-local (fe80::/10), plus IPv4-mapped forms handled below.
    if (
      /^f[cd]/.test(v6) ||
      v6.startsWith("fe8") ||
      v6.startsWith("fe9") ||
      v6.startsWith("fea") ||
      v6.startsWith("feb")
    )
      return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, and where cloud metadata lives
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

async function assertPublic(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`refusing ${url.protocol} link`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // A literal IP needs no lookup, and passing one to dns.lookup would happily "resolve" it.
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`refusing link to a private address`);
}

// Redirects are followed by hand rather than by fetch, because fetch's own redirect handling would
// re-resolve each hop without the check above — a public URL that 302s to 169.254.169.254 would
// walk straight past the guard. Every hop is validated.
async function fetchChecked(startUrl, headers = BROWSER_HEADERS) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Error("too many redirects");
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  // Release the socket rather than waiting for the rest of a page that is already past the cap.
  await reader.cancel().catch(() => {});
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map(Buffer.from)));
}

const decodeEntities = (s) =>
  s
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39|#x27);/g, "'")
    .replace(/&nbsp;/g, " ")
    // Numeric entities last, and after the named ones above, so an already-decoded "&" cannot be
    // re-read as the start of one. NVIDIA's own page title ships "&#x2d;" for a hyphen.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, " ")
    .trim();

const meta = (html, property) => {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const alt = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${property}["']`,
    "i",
  );
  return re.exec(html)?.[1] ?? alt.exec(html)?.[1] ?? null;
};

// x.com serves no useful metadata without authentication (it 402s or returns an app shell), so the
// one special case: vxtwitter's read-only JSON mirror of a public tweet, which is what this would
// otherwise have to be done by hand every time a tweet is shared.
const TWEET_RE = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([^/]+)\/status\/(\d+)/i;

async function tweetInfo(match) {
  const [, user, id] = match;
  const { response } = await fetchChecked(`https://api.vxtwitter.com/${user}/status/${id}`, API_HEADERS);
  if (!response.ok) throw new Error(`vxtwitter ${response.status}`);
  const d = JSON.parse(await readCapped(response));
  const media = (d.media_extended ?? []).map((m) => m.type);
  const kinds = media.length ? ` [${[...new Set(media)].join(", ")}]` : "";
  return {
    site: "x.com",
    title: `@${d.user_screen_name ?? user}`,
    description: `${(d.text ?? "").replace(/\s+/g, " ").trim()}${kinds}`,
  };
}

// Never throws: enrichment is a bonus on top of the message, and a link that cannot be fetched must
// not be able to affect whether the message itself is logged.
export async function fetchLinkInfo(url) {
  try {
    const tweet = TWEET_RE.exec(url);
    if (tweet) return await tweetInfo(tweet);
    const { response, finalUrl } = await fetchChecked(url);
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("xml")) {
      // A direct file (PDF, image, video). The type is more informative than an absent title.
      return { site: finalUrl.hostname, title: `${type.split(";")[0] || "file"}`, description: "" };
    }
    const html = await readCapped(response);
    const title =
      meta(html, "og:title") ?? meta(html, "twitter:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    if (!title) return null;
    return {
      site: finalUrl.hostname.replace(/^www\./, ""),
      title: decodeEntities(title).slice(0, 200),
      description: decodeEntities(meta(html, "og:description") ?? meta(html, "description") ?? "").slice(0, 300),
    };
  } catch {
    return null;
  }
}

// Marked the same way OCR output is, and for the same reason: this is what a machine read off
// somewhere else, not what the sender typed, and a reader quoting it back should be able to tell.
export function renderLinkInfo(info) {
  if (!info) return null;
  const head = `[link: ${info.site}] ${info.title}`;
  return info.description ? `${head}\n${info.description}` : head;
}

export async function enrichLinks(text) {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;
  const infos = await Promise.all(urls.map((u) => fetchLinkInfo(u)));
  const rendered = infos.map(renderLinkInfo).filter(Boolean);
  return rendered.length ? rendered.join("\n") : null;
}
