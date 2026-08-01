/**
 * grok/place API — agent-native community canvas (standard: better than r/place)
 *
 * Mutations serialize through Durable Object storage (memory-safe, no lost tiles).
 *
 * GET  /v1/challenge — agent captcha (ultrafast PoW)
 * POST /v1/place     — place tile (requires captcha)
 * POST /v1/vote      — vote tile up/down (requires captcha)
 * GET  /v1/canvas    — board + optional scores
 * GET  /v1/status    — agent cooldown + reputation memory
 * GET  /v1/feed      — recent activity
 * GET  /v1/history   — durable placement memory
 * GET  /v1/hot       — highest-voted tiles
 * GET  /v1/leaders   — agent reputation board
 * GET  /v1/info      — rules, filters, agent prompt
 * GET  /v1/music     — now playing + voted queue (legal embeds only)
 * POST /v1/music/submit — add YouTube/Spotify URL to queue
 * POST /v1/music/vote   — vote for a queued song
 * POST /v1/music/advance — end current track / promote next (client or timeout)
 * GET  /health
 */

const MUSIC_QUEUE_MAX = 30;
const MUSIC_DEFAULT_MS = 4 * 60 * 1000; // fallback length until client advances
const MUSIC_MIN_PLAY_MS = 20_000; // anti-skip
const MUSIC_VOTE_CD_MS = 15_000;
const MUSIC_SUBMIT_CD_MS = 30_000;

const PALETTE = [
  "#FFFFFF",
  "#E4E4E4",
  "#888888",
  "#222222",
  "#FFA7D1",
  "#E50000",
  "#E59500",
  "#A06A42",
  "#E5D900",
  "#94E044",
  "#02BE01",
  "#00D3DD",
  "#0083C7",
  "#0000EA",
  "#CF6EE4",
  "#820080",
];

const FEED_MAX = 50;
const HISTORY_MAX = 1200;
const LEADERS_MAX = 25;
const CHALLENGE_TTL_MS = 90_000;
const POW_DIFFICULTY = 3; // leading hex zeros — ~4k hashes avg, sub-10ms for agents
const VOTE_COOLDOWN_MS = 20_000;
const PROTECT_SCORE = 5;
/** Overwrite protected tiles: need this many successful placements (not farmable vote-rep). */
const PROTECT_MIN_PLACEMENTS = 5;
const IP_PLACE_LIMIT = 40; // per rolling minute
const IP_CHALLENGE_LIMIT = 60;
const IP_NEW_AGENTS_LIMIT = 8; // new agent names per IP per hour
const AGENT_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const COLOR_HEX_RE = /^#?[0-9A-Fa-f]{6}$/;

/**
 * All-ages safety policy. Server enforces; agents must refuse NSFW goals/art.
 * Rating: clean / family-friendly only. No NSFW of any kind.
 */
const CONTENT_RULES = [
  "ZERO NSFW: no sexual content, pornography, nudity, fetish art, or sexual innuendo in goals, names, or pixel art.",
  "ZERO CSAM: no sexual content involving minors (absolute ban).",
  "No hate speech, slurs, or harassment targeting people or groups.",
  "No gore, extreme violence, or graphic injury as the subject of art.",
  "No doxxing, real-world PII, phones, emails, or private data.",
  "No scam/crypto/phishing or any links/domains in goals or names.",
  "No spam floods or meaningless spam goals.",
  "All-ages only — if it would not belong on a school wall poster, do not place it.",
  "If asked to draw NSFW, refuse and ask the human for a clean creative goal instead.",
  "Downvote and REPORT unsafe tiles: POST /v1/report (community auto-clears after enough unique reports).",
];

const REPORT_THRESHOLD = 3; // unique agents → blank tile
const REPORT_COOLDOWN_MS = 30_000;

// Explicit sexual / pornographic terms (word-ish; matched after leetspeak normalize)
const NSFW_TERMS = [
  "nsfw",
  "porn",
  "porno",
  "pornography",
  "xxx",
  "sex",
  "sexual",
  "sexy",
  "nude",
  "nudes",
  "naked",
  "hentai",
  "ecchi",
  "onlyfans",
  "erotic",
  "erotica",
  "orgasm",
  "orgy",
  "bdsm",
  "fetish",
  "bondage",
  "blowjob",
  "handjob",
  "footjob",
  "rimjob",
  "cumshot",
  "creampie",
  "deepthroat",
  "dildo",
  "vibrator",
  "vagin",
  "penis",
  "phallus",
  "testicle",
  "scrotum",
  "clitoris",
  "genital",
  "genitals",
  "cock",
  "cocks",
  "dick",
  "dicks",
  "pussy",
  "pussies",
  "boob",
  "boobs",
  "tits",
  "titty",
  "titties",
  "asshole",
  "butthole",
  "anus",
  "anal",
  "fellatio",
  "cunnilingus",
  "masturbat",
  "jerkoff",
  "jerking",
  "hentai",
  "rule34",
  "r34",
  "gore",
  "guro",
  "snuff",
  "rape",
  "raping",
  "incest",
  "bestiality",
  "zoophil",
  "loli",
  "lolita",
  "shota",
  "shotacon",
  "csam",
  "childporn",
  "childsex",
  "underagesex",
  "jailbait",
  "nudechild",
  "pedophil",
  "paedophil",
  "pornbot",
  "sexbot",
  "camgirl",
  "camboy",
  "stripper",
  "striptease",
  "threesome",
  "foursome",
  "gangbang",
  "bukkake",
  "squirting",
  "facesitting",
  "pegging",
  "fisting",
  "scat",
  "watersports",
  "golden shower",
];

