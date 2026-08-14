// Spotify OAuth (Authorization Code flow) — gets an access token so we can
// later call /me/top/tracks. Run with:  npm run dev
//
// First run: opens a browser login, you approve, tokens get saved to
// .spotify-token.json. Every run after that refreshes silently — no browser.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TOKEN_FILE = ".spotify-token.json";
const SCOPES = "user-top-read";

// ---- config ---------------------------------------------------------------

interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function readConfig(): Config {
  const clientId = process.env["CLIENT_ID"];
  const clientSecret = process.env["CLIENT_SECRET"];
  const redirectUri = process.env["REDIRECT_URI"];

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing env vars. Ensure CLIENT_ID, CLIENT_SECRET, REDIRECT_URI are set in .env",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

// ---- token cache ----------------------------------------------------------

interface TokenCache {
  refresh_token: string;
}

function loadRefreshToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as TokenCache;
    return parsed.refresh_token ?? null;
  } catch {
    return null;
  }
}

function saveRefreshToken(refreshToken: string): void {
  const data: TokenCache = { refresh_token: refreshToken };
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2) + "\n");
}

// ---- Spotify token responses ----------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string; // present on initial exchange, sometimes on refresh
  scope?: string;
}

function basicAuthHeader(cfg: Config): string {
  const raw = `${cfg.clientId}:${cfg.clientSecret}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

// ---- Part 1: authorize URL ------------------------------------------------

function buildAuthorizeUrl(cfg: Config, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// ---- Part 2: local callback server ----------------------------------------

// Starts a one-shot HTTP server on the redirect URI's host/port, waits for
// Spotify to redirect the browser back with ?code=..., verifies state, and
// resolves with the authorization code.
function waitForCallback(cfg: Config, expectedState: string): Promise<string> {
  const redirect = new URL(cfg.redirectUri);
  const port = redirect.port ? Number(redirect.port) : 80;

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://${redirect.host}`);

      // Ignore anything that isn't the callback path (e.g. favicon requests).
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const finish = (message: string) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(message);
        server.close();
      };

      if (error) {
        finish(`Authorization failed: ${error}. You can close this tab.`);
        reject(new Error(`Spotify returned error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        finish("State mismatch. You can close this tab.");
        reject(new Error("State mismatch — possible CSRF, aborting."));
        return;
      }
      if (!code) {
        finish("No code received. You can close this tab.");
        reject(new Error("No authorization code in callback."));
        return;
      }

      finish("Authorized! You can close this tab and return to the terminal.");
      resolve(code);
    });

    server.on("error", reject);
    server.listen(port, () => {
      console.log(`Waiting for Spotify redirect on ${cfg.redirectUri} ...`);
    });
  });
}

// ---- Part 3: exchange code for tokens -------------------------------------

async function exchangeCodeForTokens(cfg: Config, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(cfg),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

// ---- refresh flow (used on every run after the first) ---------------------

async function refreshAccessToken(cfg: Config, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(cfg),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

// ---- first-time interactive login -----------------------------------------

async function interactiveLogin(cfg: Config): Promise<TokenResponse> {
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthorizeUrl(cfg, state);

  console.log("\nOpen this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");

  const code = await waitForCallback(cfg, state);
  return exchangeCodeForTokens(cfg, code);
}

// ---- access token orchestration -------------------------------------------

// Returns a valid access token, doing whichever flow is needed.
export async function getAccessToken(): Promise<string> {
  const cfg = readConfig();
  const savedRefresh = loadRefreshToken();

  let tokens: TokenResponse;
  if (savedRefresh) {
    console.log("Found saved token — refreshing...");
    tokens = await refreshAccessToken(cfg, savedRefresh);
  } else {
    tokens = await interactiveLogin(cfg);
  }

  // Persist the refresh token if we got one (always on first login).
  if (tokens.refresh_token) {
    saveRefreshToken(tokens.refresh_token);
  }

  return tokens.access_token;
}

// ---- fetch top tracks ------------------------------------------------------

interface SpotifyArtist {
  name: string;
}

interface SpotifyTrack {
  name: string;
  artists: SpotifyArtist[];
  duration_ms: number;
}

interface TopTracksResponse {
  items: SpotifyTrack[];
}

// A trimmed-down shape we actually care about for the receipt.
interface TrackLine {
  rank: number;
  title: string;
  artist: string;
  durationMs: number;
}

async function getTopTracks(accessToken: string): Promise<TrackLine[]> {
  const params = new URLSearchParams({
    time_range: "short_term", // ~last 4 weeks
    limit: "10",
  });

  const res = await fetch(`https://api.spotify.com/v1/me/top/tracks?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch top tracks: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as TopTracksResponse;

  return data.items.map((track, i) => ({
    rank: i + 1,
    title: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    durationMs: track.duration_ms,
  }));
}

// ---- receipt formatting ----------------------------------------------------

const WIDTH = 40; // receipt column width (monospace chars)

function center(text: string): string {
  if (text.length >= WIDTH) return text;
  const pad = Math.floor((WIDTH - text.length) / 2);
  return " ".repeat(pad) + text;
}

// Truncate long strings so nothing overflows the receipt width.
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function msToMinSec(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function fakeBarcode(): string {
  // Random block pattern so it looks receipt-y.
  let out = "";
  for (let i = 0; i < WIDTH; i++) {
    out += Math.random() > 0.5 ? "█" : " ";
  }
  return out;
}

function formatReceipt(tracks: TrackLine[]): string {
  const line = "=".repeat(WIDTH);
  const thin = "-".repeat(WIDTH);
  const now = new Date();

  const lines: string[] = [];
  lines.push(line);
  lines.push(center("SPOTIFY RECEIPT"));
  lines.push(center("TOP 10 · LAST 4 WEEKS"));
  lines.push(line);
  lines.push(`DATE: ${now.toLocaleDateString()}`);
  lines.push(`TIME: ${now.toLocaleTimeString()}`);
  lines.push(thin);

  let totalMs = 0;
  for (const t of tracks) {
    totalMs += t.durationMs;
    const rank = t.rank.toString().padStart(2, "0");
    const dur = msToMinSec(t.durationMs);
    // Line 1: "01 Track Title" left, duration right-aligned.
    const left = `${rank} ${truncate(t.title, WIDTH - 4 - dur.length - 1)}`;
    const pad = Math.max(1, WIDTH - left.length - dur.length);
    lines.push(left + " ".repeat(pad) + dur);
    // Line 2: artist, indented under the title.
    lines.push(`   ${truncate(t.artist, WIDTH - 3)}`);
  }

  lines.push(thin);
  lines.push(`ITEMS:${tracks.length.toString().padStart(WIDTH - 6)}`);
  const totalLabel = "TOTAL TIME:";
  const totalVal = msToMinSec(totalMs);
  lines.push(totalLabel + totalVal.padStart(WIDTH - totalLabel.length));
  lines.push(line);
  lines.push(center("THANK YOU FOR LISTENING"));
  lines.push("");
  lines.push(fakeBarcode());
  lines.push("");

  return lines.join("\n");
}

// ---- main ------------------------------------------------------------------

const RECEIPT_FILE = "receipt.txt";

async function main(): Promise<void> {
  const accessToken = await getAccessToken();
  console.log(`\n✅ Got access token (length: ${accessToken.length}).`);

  const tracks = await getTopTracks(accessToken);
  console.log(`✅ Fetched ${tracks.length} top tracks.\n`);

  const receipt = formatReceipt(tracks);
  writeFileSync(RECEIPT_FILE, receipt);
  console.log(receipt);
  console.log(`\n📄 Written to ${RECEIPT_FILE}`);
}

main().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
