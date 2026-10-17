/**
 * AUDIOBOOK-01 Gate 1E: investigate HTTP 502 differences without writing.
 *
 * Strictly metadata-only. At most five Spotify GET requests:
 *   /me, /episodes/chapter, /episodes/control, /shows/chapterShow, /shows/controlShow
 * The show IDs must be obtained from the two fixed validated episode objects.
 * Zero Spotify POST/PUT/PATCH/DELETE, DB writes, OAuth refresh or player actions.
 * Responses 403/404 from /shows are diagnostic; 429/5xx abort. No retries.
 * Do NOT call an old chapter POST script: control playlist is no longer empty.
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { SpotifyApiError } from "@/services/spotify/errors";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { asObject, profileId } from "@/services/spotify/audiobook-playlist-gate1c";
import {
  GATE1E, episodeMetadata, showMetadata, compareEpisodeMetadata,
} from "@/services/spotify/audiobook-gate1e-forensics";

const MAX_GET = 5;
function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(s => s.startsWith(prefix))?.slice(prefix.length).trim() || null;
}
function errorInfo(e: unknown, operation: string) {
  return e instanceof SpotifyApiError
    ? { operation, status: e.status, kind: e.kind }
    : { operation, status: null, kind: "LOCAL_OR_NETWORK" };
}
async function main() {
  const report: Record<string, unknown> = {
    gate: "AUDIOBOOK-01/1E_502_FORENSICS_READONLY",
    outcome: "NOT_STARTED",
    chapterId: GATE1E.chapterId,
    podcastControlId: GATE1E.controlId,
    GET: 0, POST: 0, PUT: 0, DELETE: 0, oauthRefresh: false,
    playlistWrites: 0, playerCommands: 0, automaticRetries: 0,
    noPlaylistWriteSupportClaim: true,
  };
  let gets = 0;
  let operation = "LOCAL_PREFLIGHT";
  async function get<T>(path: string, token: string): Promise<T> {
    if (gets >= MAX_GET) throw Error("GET_BUDGET_EXHAUSTED");
    await assertSpotifyBackoffInactive();
    gets++;
    report.GET = gets;
    operation = `GET ${path.split("?")[0] ?? path}`;
    return spotifyRequestAttempt<T>({
      accessToken: token, method: "GET", operation: "spotify-api", path,
    });
  }
  async function readShow(showId: string | null, token: string) {
    if (!showId) return { status: null, missingFromEpisode: true, metadata: null };
    try {
      const data = asObject(await get<unknown>(`/shows/${showId}?market=BR`, token));
      return { status: 200, metadata: showMetadata(data, showId) };
    } catch (e) {
      if (e instanceof SpotifyApiError && (e.status === 403 || e.status === 404)) {
        return { status: e.status, metadata: null };
      }
      throw e;
    }
  }

  try {
    if (process.argv.some(a => a === "--allow-token-refresh" || a === "--execute-post" ||
        a.startsWith("--confirm=") || a.startsWith("--write"))) {
      report.outcome = "FORBIDDEN_WRITE_OR_REFRESH_ARGUMENT";
      return;
    }
    const email = option("email");
    if (!email) { report.outcome = "EMAIL_REQUIRED"; return; }
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        accounts: {
          where: { provider: "spotify" }, take: 1,
          select: { access_token: true, expires_at: true },
        },
      },
    });
    const account = user?.accounts[0];
    if (!account) { report.outcome = "SPOTIFY_ACCOUNT_NOT_CONNECTED"; return; }
    if (!account.expires_at ||
        account.expires_at <= Math.floor(Date.now() / 1000) + 60) {
      report.outcome = "TOKEN_EXPIRED_NO_REFRESH"; return;
    }
    const token = account.access_token;
    if (!token) { report.outcome = "NO_ACCESS_TOKEN"; return; }

    const me = asObject(await get<unknown>("/me", token));
    if (!profileId(me)) { report.outcome = "PROFILE_NOT_VERIFIED"; return; }

    const chapterRaw = await get<unknown>(`/episodes/${GATE1E.chapterId}?market=BR`, token);
    const controlRaw = await get<unknown>(`/episodes/${GATE1E.controlId}?market=BR`, token);
    const chapter = episodeMetadata(chapterRaw, GATE1E.chapterId);
    const control = episodeMetadata(controlRaw, GATE1E.controlId);
    const comparison = compareEpisodeMetadata(chapter, control);

    const { showId: chapterShowId, ...chapterSanitized } = chapter;
    const { showId: podcastShowId, ...controlSanitized } = control;
    report.episodeMetadata = {
      audiobookChapterViaEpisodeEndpoint: chapterSanitized,
      ordinaryPodcastEpisode: controlSanitized,
      comparison,
    };
    if (!comparison.bothResolveAsEpisode || !comparison.bothHaveShows) {
      report.outcome = "EPISODE_ID_OR_SHOW_UNVERIFIED_NO_SHOW_GET";
      return;
    }

    const chapterShow = await readShow(chapterShowId, token);
    const podcastShow = chapterShowId === podcastShowId
      ? { ...chapterShow, reusedSameShow: true }
      : await readShow(podcastShowId, token);
    report.showMetadata = {
      forAudiobookChapter: chapterShow,
      forPodcastControl: podcastShow,
      metadataOnlyNoPlaylistWriteConclusion: true,
    };
    report.outcome = "GATE1E_METADATA_FORENSICS_COMPLETE_NO_WRITES";
  } catch (e) {
    report.failure = errorInfo(e, operation);
    report.outcome = "GATE1E_PARTIAL_NO_WRITES";
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => {
  console.error("Gate 1E read-only initialization failed; credentials suppressed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