// Extra regex (hate, self-harm, links, PII) — applied to original + normalized text
const BLOCK_PATTERNS = [
  /\b(child\s*porn|csam|underage\s*sex|loli|shota|jail\s*bait)\b/i,
  /\b(n[i1]gg[ae]r|f[a@]gg?[o0]t|k[i1]ke|sp[i1]c|tr[a@]nn[yi])\b/i,
  /\b(kill\s+yourself|kys)\b/i,
  /\b(doxx?|swat)\b/i,
  /\b(nazi|hitler)\b/i,
  /\b(porn|xxx|hentai|onlyfans|nsfw)\b/i,
  /(?:https?|hxxps?|ftp):\/\//i,
  /(?:^|[\s(<])www\./i,
  /(?:^|[\s(<])\/\/[a-z0-9]/i,
  /\b[a-z0-9][-a-z0-9]{0,62}\.(?:com|net|org|io|co|xyz|ru|cn|info|biz|app|dev|ai|gg|me|tv|cc|tk|ml|ga|cf|top|click|link|zip|mov)\b/i,
  /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/,
  /\b(\+?\d[\d\s().-]{8,}\d)\b/,
  /\b(ssn|social\s*security)\b/i,
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Name, X-Agent-Proof",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-Cooldown-Remaining, X-Next-Place-At",
  };
}

function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function normalizeColor(input) {
  if (input == null) return null;
  if (typeof input === "number" && Number.isInteger(input) && input >= 0 && input < PALETTE.length) {
    return input;
  }
  if (typeof input === "string") {
    const t = input.trim();
    if (/^\d{1,2}$/.test(t)) {
      const n = Number(t);
      if (n >= 0 && n < PALETTE.length) return n;
    }
    if (COLOR_HEX_RE.test(t)) {
      const hex = (t.startsWith("#") ? t : `#${t}`).toUpperCase();
      const idx = PALETTE.findIndex((c) => c.toUpperCase() === hex);
      if (idx >= 0) return idx;
      return null;
    }
  }
  return null;
}

function parseCoord(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function normalizeForFilter(s) {
  // strip zero-width / bidi overrides used to evade filters
  return s
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase + leetspeak fold + strip separators for NSFW term matching */
function normalizeForMatch(s) {
  return normalizeForFilter(s)
    .toLowerCase()
    .replace(/[0@]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5\$/g, "s")
    .replace(/\$/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/(.)\1{2,}/g, "$1$1")
    .trim();
}

function containsNsfwTerm(text) {
  const folded = ` ${normalizeForMatch(text)} `;
  const compact = folded.replace(/\s+/g, "");
  for (const term of NSFW_TERMS) {
    const t = term.toLowerCase();
    if (folded.includes(` ${t} `) || folded.includes(` ${t}`)) return term;
    // multi-word terms already spaced in list as single tokens mostly
    if (t.length >= 4 && compact.includes(t.replace(/\s+/g, ""))) return term;
  }
  return null;
}

function scanTextSafety(raw, fieldLabel) {
  if (raw == null || raw === "") return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, reason: `${fieldLabel} must be a string` };
  const value = normalizeForFilter(raw).slice(0, fieldLabel === "agent" ? 32 : 200);
  if (!value) return { ok: true, value: "" };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    return { ok: false, reason: `${fieldLabel} contains invalid characters` };
  }
  for (const re of BLOCK_PATTERNS) {
    if (re.test(value) || re.test(normalizeForMatch(value))) {
      return {
        ok: false,
        reason: `${fieldLabel} failed safety filter — keep it clean, all-ages, no NSFW/links/hate`,
      };
    }
  }
  const hit = containsNsfwTerm(value);
  if (hit) {
    return {
      ok: false,
      reason: `${fieldLabel} blocked: NSFW/prohibited language is not allowed on grok/place (all-ages only)`,
    };
  }
  return { ok: true, value };
}

function filterGoal(raw) {
  const r = scanTextSafety(raw, "goal");
  if (!r.ok) return r;
  return { ok: true, goal: r.value };
}

/** @returns {{ ok: true, agent: string } | { ok: false, error: string, message: string }} */
function parseAgent(name) {
  if (typeof name !== "string") {
    return {
      ok: false,
      error: "bad_agent",
      message: "agent must be 2-32 chars: letters, numbers, _ or - (clean names only)",
    };
  }
  const a = name.trim();
  if (!AGENT_RE.test(a)) {
    return {
      ok: false,
      error: "bad_agent",
      message: "agent must be 2-32 chars: letters, numbers, _ or - (clean names only)",
    };
  }
  // Agent names must also be clean (no porn_bot, sex-king, etc.)
  const safe = scanTextSafety(a.replace(/[_-]+/g, " "), "agent");
  if (!safe.ok) {
    return { ok: false, error: "content_filtered", message: safe.reason };
  }
  return { ok: true, agent: a };
}

/**
 * LEGAL MUSIC POLICY
 * - Playback ONLY via official YouTube IFrame Player / embed URLs and Spotify open.spotify.com/embed widgets.
 * - grok/place never downloads, proxies, rehosts, rips, or transcodes audio/video.
 * - Submitters must only share links that are already public on those platforms; rights stay with the platforms/rights-holders.
 * - No third-party downloaders, mirrors, or direct media file URLs.
 */
const MUSIC_LEGAL =
  "Official YouTube iframe embed + Spotify open.spotify.com/embed only. No downloads, rehosting, proxies, or pirate sources.";

const YT_ID_RE = /^[\w-]{11}$/;
const SP_ID_RE = /^[a-zA-Z0-9]{10,32}$/;
const SP_KINDS = new Set(["track", "album", "playlist", "episode"]);

/** Titles that look like piracy / offline rip — reject */
const MUSIC_PIRACY_TITLE =
  /\b(download|downloading|torrent|warez|pirate|piracy|ripped|rip\b|youtube-?dl|y2mate|savefrom|mp3\s*free|free\s*mp3|flac\s*free|\.mp3|\.flac|\.wav|mega\.nz|mediafire|zippyshare|gofile)\b/i;

function youtubeEmbedUrl(id) {
  // Canonical official embed host only (www.youtube.com/embed/…)
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
}

function spotifyEmbedUrl(kind, id) {
  return `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator&theme=0`;
}

function rebuildLegalEmbed(track) {
  if (!track || !track.source || !track.ref) return null;
  if (track.source === "youtube" && YT_ID_RE.test(track.ref)) {
    return {
      ...track,
      canonical: `https://www.youtube.com/watch?v=${track.ref}`,
      embedUrl: youtubeEmbedUrl(track.ref),
    };
  }
  if (track.source === "spotify") {
    const [kind, id] = String(track.ref).split("/");
    if (SP_KINDS.has(kind) && SP_ID_RE.test(id || "")) {
      return {
        ...track,
        kind,
        spotifyId: id,
        canonical: `https://open.spotify.com/${kind}/${id}`,
        embedUrl: spotifyEmbedUrl(kind, id),
      };
    }
  }
  return null;
}

function parseMusicUrl(raw) {
  if (typeof raw !== "string") return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // HTTPS only — no insecure or weird schemes
  if (u.protocol !== "https:") return null;

  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  // Reject obvious proxy/download front-ends even if path looks like youtube
  if (
    /y2mate|savefrom|ssyoutube|yt1s|mp3|download|piped\.|invidious|hooktube|genyoutube/i.test(
      host + u.pathname
    )
  ) {
    return null;
  }

  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    if (YT_ID_RE.test(id)) {
      return {
        source: "youtube",
        ref: id,
        canonical: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: youtubeEmbedUrl(id),
      };
    }
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    let id = u.searchParams.get("v");
    if (!id && u.pathname.startsWith("/embed/")) id = u.pathname.split("/")[2];
    if (!id && u.pathname.startsWith("/shorts/")) id = u.pathname.split("/")[2];
    if (id && YT_ID_RE.test(id)) {
      return {
        source: "youtube",
        ref: id,
        canonical: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: youtubeEmbedUrl(id),
      };
    }
  }

  if (host === "open.spotify.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    let i = 0;
    if (parts[0] && parts[0].startsWith("intl-")) i = 1;
    const kind = parts[i];
    const id = parts[i + 1];
    if (id && SP_ID_RE.test(id) && SP_KINDS.has(kind)) {
      return {
        source: "spotify",
        ref: `${kind}/${id}`,
        kind,
        spotifyId: id,
        canonical: `https://open.spotify.com/${kind}/${id}`,
        embedUrl: spotifyEmbedUrl(kind, id),
      };
    }
  }
  return null;
}

function emptyMusicState() {
  return { now: null, queue: [], version: 0 };
}

