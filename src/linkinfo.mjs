import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
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
// Raised from 256KB after a real miss: YouTube's <head> is padded with so much inline config that
// its <title> sits past 263KB, so the read was capped before ever reaching the metadata and the
// link came back with nothing. The early stop below means a normal page still costs a fraction of
// this — the cap is the ceiling, not the usual read.
const MAX_BYTES = 768 * 1024;
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

// Called by the socket layer at connect time, which is the whole point: an earlier version checked
// with dns.lookup() and then let fetch() resolve the name a second time on its own. Between those
// two resolutions a hostile nameserver answering with a zero TTL can return a public address to the
// check and a private one to the actual connection — DNS rebinding, and the guard never sees it.
// Validating inside the connect path means the address approved here is the address dialled.
function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    // Reject if *any* answer is private, not just the first: a name that resolves to both a public
    // and a private address must not be reachable by retry or by happening to pick the other one.
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(new Error(`refusing link to private address ${bad.address}`));
    if (!list.length) return callback(new Error("no addresses"));
    return options.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
  });
}

// node:http(s) rather than fetch, purely because fetch offers no way to pin or hook name
// resolution — `lookup` is the only place this check can live without a race.
function httpGet(url, headers) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error(`refusing ${url.protocol} link`));
  }
  // A literal private IP never reaches guardedLookup (there is no name to resolve), so it is
  // checked here instead.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isPrivateAddress(literal)) {
    return Promise.reject(new Error(`refusing link to private address ${literal}`));
  }
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = mod.request(url, { headers, lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total <= MAX_BYTES) chunks.push(chunk);
        // Past the cap the rest of the page is of no interest, and a stream that never ends must
        // not be able to hold this open until the timeout.
        else return res.destroy();
        // Everything this reads for lives in <head>, so the body is dead weight — on a long article
        // that is the difference between a few KB and the whole page. Checking the chunk rather
        // than the accumulated buffer keeps this O(n): a tag split across a chunk boundary is
        // simply missed, and then the read just continues to the cap as before.
        if (chunk.includes("</head>") || chunk.includes("</HEAD>")) res.destroy();
      });
      const finish = () =>
        done(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", () => done(reject, new Error("response stream error")));
    });
    request.on("timeout", () => {
      request.destroy(new Error("timed out"));
    });
    request.on("error", (err) => done(reject, err));
    request.end();
  });
}

// Redirects are followed by hand so every hop goes back through httpGet, and therefore back through
// guardedLookup. Letting the http layer follow them would skip the check on every hop after the
// first.
async function fetchChecked(startUrl, headers = BROWSER_HEADERS) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await httpGet(url, headers);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Error("too many redirects");
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

// YouTube publishes oEmbed, which returns the title and channel as a few hundred bytes of JSON.
// Worth special-casing even with the cap raised: scraping a video page means pulling most of a
// megabyte to find one tag, and the oEmbed answer is both smaller and more reliable.
const YOUTUBE_RE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/)|youtu\.be\/)/i;

// Exported for the test: the routing decision is the part that broke, and asserting it needs no
// network.
export const youtubeUrlForTest = (url) => YOUTUBE_RE.test(url);

async function youtubeInfo(url) {
  const { response } = await fetchChecked(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    API_HEADERS,
  );
  if (response.status !== 200) throw new Error(`oembed ${response.status}`);
  const d = JSON.parse(response.body);
  return { site: "youtube.com", title: d.title ?? "(untitled)", description: d.author_name ?? "" };
}

async function tweetInfo(match) {
  const [, user, id] = match;
  const { response } = await fetchChecked(`https://api.vxtwitter.com/${user}/status/${id}`, API_HEADERS);
  if (response.status !== 200) throw new Error(`vxtwitter ${response.status}`);
  const d = JSON.parse(response.body);
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
    if (YOUTUBE_RE.test(url)) return await youtubeInfo(url);
    const { response, finalUrl } = await fetchChecked(url);
    if (response.status !== 200) return null;
    const type = response.headers["content-type"] ?? "";
    if (!type.includes("html") && !type.includes("xml")) {
      // A direct file (PDF, image, video). The type is more informative than an absent title.
      return { site: finalUrl.hostname, title: `${type.split(";")[0] || "file"}`, description: "" };
    }
    const html = response.body;
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

// A link preview for an *outgoing* message, in the shape Baileys puts on the wire.
//
// Baileys can build these itself, but only via the optional `link-preview-js` peer dependency,
// which brings cheerio and around twenty transitive packages with it — a lot of supply-chain
// surface for a cosmetic card, in a repo whose dependency policy exists precisely because packages
// are treated as risk. sendMessage uses `message.linkPreview` directly when it is supplied and only
// generates one when it is absent (Utils/messages.js), so handing it ours skips the dependency and
// reuses the fetcher above, guards and all.
//
// No jpegThumbnail: fetching and re-encoding an image is a different order of work, and a preview
// card with a title and description is already the difference between a bare URL and something
// readable. The field is optional and WhatsApp renders fine without it.
export async function buildUrlInfo(text) {
  const [url] = extractUrls(text);
  if (!url) return null;
  const info = await fetchLinkInfo(url);
  if (!info?.title) return null;
  return {
    "canonical-url": url,
    "matched-text": url,
    title: info.title,
    ...(info.description ? { description: info.description } : {}),
  };
}
