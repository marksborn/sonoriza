/**
 * AUDIOBOOK-01 Gate 1B — opt-in, bounded Spotify read-only smoke.
 *
 * Usage (site user, project root, DB env loaded):
 *   npx tsx scripts/probe-spotify-audiobook.ts --email="$SONORIZA_PROBE_EMAIL" --id=5E76EUAq7or1ncd4QNyHjI
 *
 * Reuses the existing quota/backoff policy and request parsing. Never writes
 * playlists, player, library, domain data or generation state.
 * Default: no token refresh (expires => ABORT). Explicit --allow-token-refresh
 * may update OAuth credentials, as normal SpotifyClient.forUser does.
 * Existing provider 429 handling may persist a safety backoff; this is an
 * operational guard rather than a feature/domain write.
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive, SpotifyBackoffActiveError } from "@/services/spotify/backoff";
import { getSpotifyAccessToken } from "@/services/spotify/token";
import { SpotifyApiError } from "@/services/spotify/errors";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { catalogIdentity, chapterIdentity, firstChapter } from "@/services/spotify/audiobook-gate1";

type Diagnostic = {
  endpoint: string;
  status: "2XX" | number | null;
  outcome: string;
  result?: Record<string, unknown>;
};
type GetResult =
  | { ok: true; data: unknown; diagnostic: Diagnostic }
  | { ok: false; diagnostic: Diagnostic; stop: boolean };

const MAX_CALLS = 4;
function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

async function main(): Promise<void> {
  const email = argValue("email");
  const spotifyId = argValue("id");
  const allowTokenRefresh = process.argv.includes("--allow-token-refresh");
  if (!email || !spotifyId || !/^[A-Za-z0-9]{22}$/.test(spotifyId)) {
    throw new Error("INVALID_ARGS: requires --email=... --id=22_character_spotify_id");
  }

  const checks: Diagnostic[] = [];
  const report: Record<string, unknown> = {
    issue: 482,
    gate: "AUDIOBOOK-01/1B",
    mode: "READ_ONLY_SPOTIFY",
    spotifyId,
    sourceUrl: `https://open.spotify.com/show/${spotifyId}`,
    oauthRefreshOptIn: allowTokenRefresh,
    safety: {
      spotifyWrites: 0,
      featureDatabaseWrites: 0,
      operationalBackoffMayBeUpdatedOn429: true,
      maxSpotifyGetCalls: MAX_CALLS,
    },
    checks,
    outcome: "NOT_RUN",
  };

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      accounts: {
        where: { provider: "spotify" },
        take: 1,
        select: { access_token: true, expires_at: true, scope: true },
      },
    },
  });
  const account = user?.accounts[0];
  if (!user || !account) {
    report.outcome = "SPOTIFY_ACCOUNT_NOT_CONNECTED";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const grantedScopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
  report.scopes = {
    libraryRead: grantedScopes.has("user-library-read"),
    playbackPosition: grantedScopes.has("user-read-playback-position"),
  };

  // Never refresh automatically in this diagnostic. OAuth refresh is an
  // operational DB write and therefore an explicit opt-in.
  const expiresSoon = !account.expires_at ||
    account.expires_at <= Math.floor(Date.now() / 1000) + 60;
  if (expiresSoon && !allowTokenRefresh) {
    report.outcome = "TOKEN_EXPIRED_REFRESH_NOT_AUTHORIZED";
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const token = expiresSoon
    ? await getSpotifyAccessToken(user.id)
    : account.access_token;
  if (!token) {
    report.outcome = "NO_VALID_ACCESS_TOKEN";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  let calls = 0;
  async function read(endpoint: string): Promise<GetResult> {
    if (calls >= MAX_CALLS) {
      return { ok: false, stop: true,
        diagnostic: { endpoint, status: null, outcome: "CALL_BUDGET_EXHAUSTED" } };
    }
    // Scope the GET budget locally and honor provider-wide existing backoff.
    await assertSpotifyBackoffInactive();
    calls += 1;
    try {
      const data = await spotifyRequestAttempt<unknown>({
        accessToken: token,
        path: endpoint,
        method: "GET",
        operation: "spotify-api",
      });
      const diagnostic: Diagnostic = { endpoint, status: "2XX", outcome: "SUCCESS" };
      checks.push(diagnostic);
      return { ok: true, data, diagnostic };
    } catch (error) {
      const diagnostic: Diagnostic = error instanceof SpotifyApiError
        ? { endpoint, status: error.status, outcome: error.kind }
        : { endpoint, status: null, outcome: "NETWORK_OR_UNKNOWN_ERROR" };
      checks.push(diagnostic);
      const stop = !(error instanceof SpotifyApiError && error.status === 404);
      return { ok: false, diagnostic, stop };
    }
  }

  try {
    const audiobook = await read(`/audiobooks/${spotifyId}`);
    if (audiobook.ok) {
      const identity = catalogIdentity(audiobook.data, "audiobook");
      audiobook.diagnostic.result = { ...identity };
      if (!identity.recognized || identity.id !== spotifyId) {
        report.outcome = "AUDIOBOOK_RESPONSE_UNRECOGNIZED";
      } else {
        report.outcome = "AUDIOBOOK_OBJECT_CONFIRMED";
        const chapters = await read(`/audiobooks/${spotifyId}/chapters?limit=10&offset=0`);
        if (chapters.ok) {
          const page = firstChapter(chapters.data);
          chapters.diagnostic.result = { ...page };
          if (page.chapter?.id && /^[A-Za-z0-9]{22}$/.test(page.chapter.id)) {
            const chapter = await read(`/chapters/${page.chapter.id}`);
            if (chapter.ok) {
              chapter.diagnostic.result = { ...chapterIdentity(chapter.data) };
              report.outcome = "AUDIOBOOK_CHAPTERS_READABLE";
            } else {
              report.outcome = "AUDIOBOOK_CHAPTER_DETAIL_INCONCLUSIVE";
            }
          } else {
            report.outcome = "AUDIOBOOK_CHAPTER_LIST_EMPTY_OR_UNRECOGNIZED";
          }
        } else {
          report.outcome = "AUDIOBOOK_CHAPTER_LIST_INCONCLUSIVE";
        }
      }
    } else if (audiobook.diagnostic.status === 404) {
      // A /show/ URL alone does not prove show vs audiobook.
      const show = await read(`/shows/${spotifyId}`);
      if (show.ok) {
        show.diagnostic.result = { ...catalogIdentity(show.data, "show") };
        report.outcome = "SHOW_API_OBJECT_FOUND_NOT_AUDIOBOOK_API";
      } else {
        report.outcome = "CATALOG_OBJECT_INCONCLUSIVE";
      }
    } else {
      report.outcome = "AUDIOBOOK_READ_BLOCKED_OR_INCONCLUSIVE";
    }
  } catch (error) {
    if (error instanceof SpotifyBackoffActiveError) {
      report.outcome = "GLOBAL_SPOTIFY_BACKOFF_ACTIVE";
      report.backoff = { reason: error.reason, secondsRemaining: error.retryAfterSecondsRemaining };
    } else {
      report.outcome = "PROBE_ABORTED_UNEXPECTED_ERROR";
    }
  }
  report.getCalls = calls;
  report.playlistCompatibility = "UNTESTED";
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(() => {
    // No exception data: OAuth/provider exceptions can carry sensitive payloads.
    console.error("AUDIOBOOK-01 Gate 1B: initialization failed; check local environment/logs without sharing secrets.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