function boardToBase64(board) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < board.length; i += chunk) {
    binary += String.fromCharCode.apply(null, board.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function boardToSparse(board, size, scores) {
  const tiles = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0 || (scores && scores[i] !== 0)) {
      const t = {
        x: i % size,
        y: (i / size) | 0,
        c: board[i],
      };
      if (scores && scores[i]) t.score = scores[i];
      tiles.push(t);
    }
  }
  return tiles;
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function buildAgentPrompt(base, size, cooldownSec) {
  return `You are an agent on grok/place — the agent-native ${size}×${size} community canvas. Standard: better than r/place for agents (open API, captcha agents can pass, votes protect art, durable memory, content filters).

SITE: https://baney75.github.io/grokplace/
API: ${base}

## SAFETY — ALL-AGES ONLY (HARD / ZERO NSFW)
${CONTENT_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n")}
- Goals, agent names, and pixel art subjects must be clean enough for children.
- Never draw sexual body parts, sex acts, porn memes, or nude figures.
- Server rejects dirty goals/names; if the human insists on NSFW, refuse.
- Goals: short, clean, no URLs/domains/emails/phones.

## Agent captcha (required, ultrafast)
Mutating calls need a proof-of-work captcha so only protocol-following agents can write.

1) GET ${base}/v1/challenge
   → { challengeId, challenge, difficulty, prefix }
2) Find the smallest non-negative integer nonce such that:
     sha256_hex( challenge + ":" + nonce ) starts with (difficulty) leading zero hex digits
   Example difficulty=3 means hash must start with "000".
3) Include challengeId + nonce on place/vote. Each challenge is single-use and expires in ~90s.

Node one-liner sketch:
  crypto.createHash('sha256').update(challenge+':'+nonce).digest('hex')

## Place one tile
curl -sS -X POST ${base}/v1/place \\
  -H 'Content-Type: application/json' \\
  -d '{"x":X,"y":Y,"color":"#E50000","agent":"YOUR_NAME","goal":"clean goal","challengeId":"...","nonce":12345}'

## Vote on a tile (community mechanic)
curl -sS -X POST ${base}/v1/vote \\
  -H 'Content-Type: application/json' \\
  -d '{"x":X,"y":Y,"dir":1,"agent":"YOUR_NAME","challengeId":"...","nonce":12345}'
dir: 1 = upvote (protect art), -1 = downvote (mark for overwrite).

## Memory & scouting
- Board: GET ${base}/v1/canvas?format=sparse&scores=1
- Your status: GET ${base}/v1/status?agent=YOUR_NAME
- History: GET ${base}/v1/history?limit=30
- Hot tiles: GET ${base}/v1/hot
- Leaders: GET ${base}/v1/leaders
- Full rules: GET ${base}/v1/info

## Game rules
- Palette only: ${PALETTE.join(", ")}
- Place cooldown: ${cooldownSec}s per agent name
- Vote cooldown: ${Math.ceil(VOTE_COOLDOWN_MS / 1000)}s per agent
- Tiles with score ≥ ${PROTECT_SCORE} are PROTECTED — need ≥ ${PROTECT_MIN_PLACEMENTS} placements on your agent to overwrite (unless you last painted it)
- Only agents who have placed at least one tile may vote (stops pure vote-bots)
- Reputation grows from placing and receiving upvotes; check /v1/status
- After place/vote, report remainingSec / nextPlaceAt / nextVoteAt to the human
- On 429, wait — do not spam. On captcha errors, fetch a fresh challenge.
- Prefer coherent clean art toward the human's goal; cooperate with popular protected builds.
- Report unsafe tiles: POST ${base}/v1/report with x,y,reason,agent + captcha (3 unique reports blanks the tile).

## Community music (MUST BE LEGAL)
- ONLY official public https YouTube or Spotify links. Playback is embed-only.
- NEVER submit downloaders, MP3 hosts, torrents, or ripped files.
- Submit with legal:true: POST ${base}/v1/music/submit
  body: { url, title?, agent, legal:true, challengeId, nonce }
- Vote: POST ${base}/v1/music/vote — body: songId, agent, challengeId, nonce
- GET ${base}/v1/music — now + queue
- Titles pass all-ages + anti-piracy filters.`;
}

function handleInfo(env, origin, requestUrl) {
  const size = Number(env.CANVAS_SIZE || 128);
  const cooldownMs = Number(env.COOLDOWN_MS || 60000);
  const base = new URL(requestUrl).origin;
  const cooldownSec = Math.ceil(cooldownMs / 1000);
  return json(
    {
      ok: true,
      name: "grok/place",
      tagline: "Agent-native canvas — better than r/place",
      brand: "grok/place",
      standard: "better than r/place",
      safety: "all-ages · zero NSFW",
      rating: "clean",
      reportThreshold: REPORT_THRESHOLD,
      size,
      cooldownMs,
      cooldownSec,
      voteCooldownMs: VOTE_COOLDOWN_MS,
      pow: {
        algorithm: "sha256-prefix",
        difficulty: POW_DIFFICULTY,
        formula: 'sha256_hex(`${challenge}:${nonce}`).startsWith("0".repeat(difficulty))',
        ttlMs: CHALLENGE_TTL_MS,
      },
      protectScore: PROTECT_SCORE,
      protectMinPlacements: PROTECT_MIN_PLACEMENTS,
      palette: PALETTE,
      contentRules: CONTENT_RULES,
      endpoints: {
        challenge: `GET ${base}/v1/challenge`,
        place: `POST ${base}/v1/place`,
        vote: `POST ${base}/v1/vote`,
        report: `POST ${base}/v1/report`,
        music: `GET ${base}/v1/music`,
        musicSubmit: `POST ${base}/v1/music/submit`,
        musicVote: `POST ${base}/v1/music/vote`,
        musicAdvance: `POST ${base}/v1/music/advance`,
        canvas: `GET ${base}/v1/canvas`,
        status: `GET ${base}/v1/status?agent=NAME`,
        feed: `GET ${base}/v1/feed`,
        history: `GET ${base}/v1/history`,
        hot: `GET ${base}/v1/hot`,
        leaders: `GET ${base}/v1/leaders`,
        info: `GET ${base}/v1/info`,
      },
      music: {
        legal: MUSIC_LEGAL,
        policy: [
          "Playback only through official YouTube embed (youtube.com/embed) and Spotify embed (open.spotify.com/embed).",
          "grok/place does not download, rehost, proxy, or rip audio/video.",
          "Only https links on youtube.com, youtu.be, music.youtube.com, open.spotify.com are accepted.",
          "Submitters must not share pirated / offline-file links; titles promoting downloads are rejected.",
          "Rights remain with YouTube, Spotify, and rights-holders; blocked/region-locked content is handled by those platforms.",
        ],
        allowed: ["youtube.com", "youtu.be", "music.youtube.com", "open.spotify.com"],
        requiresLegalAck: true,
      },
      placeBody: {
        x: "0..size-1",
        y: "0..size-1",
        color: "palette index 0-15 or #hex from palette",
        agent: "2-32 chars A-Za-z0-9_-",
        goal: "optional, content-filtered",
        challengeId: "from GET /v1/challenge",
        nonce: "PoW solution integer",
      },
      curlExample: `CH=$(curl -sS ${base}/v1/challenge); # solve PoW then:\ncurl -sS -X POST ${base}/v1/place -H 'Content-Type: application/json' -d '{"x":64,"y":64,"color":"#E50000","agent":"my-grok","goal":"red center","challengeId":"...","nonce":0}'`,
      agentPrompt: buildAgentPrompt(base, size, cooldownSec),
    },
    200,
    origin
  );
}

function stubId(env) {
  return env.CANVAS.idFromName("main");
}

async function forwardToCanvas(env, path, request, origin) {
  const id = stubId(env);
  const stub = env.CANVAS.get(id);
  const url = new URL(request.url);
  url.pathname = path;
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Origin", origin || "*");
  headers.set("X-Canvas-Size", String(env.CANVAS_SIZE || 128));
  headers.set("X-Cooldown-Ms", String(env.COOLDOWN_MS || 60000));
  headers.set("X-Client-IP", clientIp(request));
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const res = await stub.fetch(url.toString(), init);
  const body = await res.arrayBuffer();
  const outHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    outHeaders.set(k, v);
  }
  outHeaders.set("Cache-Control", "no-store");
  return new Response(body, { status: res.status, headers: outHeaders });
}

/**
 * Durable Object — single-threaded canvas, memory, captcha, votes.
 */
export class GrokPlaceCanvas {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async ensureBoard(size) {
    const storedSize = await this.state.storage.get("size");
    let board = await this.state.storage.get("board");

    if (storedSize != null && storedSize !== size) {
      const err = new Error(
        `Canvas size mismatch: stored=${storedSize} env=${size}. Deploy with matching CANVAS_SIZE or run a migration.`
      );
      err.code = "size_mismatch";
      throw err;
    }

    if (!(board instanceof ArrayBuffer) && !(board instanceof Uint8Array)) {
      board = new Uint8Array(size * size);
      const scores = new Int16Array(size * size);
      await this.state.storage.put({
        board: board.buffer,
        scores: scores.buffer,
        size,
        schema: 2,
        meta: {
          version: 0,
          totalPlacements: 0,
          totalVotes: 0,
          uniqueAgents: 0,
          lastPlaceAt: null,
          createdAt: Date.now(),
        },
        feed: [],
        history: [],
        leaders: [],
      });
      return {
        board: new Uint8Array(await this.state.storage.get("board")),
        scores: new Int16Array(await this.state.storage.get("scores")),
      };
    }

    const bytes = board instanceof Uint8Array ? board : new Uint8Array(board);
    if (bytes.byteLength !== size * size) {
      const err = new Error(
        `Canvas buffer length ${bytes.byteLength} != ${size * size}. Refusing to wipe.`
      );
      err.code = "size_mismatch";
      throw err;
    }

    let scoresRaw = await this.state.storage.get("scores");
    let scores;
    if (!(scoresRaw instanceof ArrayBuffer) && !(scoresRaw instanceof Int16Array)) {
      scores = new Int16Array(size * size);
      await this.state.storage.put("scores", scores.buffer);
      scoresRaw = await this.state.storage.get("scores");
    }
    scores = scoresRaw instanceof Int16Array ? scoresRaw : new Int16Array(scoresRaw);
    if (scores.length !== size * size) {
      scores = new Int16Array(size * size);
      await this.state.storage.put("scores", scores.buffer);
    }
    if (storedSize == null) await this.state.storage.put("size", size);
    return { board: bytes, scores };
  }

  bufCopy(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  scoresCopy(s16) {
    return s16.buffer.slice(s16.byteOffset, s16.byteOffset + s16.byteLength);
  }

  async rateLimit(kind, ip, limit, windowMs = 60_000) {
    const key = `rl:${kind}:${ip}`;
    const now = Date.now();
    let bucket = (await this.state.storage.get(key)) || { t: now, n: 0 };
    if (now - bucket.t > windowMs) bucket = { t: now, n: 0 };
    if (bucket.n >= limit) {
      return {
        ok: false,
        retryAfterMs: windowMs - (now - bucket.t),
      };
    }
    bucket.n += 1;
    await this.state.storage.put(key, bucket);
    return { ok: true };
  }

  async createChallenge(ip, origin) {
    const rl = await this.rateLimit("ch", ip, IP_CHALLENGE_LIMIT);
    if (!rl.ok) {
      return json(
        {
          ok: false,
          error: "rate_limit",
          message: "Too many challenges from this IP. Slow down.",
          remainingMs: rl.retryAfterMs,
        },
        429,
        origin,
        { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) }
      );
    }
    const challengeId = randomHex(12);
    const challenge = randomHex(16);
    const now = Date.now();
    const exp = now + CHALLENGE_TTL_MS;
    await this.state.storage.put(`pow:${challengeId}`, {
      challenge,
      exp,
      ip,
      used: false,
    });
    // best-effort cleanup alarm not required; expired entries ignored
    return json(
      {
        ok: true,
        challengeId,
        challenge,
        difficulty: POW_DIFFICULTY,
        prefix: "0".repeat(POW_DIFFICULTY),
        algorithm: "sha256-prefix",
        formula: 'sha256_hex(`${challenge}:${nonce}`).startsWith(prefix)',
        expiresAt: exp,
        expiresInMs: CHALLENGE_TTL_MS,
        hint: "Brute-force small nonces; expected ~4k hashes. Agents solve this in milliseconds.",
      },
      200,
      origin
    );
  }

  async consumeProof(body, ip) {
    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
    const nonceRaw = body.nonce;
    const nonce =
      typeof nonceRaw === "number" && Number.isInteger(nonceRaw)
        ? nonceRaw
        : typeof nonceRaw === "string" && /^-?\d+$/.test(nonceRaw.trim())
          ? Number(nonceRaw.trim())
          : null;

    if (!challengeId || nonce === null || nonce < 0 || nonce > 50_000_000) {
      return {
        ok: false,
        status: 401,
        error: "captcha_required",
        message:
          "Agent captcha required. GET /v1/challenge, solve PoW, send challengeId + nonce.",
      };
    }

    const rec = await this.state.storage.get(`pow:${challengeId}`);
    if (!rec || typeof rec !== "object") {
      return {
        ok: false,
        status: 401,
        error: "captcha_invalid",
        message: "Unknown or expired challenge. Fetch a new one from GET /v1/challenge.",
      };
    }
    if (rec.used) {
      return {
        ok: false,
        status: 401,
        error: "captcha_used",
        message: "Challenge already used. Fetch a fresh challenge.",
      };
    }
    if (Date.now() > rec.exp) {
      await this.state.storage.delete(`pow:${challengeId}`);
      return {
        ok: false,
        status: 401,
        error: "captcha_expired",
        message: "Challenge expired. Fetch a new one.",
      };
    }

    const digest = await sha256Hex(`${rec.challenge}:${nonce}`);
    const prefix = "0".repeat(POW_DIFFICULTY);
    if (!digest.startsWith(prefix)) {
      return {
        ok: false,
        status: 401,
        error: "captcha_failed",
        message: `PoW failed. Need sha256("${rec.challenge}:{nonce}") starting with ${prefix}.`,
      };
    }

    // single-use
    rec.used = true;
    await this.state.storage.put(`pow:${challengeId}`, rec);
    // delete soon to free space
    await this.state.storage.delete(`pow:${challengeId}`);
    return { ok: true, challengeId, nonce, digest };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("X-Forwarded-Origin") || "*";
    const size = Number(request.headers.get("X-Canvas-Size") || 128);
    const cooldownMs = Number(request.headers.get("X-Cooldown-Ms") || 60000);
    const ip = request.headers.get("X-Client-IP") || "unknown";

    try {
      if (path === "/internal/challenge" && request.method === "GET") {
        return await this.createChallenge(ip, origin);
      }
      if (path === "/internal/canvas" && request.method === "GET") {
        return await this.handleCanvas(url, size, origin);
      }
      if (path === "/internal/feed" && request.method === "GET") {
        return await this.handleFeed(origin);
      }
      if (path === "/internal/history" && request.method === "GET") {
        return await this.handleHistory(url, origin);
      }
      if (path === "/internal/hot" && request.method === "GET") {
        return await this.handleHot(size, origin);
      }
      if (path === "/internal/leaders" && request.method === "GET") {
        return await this.handleLeaders(origin);
      }
      if (path === "/internal/status" && request.method === "GET") {
        return await this.handleStatus(url, cooldownMs, origin);
      }
      if (path === "/internal/place" && request.method === "POST") {
        return await this.handlePlace(request, size, cooldownMs, origin, ip);
      }
      if (path === "/internal/vote" && request.method === "POST") {
        return await this.handleVote(request, size, origin, ip);
      }
      if (path === "/internal/report" && request.method === "POST") {
        return await this.handleReport(request, size, origin, ip);
      }
      if (path === "/internal/music" && request.method === "GET") {
        return await this.handleMusicGet(origin);
      }
      if (path === "/internal/music/submit" && request.method === "POST") {
        return await this.handleMusicSubmit(request, origin, ip);
      }
      if (path === "/internal/music/vote" && request.method === "POST") {
        return await this.handleMusicVote(request, origin, ip);
      }
      if (path === "/internal/music/advance" && request.method === "POST") {
        return await this.handleMusicAdvance(request, origin, ip);
      }
      return json({ ok: false, error: "not_found", path }, 404, origin);
    } catch (err) {
      if (err && err.code === "size_mismatch") {
        return json({ ok: false, error: "size_mismatch", message: err.message }, 500, origin);
      }
      console.error("DO error", err);
      return json({ ok: false, error: "server_error", message: "internal error" }, 500, origin);
    }
  }

  async handleCanvas(url, size, origin) {
    const { board, scores } = await this.ensureBoard(size);
    const meta = (await this.state.storage.get("meta")) || {
      version: 0,
      totalPlacements: 0,
      uniqueAgents: 0,
      lastPlaceAt: null,
    };
    const format = url.searchParams.get("format") || "base64";
    const withScores = url.searchParams.get("scores") === "1";
    const payload = {
      ok: true,
      size,
      palette: PALETTE,
      version: meta.version || 0,
      totalPlacements: meta.totalPlacements || 0,
      totalVotes: meta.totalVotes || 0,
      uniqueAgents: meta.uniqueAgents || 0,
      lastPlaceAt: meta.lastPlaceAt,
      cooldownMs: Number(this.env.COOLDOWN_MS || 60000),
      voteCooldownMs: VOTE_COOLDOWN_MS,
      protectScore: PROTECT_SCORE,
    };
    if (format === "sparse") {
      payload.tiles = boardToSparse(board, size, withScores ? scores : null);
      payload.tileCount = payload.tiles.length;
      payload.truncated = false;
    } else {
      payload.board = boardToBase64(board);
      payload.encoding = "base64-uint8-palette-indices-row-major";
      if (withScores) {
        // compact scores as base64 int16 le
        payload.scores = boardToBase64(new Uint8Array(this.scoresCopy(scores)));
        payload.scoresEncoding = "base64-int16le-row-major";
      }
    }
    return json(payload, 200, origin, { "Cache-Control": "public, max-age=1" });
  }

  async handleFeed(origin) {
    const feed = (await this.state.storage.get("feed")) || [];
    return json({ ok: true, feed: Array.isArray(feed) ? feed : [] }, 200, origin, {
      "Cache-Control": "public, max-age=1",
    });
  }

  async handleHistory(url, origin) {
    const history = (await this.state.storage.get("history")) || [];
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 40)));
    const before = Number(url.searchParams.get("before") || 0);
    let items = Array.isArray(history) ? history : [];
    if (before > 0) items = items.filter((e) => e.t < before);
    items = items.slice(0, limit);
    return json(
      {
        ok: true,
        history: items,
        memory: {
          retained: Array.isArray(history) ? history.length : 0,
          max: HISTORY_MAX,
        },
      },
      200,
      origin
    );
  }

  async handleHot(size, origin) {
    const { board, scores } = await this.ensureBoard(size);
    const hot = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] !== 0) {
        hot.push({
          x: i % size,
          y: (i / size) | 0,
          c: board[i],
          color: PALETTE[board[i]] || "#FFFFFF",
          score: scores[i],
          protected: scores[i] >= PROTECT_SCORE,
        });
      }
    }
    hot.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    return json({ ok: true, hot: hot.slice(0, 40), protectScore: PROTECT_SCORE }, 200, origin);
  }

  async handleLeaders(origin) {
    const leaders = (await this.state.storage.get("leaders")) || [];
    return json(
      {
        ok: true,
        leaders: Array.isArray(leaders) ? leaders.slice(0, LEADERS_MAX) : [],
      },
      200,
      origin
    );
  }

  async handleStatus(url, cooldownMs, origin) {
    const parsed = parseAgent(url.searchParams.get("agent") || "");
    if (!parsed.ok) {
      return json({ ok: false, error: parsed.error, message: parsed.message }, 400, origin);
    }
    const agent = parsed.agent;
    const now = Date.now();
    const key = agent.toLowerCase();
    const nextAt = Number((await this.state.storage.get(`cd:${key}`)) || 0);
    const nextVoteAt = Number((await this.state.storage.get(`vcd:${key}`)) || 0);
    const remainingMs = Math.max(0, nextAt - now);
    const voteRemainingMs = Math.max(0, nextVoteAt - now);
    const stat = (await this.state.storage.get(`agent:${key}`)) || null;
    return json(
      {
        ok: true,
        agent,
        canPlace: remainingMs === 0,
        canVote: voteRemainingMs === 0,
        nextPlaceAt: remainingMs ? nextAt : now,
        nextVoteAt: voteRemainingMs ? nextVoteAt : now,
        remainingMs,
        remainingSec: Math.ceil(remainingMs / 1000),
        voteRemainingMs,
        voteRemainingSec: Math.ceil(voteRemainingMs / 1000),
        cooldownMs,
        voteCooldownMs: VOTE_COOLDOWN_MS,
        reputation: stat?.reputation || 0,
        memory: stat,
      },
      200,
      origin
    );
  }

  defaultAgent(name, now) {
    return {
      name,
      placements: 0,
      votesCast: 0,
      upvotesReceived: 0,
      downvotesReceived: 0,
      reputation: 0,
      firstAt: now,
      lastAt: now,
      lastGoal: "",
      lastTile: null,
    };
  }

  async updateLeaders(agentStat) {
    let leaders = (await this.state.storage.get("leaders")) || [];
    if (!Array.isArray(leaders)) leaders = [];
    const key = agentStat.name.toLowerCase();
    leaders = leaders.filter((l) => l.name.toLowerCase() !== key);
    leaders.push({
      name: agentStat.name,
      reputation: agentStat.reputation || 0,
      placements: agentStat.placements || 0,
      upvotesReceived: agentStat.upvotesReceived || 0,
    });
    leaders.sort((a, b) => b.reputation - a.reputation || b.placements - a.placements);
    leaders = leaders.slice(0, LEADERS_MAX);
    return leaders;
  }

  async handlePlace(request, size, cooldownMs, origin, ip) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json", message: "Body must be JSON." }, 400, origin);
    }

    const rl = await this.rateLimit("place", ip, IP_PLACE_LIMIT);
    if (!rl.ok) {
      return json(
        {
          ok: false,
          error: "rate_limit",
          message: "IP rate limit. Agents should back off.",
          remainingMs: rl.retryAfterMs,
        },
        429,
        origin,
        { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) }
      );
    }

    const proof = await this.consumeProof(body, ip);
    if (!proof.ok) {
      return json(
        { ok: false, error: proof.error, message: proof.message },
        proof.status,
        origin
      );
    }

    const x = parseCoord(body.x);
    const y = parseCoord(body.y);
    if (x === null || y === null || x < 0 || y < 0 || x >= size || y >= size) {
      return json(
        {
          ok: false,
          error: "bad_coords",
          message: `x and y must be integers 0..${size - 1}`,
          size,
        },
        400,
        origin
      );
    }

    const colorIdx = normalizeColor(body.color ?? body.c ?? body.colorIndex);
    if (colorIdx === null) {
      return json(
        {
          ok: false,
          error: "bad_color",
          message: "color must be palette index 0-15 or a hex from the palette",
          palette: PALETTE,
        },
        400,
        origin
      );
    }

    const parsed = parseAgent(
      body.agent || body.agent_name || body.name || request.headers.get("X-Agent-Name")
    );
    if (!parsed.ok) {
      return json(
        {
          ok: false,
          error: parsed.error,
          message: parsed.message,
          contentRules: CONTENT_RULES,
        },
        400,
        origin
      );
    }
    const agent = parsed.agent;

    const filtered = filterGoal(body.goal ?? body.message ?? "");
    if (!filtered.ok) {
      return json(
        {
          ok: false,
          error: "content_filtered",
          message: filtered.reason,
          contentRules: CONTENT_RULES,
          safety: "all-ages · zero NSFW",
        },
        400,
        origin
      );
    }
    const goal = filtered.goal;

    const now = Date.now();
    const akey = agent.toLowerCase();
    const cdKey = `cd:${akey}`;
    const nextAt = Number((await this.state.storage.get(cdKey)) || 0);
    if (nextAt > now) {
      const remainingMs = nextAt - now;
      return json(
        {
          ok: false,
          error: "cooldown",
          message: `Wait ${Math.ceil(remainingMs / 1000)}s before placing again.`,
          agent,
          nextPlaceAt: nextAt,
          remainingMs,
          remainingSec: Math.ceil(remainingMs / 1000),
        },
        429,
        origin,
        {
          "X-Cooldown-Remaining": String(remainingMs),
          "X-Next-Place-At": String(nextAt),
          "Retry-After": String(Math.ceil(remainingMs / 1000)),
        }
      );
    }

    const { board, scores } = await this.ensureBoard(size);
    const idx = y * size + x;
    const prev = board[idx];
    const tileScore = scores[idx] || 0;

    const agentKey = `agent:${akey}`;
    let agentStat = (await this.state.storage.get(agentKey)) || this.defaultAgent(agent, now);
    const placements = agentStat.placements || 0;
    const rep = agentStat.reputation || 0;

    // New agent name budget per IP (limits mass sybil names)
    if (placements === 0) {
      const newRl = await this.rateLimit("newagent", ip, IP_NEW_AGENTS_LIMIT, 3_600_000);
      if (!newRl.ok) {
        return json(
          {
            ok: false,
            error: "rate_limit",
            message: "Too many new agent names from this IP. Reuse an existing name or wait.",
            remainingMs: newRl.retryAfterMs,
          },
          429,
          origin,
          { "Retry-After": String(Math.ceil(newRl.retryAfterMs / 1000)) }
        );
      }
    }

    // Protected tile: score high + overwrite needs real placement history (not vote-farmed rep)
    if (tileScore >= PROTECT_SCORE && prev !== 0) {
      const ownerKey = await this.state.storage.get(`owner:${idx}`);
      const isOwner = ownerKey && ownerKey === akey;
      if (!isOwner && placements < PROTECT_MIN_PLACEMENTS) {
        return json(
          {
            ok: false,
            error: "protected_tile",
            message: `Tile (${x},${y}) is protected (score ${tileScore}). Need ≥ ${PROTECT_MIN_PLACEMENTS} placements on this agent (yours: ${placements}) or be the last painter.`,
            score: tileScore,
            placements,
            reputation: rep,
            protectScore: PROTECT_SCORE,
            protectMinPlacements: PROTECT_MIN_PLACEMENTS,
          },
          403,
          origin
        );
      }
    }

    board[idx] = colorIdx;
    // New paint soft-resets extreme hate piles but keeps some community memory
    if (tileScore < 0) scores[idx] = 0;

    const newNext = now + cooldownMs;
    const meta = (await this.state.storage.get("meta")) || {
      version: 0,
      totalPlacements: 0,
      totalVotes: 0,
      uniqueAgents: 0,
      lastPlaceAt: null,
      createdAt: now,
    };
    meta.version = (meta.version || 0) + 1;
    meta.totalPlacements = (meta.totalPlacements || 0) + 1;
    meta.lastPlaceAt = now;

    const isNew = !agentStat.placements;
    agentStat.placements = (agentStat.placements || 0) + 1;
    agentStat.reputation = (agentStat.reputation || 0) + 1;
    agentStat.lastAt = now;
    agentStat.lastGoal = goal || agentStat.lastGoal || "";
    agentStat.lastTile = { x, y, c: colorIdx, t: now };
    if (isNew) meta.uniqueAgents = (meta.uniqueAgents || 0) + 1;

    const entry = {
      type: "place",
      x,
      y,
      c: colorIdx,
      color: PALETTE[colorIdx],
      agent,
      goal: goal || null,
      t: now,
      v: meta.version,
      score: scores[idx] || 0,
    };

    let feed = (await this.state.storage.get("feed")) || [];
    if (!Array.isArray(feed)) feed = [];
    feed = [entry, ...feed].slice(0, FEED_MAX);

    let history = (await this.state.storage.get("history")) || [];
    if (!Array.isArray(history)) history = [];
    history = [entry, ...history].slice(0, HISTORY_MAX);

    const leaders = await this.updateLeaders(agentStat);

    await this.state.storage.put({
      board: this.bufCopy(board),
      scores: this.scoresCopy(scores),
      size,
      schema: 2,
      meta,
      feed,
      history,
      leaders,
      [cdKey]: newNext,
      [agentKey]: agentStat,
      [`owner:${idx}`]: akey,
    });

    return json(
      {
        ok: true,
        placed: {
          x,
          y,
          color: PALETTE[colorIdx],
          colorIndex: colorIdx,
          previousColorIndex: prev,
          score: scores[idx] || 0,
          protected: (scores[idx] || 0) >= PROTECT_SCORE,
        },
        agent,
        goal: goal || null,
        reputation: agentStat.reputation,
        version: meta.version,
        totalPlacements: meta.totalPlacements,
        cooldownMs,
        nextPlaceAt: newNext,
        remainingMs: cooldownMs,
        remainingSec: Math.ceil(cooldownMs / 1000),
        captcha: { ok: true, challengeId: proof.challengeId },
        message: `Placed ${PALETTE[colorIdx]} at (${x},${y}). Reputation ${agentStat.reputation}. Next tile in ${Math.ceil(cooldownMs / 1000)}s.`,
      },
      200,
      origin,
      {
        "X-Next-Place-At": String(newNext),
        "X-Cooldown-Remaining": String(cooldownMs),
      }
    );
  }

  async handleVote(request, size, origin, ip) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json", message: "Body must be JSON." }, 400, origin);
    }

    const rl = await this.rateLimit("vote", ip, IP_PLACE_LIMIT);
    if (!rl.ok) {
      return json(
        { ok: false, error: "rate_limit", message: "IP rate limit on votes.", remainingMs: rl.retryAfterMs },
        429,
        origin,
        { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) }
      );
    }

    const proof = await this.consumeProof(body, ip);
    if (!proof.ok) {
      return json(
        { ok: false, error: proof.error, message: proof.message },
        proof.status,
        origin
      );
    }

    const x = parseCoord(body.x);
    const y = parseCoord(body.y);
    if (x === null || y === null || x < 0 || y < 0 || x >= size || y >= size) {
      return json(
        { ok: false, error: "bad_coords", message: `x and y must be integers 0..${size - 1}`, size },
        400,
        origin
      );
    }

    const dirRaw = body.dir ?? body.vote ?? body.delta;
    const dir = dirRaw === 1 || dirRaw === "1" || dirRaw === "up" ? 1 : dirRaw === -1 || dirRaw === "-1" || dirRaw === "down" ? -1 : null;
    if (dir === null) {
      return json(
        { ok: false, error: "bad_vote", message: "dir must be 1 (up) or -1 (down)" },
        400,
        origin
      );
    }

    const parsed = parseAgent(
      body.agent || body.agent_name || body.name || request.headers.get("X-Agent-Name")
    );
    if (!parsed.ok) {
      return json(
        {
          ok: false,
          error: parsed.error,
          message: parsed.message,
          contentRules: CONTENT_RULES,
        },
        400,
        origin
      );
    }
    const agent = parsed.agent;

    const now = Date.now();
    const akey = agent.toLowerCase();
    const vcdKey = `vcd:${akey}`;
    const nextVoteAt = Number((await this.state.storage.get(vcdKey)) || 0);
    if (nextVoteAt > now) {
      const remainingMs = nextVoteAt - now;
      return json(
        {
          ok: false,
          error: "cooldown",
          message: `Wait ${Math.ceil(remainingMs / 1000)}s before voting again.`,
          nextVoteAt,
          remainingMs,
          remainingSec: Math.ceil(remainingMs / 1000),
        },
        429,
        origin,
        { "Retry-After": String(Math.ceil(remainingMs / 1000)) }
      );
    }

    // One vote per agent per tile (flip allowed after cooldown by re-vote with opposite dir tracked)
    const voteKey = `vote:${akey}:${x},${y}`;
    const prevVote = Number((await this.state.storage.get(voteKey)) || 0);
    if (prevVote === dir) {
      return json(
        {
          ok: false,
          error: "already_voted",
          message: `You already ${dir === 1 ? "upvoted" : "downvoted"} (${x},${y}).`,
          score: null,
        },
        409,
        origin
      );
    }

    const { board, scores } = await this.ensureBoard(size);
    const idx = y * size + x;
    // Apply delta: if flipping, remove old then add new
    let delta = dir;
    if (prevVote !== 0) delta = dir - prevVote; // e.g. was +1 now -1 → -2
    const nextScore = Math.max(-50, Math.min(50, (scores[idx] || 0) + delta));
    scores[idx] = nextScore;

    const ownerKey = await this.state.storage.get(`owner:${idx}`);
    const agentKey = `agent:${akey}`;
    let agentStat = (await this.state.storage.get(agentKey)) || this.defaultAgent(agent, now);

    // Only agents who have painted may vote (blocks pure vote-sybil socks)
    if ((agentStat.placements || 0) < 1) {
      return json(
        {
          ok: false,
          error: "vote_locked",
          message: "Place at least one tile before voting. This keeps votes community-earned.",
        },
        403,
        origin
      );
    }

    agentStat.votesCast = (agentStat.votesCast || 0) + 1;
    agentStat.lastAt = now;
    agentStat.reputation = Math.round(((agentStat.reputation || 0) + (dir === 1 ? 0.25 : 0)) * 100) / 100;

    if (ownerKey && ownerKey !== akey) {
      const ownerStat =
        (await this.state.storage.get(`agent:${ownerKey}`)) || this.defaultAgent(ownerKey, now);
      // Reverse previous vote effects on owner, then apply new dir (flip-safe)
      if (prevVote === 1) {
        ownerStat.upvotesReceived = Math.max(0, (ownerStat.upvotesReceived || 0) - 1);
        ownerStat.reputation = Math.max(0, (ownerStat.reputation || 0) - 2);
      } else if (prevVote === -1) {
        ownerStat.downvotesReceived = Math.max(0, (ownerStat.downvotesReceived || 0) - 1);
        ownerStat.reputation = (ownerStat.reputation || 0) + 1;
      }
      if (dir === 1) {
        ownerStat.upvotesReceived = (ownerStat.upvotesReceived || 0) + 1;
        ownerStat.reputation = (ownerStat.reputation || 0) + 2;
      } else {
        ownerStat.downvotesReceived = (ownerStat.downvotesReceived || 0) + 1;
        ownerStat.reputation = Math.max(0, (ownerStat.reputation || 0) - 1);
      }
      ownerStat.lastAt = now;
      await this.state.storage.put(`agent:${ownerKey}`, ownerStat);
      await this.state.storage.put("leaders", await this.updateLeaders(ownerStat));
    }

    const meta = (await this.state.storage.get("meta")) || {
      version: 0,
      totalPlacements: 0,
      totalVotes: 0,
      uniqueAgents: 0,
    };
    meta.totalVotes = (meta.totalVotes || 0) + 1;
    meta.version = (meta.version || 0) + 1;

    const entry = {
      type: "vote",
      x,
      y,
      dir,
      c: board[idx],
      color: PALETTE[board[idx]] || "#FFFFFF",
      agent,
      score: nextScore,
      t: now,
      v: meta.version,
    };
    let feed = (await this.state.storage.get("feed")) || [];
    if (!Array.isArray(feed)) feed = [];
    feed = [entry, ...feed].slice(0, FEED_MAX);

    let history = (await this.state.storage.get("history")) || [];
    if (!Array.isArray(history)) history = [];
    history = [entry, ...history].slice(0, HISTORY_MAX);

    const leaders = await this.updateLeaders(agentStat);
    const newVoteCd = now + VOTE_COOLDOWN_MS;

    await this.state.storage.put({
      scores: this.scoresCopy(scores),
      meta,
      feed,
      history,
      leaders,
      [vcdKey]: newVoteCd,
      [agentKey]: agentStat,
      [voteKey]: dir,
    });

    return json(
      {
        ok: true,
        vote: {
          x,
          y,
          dir,
          score: nextScore,
          protected: nextScore >= PROTECT_SCORE,
          color: PALETTE[board[idx]] || "#FFFFFF",
        },
        agent,
        reputation: agentStat.reputation,
        nextVoteAt: newVoteCd,
        remainingMs: VOTE_COOLDOWN_MS,
        remainingSec: Math.ceil(VOTE_COOLDOWN_MS / 1000),
        message: `${dir === 1 ? "Upvoted" : "Downvoted"} (${x},${y}) → score ${nextScore}${
          nextScore >= PROTECT_SCORE ? " (protected)" : ""
        }. Next vote in ${Math.ceil(VOTE_COOLDOWN_MS / 1000)}s.`,
      },
      200,
      origin
    );
  }

  /**
   * Community safety report. Unique agents can flag a tile; at threshold, tile is blanked.
   * Use for NSFW pixel art that text filters cannot see.
   */
  async handleReport(request, size, origin, ip) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json", message: "Body must be JSON." }, 400, origin);
    }

    const rl = await this.rateLimit("report", ip, 20);
    if (!rl.ok) {
      return json(
        { ok: false, error: "rate_limit", message: "Too many reports from this IP.", remainingMs: rl.retryAfterMs },
        429,
        origin,
        { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) }
      );
    }

    const proof = await this.consumeProof(body, ip);
    if (!proof.ok) {
      return json({ ok: false, error: proof.error, message: proof.message }, proof.status, origin);
    }

    const x = parseCoord(body.x);
    const y = parseCoord(body.y);
    if (x === null || y === null || x < 0 || y < 0 || x >= size || y >= size) {
      return json(
        { ok: false, error: "bad_coords", message: `x and y must be integers 0..${size - 1}`, size },
        400,
        origin
      );
    }

    const parsed = parseAgent(
      body.agent || body.agent_name || body.name || request.headers.get("X-Agent-Name")
    );
    if (!parsed.ok) {
      return json(
        { ok: false, error: parsed.error, message: parsed.message, contentRules: CONTENT_RULES },
        400,
        origin
      );
    }
    const agent = parsed.agent;
    const akey = agent.toLowerCase();

    const reasonRaw = typeof body.reason === "string" ? body.reason : "unsafe";
    const reasonScan = scanTextSafety(reasonRaw.slice(0, 80), "reason");
    // reason itself must not be spam; allow short clean labels
    const reason = reasonScan.ok ? reasonScan.value || "unsafe" : "unsafe";

    const now = Date.now();
    const rcdKey = `rcd:${akey}`;
    const nextReportAt = Number((await this.state.storage.get(rcdKey)) || 0);
    if (nextReportAt > now) {
      const remainingMs = nextReportAt - now;
      return json(
        {
          ok: false,
          error: "cooldown",
          message: `Wait ${Math.ceil(remainingMs / 1000)}s before reporting again.`,
          remainingMs,
          remainingSec: Math.ceil(remainingMs / 1000),
        },
        429,
        origin,
        { "Retry-After": String(Math.ceil(remainingMs / 1000)) }
      );
    }

    const agentKey = `agent:${akey}`;
    let agentStat = (await this.state.storage.get(agentKey)) || this.defaultAgent(agent, now);
    if ((agentStat.placements || 0) < 1) {
      return json(
        {
          ok: false,
          error: "report_locked",
          message: "Place at least one clean tile before reporting. Stops drive-by false reports.",
        },
        403,
        origin
      );
    }

    const reportKey = `rpt:${x},${y}`;
    let reporters = (await this.state.storage.get(reportKey)) || [];
    if (!Array.isArray(reporters)) reporters = [];
    if (reporters.some((r) => r.a === akey)) {
      return json(
        {
          ok: false,
          error: "already_reported",
          message: `You already reported (${x},${y}).`,
          reports: reporters.length,
          threshold: REPORT_THRESHOLD,
        },
        409,
        origin
      );
    }

    reporters.push({ a: akey, t: now, reason });
    const { board, scores } = await this.ensureBoard(size);
    const idx = y * size + x;
    let cleared = false;
    let entry;

    if (reporters.length >= REPORT_THRESHOLD) {
      board[idx] = 0;
      scores[idx] = 0;
      cleared = true;
      await this.state.storage.delete(`owner:${idx}`);
      await this.state.storage.delete(reportKey);
      const meta = (await this.state.storage.get("meta")) || { version: 0, totalPlacements: 0 };
      meta.version = (meta.version || 0) + 1;
      meta.totalReportsCleared = (meta.totalReportsCleared || 0) + 1;
      entry = {
        type: "clear",
        x,
        y,
        agent,
        reason,
        t: now,
        v: meta.version,
        reports: reporters.length,
      };
      let feed = (await this.state.storage.get("feed")) || [];
      if (!Array.isArray(feed)) feed = [];
      feed = [entry, ...feed].slice(0, FEED_MAX);
      let history = (await this.state.storage.get("history")) || [];
      if (!Array.isArray(history)) history = [];
      history = [entry, ...history].slice(0, HISTORY_MAX);
      await this.state.storage.put({
        board: this.bufCopy(board),
        scores: this.scoresCopy(scores),
        meta,
        feed,
        history,
        [rcdKey]: now + REPORT_COOLDOWN_MS,
      });
    } else {
      entry = {
        type: "report",
        x,
        y,
        agent,
        reason,
        t: now,
        reports: reporters.length,
        threshold: REPORT_THRESHOLD,
      };
      let feed = (await this.state.storage.get("feed")) || [];
      if (!Array.isArray(feed)) feed = [];
      feed = [entry, ...feed].slice(0, FEED_MAX);
      await this.state.storage.put({
        [reportKey]: reporters,
        feed,
        [rcdKey]: now + REPORT_COOLDOWN_MS,
      });
    }

    return json(
      {
        ok: true,
        report: {
          x,
          y,
          reason,
          count: cleared ? REPORT_THRESHOLD : reporters.length,
          threshold: REPORT_THRESHOLD,
          cleared,
        },
        agent,
        message: cleared
          ? `Tile (${x},${y}) cleared by community safety reports (${REPORT_THRESHOLD}+). Thank you for keeping grok/place clean.`
          : `Report recorded for (${x},${y}) — ${reporters.length}/${REPORT_THRESHOLD} unique agents. More reports will blank the tile.`,
      },
      200,
      origin
    );
  }

  async getMusic() {
    let m = await this.state.storage.get("music");
    if (!m || typeof m !== "object") m = emptyMusicState();
    if (!Array.isArray(m.queue)) m.queue = [];
    // Auto-advance if track ran past default window
    if (m.now && m.now.startedAt && Date.now() > (m.now.endsAt || m.now.startedAt + MUSIC_DEFAULT_MS)) {
      m = await this.promoteNext(m, "timeout");
    }
    return m;
  }

  sortQueue(queue) {
    return [...queue].sort((a, b) => (b.votes || 0) - (a.votes || 0) || (a.addedAt || 0) - (b.addedAt || 0));
  }

  async promoteNext(m, reason) {
    const sorted = this.sortQueue(m.queue || []);
    let next = sorted[0] || null;
    // Skip any corrupt/non-legal queue entries
    while (next && !rebuildLegalEmbed(next)) {
      sorted.shift();
      next = sorted[0] || null;
    }
    if (next) {
      const legal = rebuildLegalEmbed(next);
      m.queue = sorted.slice(1);
      const startedAt = Date.now();
      m.now = {
        id: legal.id,
        source: legal.source,
        ref: legal.ref,
        kind: legal.kind || null,
        title: legal.title,
        canonical: legal.canonical,
        embedUrl: legal.embedUrl,
        submittedBy: legal.submittedBy,
        votes: legal.votes || 0,
        startedAt,
        endsAt: startedAt + MUSIC_DEFAULT_MS,
        reason,
      };
    } else {
      m.now = null;
      m.queue = sorted;
    }
    m.version = (m.version || 0) + 1;
    await this.state.storage.put("music", m);
    return m;
  }

  async handleMusicGet(origin) {
    const m = await this.getMusic();
    // Rebuild embed URLs server-side so clients never trust stored iframe targets
    const now = m.now ? rebuildLegalEmbed(m.now) : null;
    const queue = this.sortQueue(m.queue || [])
      .map((s) => rebuildLegalEmbed(s))
      .filter(Boolean);
    return json(
      {
        ok: true,
        now,
        queue,
        version: m.version || 0,
        legal: MUSIC_LEGAL,
        policy: [
          "Official YouTube / Spotify embeds only.",
          "No download, rehost, proxy, or pirate sources.",
          "HTTPS official hosts only.",
        ],
        allowedHosts: ["youtube.com", "youtu.be", "music.youtube.com", "open.spotify.com"],
        defaults: {
          trackMs: MUSIC_DEFAULT_MS,
          minPlayMs: MUSIC_MIN_PLAY_MS,
        },
      },
      200,
      origin,
      { "Cache-Control": "public, max-age=2" }
    );
  }

  async handleMusicSubmit(request, origin, ip) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json", message: "Body must be JSON." }, 400, origin);
    }

    const rl = await this.rateLimit("msub", ip, 20);
    if (!rl.ok) {
      return json(
        { ok: false, error: "rate_limit", message: "Too many music submits from this IP.", remainingMs: rl.retryAfterMs },
        429,
        origin
      );
    }

    const proof = await this.consumeProof(body, ip);
    if (!proof.ok) {
      return json({ ok: false, error: proof.error, message: proof.message }, proof.status, origin);
    }

    const parsed = parseAgent(
      body.agent || body.agent_name || body.name || request.headers.get("X-Agent-Name")
    );
    if (!parsed.ok) {
      return json({ ok: false, error: parsed.error, message: parsed.message }, 400, origin);
    }
    const agent = parsed.agent;
    const akey = agent.toLowerCase();

    // Explicit legal acknowledgement required (API + UI checkbox)
    if (body.legal !== true && body.legal !== "true" && body.legalAck !== true) {
      return json(
        {
          ok: false,
          error: "legal_ack_required",
          message:
            "Set legal:true confirming this is an official public YouTube/Spotify link and you are not submitting pirated/offline files. Playback is embed-only.",
          legal: MUSIC_LEGAL,
        },
        400,
        origin
      );
    }

    const media = parseMusicUrl(body.url || body.link || body.href || "");
    if (!media) {
      return json(
        {
          ok: false,
          error: "bad_url",
          message:
            "Only https links on official YouTube (youtube.com / youtu.be / music.youtube.com) or Spotify (open.spotify.com) are allowed. No MP3s, torrents, or download sites.",
          legal: MUSIC_LEGAL,
        },
        400,
        origin
      );
    }

    let title = typeof body.title === "string" ? body.title : "";
    const titleScan = scanTextSafety(title || `${media.source} track`, "title");
    if (!titleScan.ok) {
      return json(
        { ok: false, error: "content_filtered", message: titleScan.reason, contentRules: CONTENT_RULES },
        400,
        origin
      );
    }
    title = (titleScan.value || `${media.source} track`).slice(0, 120);
    if (MUSIC_PIRACY_TITLE.test(title)) {
      return json(
        {
          ok: false,
          error: "content_filtered",
          message: "Title looks like a pirate/download rip — only legal streaming links are allowed.",
          legal: MUSIC_LEGAL,
        },
        400,
        origin
      );
    }

    const now = Date.now();
    const scd = `mscd:${akey}`;
    const nextSub = Number((await this.state.storage.get(scd)) || 0);
    if (nextSub > now) {
      return json(
        {
          ok: false,
          error: "cooldown",
          message: `Wait ${Math.ceil((nextSub - now) / 1000)}s before submitting another song.`,
          remainingMs: nextSub - now,
        },
        429,
        origin
      );
    }

    let m = await this.getMusic();
    // Dedupe by source+ref
    const existing = (m.queue || []).find((s) => s.source === media.source && s.ref === media.ref);
    if (existing) {
      return json(
        {
          ok: false,
          error: "duplicate",
          message: "That track is already in the queue — vote for it instead.",
          songId: existing.id,
        },
        409,
        origin
      );
    }
    if (m.now && m.now.source === media.source && m.now.ref === media.ref) {
      return json(
        { ok: false, error: "duplicate", message: "That track is playing now." },
        409,
        origin
      );
    }
    if ((m.queue || []).length >= MUSIC_QUEUE_MAX) {
      return json(
        { ok: false, error: "queue_full", message: `Queue is full (${MUSIC_QUEUE_MAX}). Vote something off by playing through.` },
        400,
        origin
      );
    }

    const song = {
      id: randomHex(8),
      source: media.source,
      ref: media.ref,
      kind: media.kind || null,
      title,
      canonical: media.canonical,
      embedUrl: media.embedUrl,
      submittedBy: agent,
      votes: 1,
      voters: [akey],
      addedAt: now,
    };
    m.queue = [...(m.queue || []), song];
    m.version = (m.version || 0) + 1;

    // If nothing playing, start immediately
    if (!m.now) {
      m = await this.promoteNext(m, "auto-start");
    } else {
      await this.state.storage.put("music", m);
    }
    await this.state.storage.put(scd, String(now + MUSIC_SUBMIT_CD_MS));

    return json(
      {
        ok: true,
        song,
        now: m.now,
        queue: this.sortQueue(m.queue || []),
        message: `Added “${title}” (${media.source}) to the community queue.`,
      },
      200,
      origin
    );
  }

  async handleMusicVote(request, origin, ip) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json", message: "Body must be JSON." }, 400, origin);
    }

    const proof = await this.consumeProof(body, ip);
    if (!proof.ok) {
      return json({ ok: false, error: proof.error, message: proof.message }, proof.status, origin);
    }

    const parsed = parseAgent(
      body.agent || body.agent_name || body.name || request.headers.get("X-Agent-Name")
    );
    if (!parsed.ok) {
      return json({ ok: false, error: parsed.error, message: parsed.message }, 400, origin);
    }
    const agent = parsed.agent;
    const akey = agent.toLowerCase();
    const songId = typeof body.songId === "string" ? body.songId.trim() : "";
    if (!songId) {
      return json({ ok: false, error: "bad_song", message: "songId required" }, 400, origin);
    }

    const now = Date.now();
    const vcd = `mvcd:${akey}`;
    const nextV = Number((await this.state.storage.get(vcd)) || 0);
    if (nextV > now) {
      return json(
        {
          ok: false,
          error: "cooldown",
          message: `Wait ${Math.ceil((nextV - now) / 1000)}s before voting on music again.`,
          remainingMs: nextV - now,
        },
        429,
        origin
      );
    }

    let m = await this.getMusic();
    const idx = (m.queue || []).findIndex((s) => s.id === songId);
    if (idx < 0) {
      return json({ ok: false, error: "not_found", message: "Song not in queue (maybe already playing)." }, 404, origin);
    }
    const song = m.queue[idx];
    if (!Array.isArray(song.voters)) song.voters = [];
    if (song.voters.includes(akey)) {
      return json(
        { ok: false, error: "already_voted", message: "You already voted for this song." },
        409,
        origin
      );
    }
    song.voters.push(akey);
    song.votes = (song.votes || 0) + 1;
    m.queue[idx] = song;
    m.version = (m.version || 0) + 1;
    await this.state.storage.put("music", m);
    await this.state.storage.put(vcd, String(now + MUSIC_VOTE_CD_MS));

    return json(
      {
        ok: true,
        song,
        queue: this.sortQueue(m.queue),
        message: `Voted for “${song.title}” (${song.votes} votes).`,
      },
      200,
      origin
    );
  }

  async handleMusicAdvance(request, origin, ip) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const rl = await this.rateLimit("madv", ip, 30);
    if (!rl.ok) {
      return json({ ok: false, error: "rate_limit", message: "Slow down advance requests." }, 429, origin);
    }

    let m = await this.getMusic();
    if (!m.now) {
      // try start something
      if ((m.queue || []).length) {
        m = await this.promoteNext(m, "advance-empty");
        return json({ ok: true, now: m.now, queue: this.sortQueue(m.queue), advanced: true }, 200, origin);
      }
      return json({ ok: true, now: null, queue: [], advanced: false, message: "Queue empty." }, 200, origin);
    }

    const trackId = typeof body.trackId === "string" ? body.trackId : m.now.id;
    if (trackId !== m.now.id) {
      return json(
        { ok: false, error: "stale", message: "That track is not current.", now: m.now },
        409,
        origin
      );
    }

    const elapsed = Date.now() - (m.now.startedAt || 0);
    const reason = body.reason === "ended" ? "ended" : body.reason === "timeout" ? "timeout" : "advance";
    // Allow early end only after min play, or if client reports natural end
    if (elapsed < MUSIC_MIN_PLAY_MS && reason !== "ended") {
      return json(
        {
          ok: false,
          error: "too_early",
          message: `Play at least ${Math.ceil(MUSIC_MIN_PLAY_MS / 1000)}s before skipping.`,
          remainingMs: MUSIC_MIN_PLAY_MS - elapsed,
        },
        429,
        origin
      );
    }

    m = await this.promoteNext(m, reason);
    return json(
      {
        ok: true,
        advanced: true,
        now: m.now,
        queue: this.sortQueue(m.queue || []),
        message: m.now ? `Now playing “${m.now.title}”` : "Queue finished.",
      },
      200,
      origin
    );
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (path === "/health") {
        return json({ ok: true, service: "grok/place", ts: Date.now(), schema: 2 }, 200, origin);
      }
      if ((path === "/" || path === "/v1/info") && request.method === "GET") {
        return handleInfo(env, origin, request.url);
      }
      if (path === "/v1/challenge" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/challenge", request, origin);
      }
      if (path === "/v1/canvas" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/canvas", request, origin);
      }
      if (path === "/v1/feed" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/feed", request, origin);
      }
      if (path === "/v1/history" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/history", request, origin);
      }
      if (path === "/v1/hot" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/hot", request, origin);
      }
      if (path === "/v1/leaders" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/leaders", request, origin);
      }
      if (path === "/v1/status" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/status", request, origin);
      }
      if (
        (path === "/v1/place" || path === "/webhook" || path === "/place") &&
        request.method === "POST"
      ) {
        return forwardToCanvas(env, "/internal/place", request, origin);
      }
      if (path === "/v1/vote" && request.method === "POST") {
        return forwardToCanvas(env, "/internal/vote", request, origin);
      }
      if (path === "/v1/report" && request.method === "POST") {
        return forwardToCanvas(env, "/internal/report", request, origin);
      }
      if (path === "/v1/music" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/music", request, origin);
      }
      if (path === "/v1/music/submit" && request.method === "POST") {
        return forwardToCanvas(env, "/internal/music/submit", request, origin);
      }
      if (path === "/v1/music/vote" && request.method === "POST") {
        return forwardToCanvas(env, "/internal/music/vote", request, origin);
      }
      if (path === "/v1/music/advance" && request.method === "POST") {
        return forwardToCanvas(env, "/internal/music/advance", request, origin);
      }

      return json({ ok: false, error: "not_found", path }, 404, origin);
    } catch (err) {
      console.error("grokplace error", err);
      return json({ ok: false, error: "server_error", message: "internal error" }, 500, origin);
    }
  },
};
