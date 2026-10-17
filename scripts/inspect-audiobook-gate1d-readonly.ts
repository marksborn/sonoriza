/**
 * AUDIOBOOK-01 Gate 1D — read-only, fixed-ID, shape-only diagnostic.
 *
 * NEVER uses OAuth refresh and NEVER POST/PUT/PATCH/DELETE Spotify endpoints.
 * ZERO playlist writes, player controls, secrets printed or production deploy.
 * Up to 9 GET requests with no automatic retries:
 * 1 /me; 2 /chapters/chapterId; 3 /episodes/chapterId;
 * 4 /episodes/controlId; 5 /audiobooks/bookId; 6-9 playlist metadata and items.
 * An expected 404 on GET /episodes/{chapterId} is evidence, not a script error.
 * Preflight fails if access token has expired; renewal requires new consent.
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { SpotifyApiError } from "@/services/spotify/errors";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { asObject, profileId } from "@/services/spotify/audiobook-playlist-gate1c";
import {
  GATE1D, contentShape, playlistIdentity, playlistItemsShape, gate1dHypothesis,
} from "@/services/spotify/audiobook-gate1d-readonly";

const MAX_GETS = 9;
function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(x => x.startsWith(prefix))?.slice(prefix.length).trim() || null;
}
function summarizeFailure(error: unknown, operation: string) {
  return error instanceof SpotifyApiError
    ? { operation, status: error.status, kind: error.kind }
    : { operation, status: null, kind: "LOCAL_OR_NETWORK" };
}
async function main() {
  const report: Record<string, unknown> = {
    gate: "AUDIOBOOK-01/1D_CHAPTER_VS_EPISODE_READONLY",
    outcome: "NOT_STARTED",
    docReadme: "docs/spikes/AUDIOBOOK-01-GATE1D.md",
    audiobookId: GATE1D.bookId,
    chapterId: GATE1D.chapterId,
    podcastControlId: GATE1D.controlEpisodeId,
    experimentalPlaylists: [GATE1D.secondPlaylistId, GATE1D.manualPlaylistId],
    getAttempts: 0, postAttempts: 0, putAttempts: 0,
    deleteAttempts: 0, oauthRefresh: false, playlistWrites: 0,
    playerCommands: 0, automaticRetries: 0,
  };
  let gets = 0;
  let lastOperation = "LOCAL_PREFLIGHT";
  async function get<T>(path: string, token: string): Promise<T> {
    if (gets >= MAX_GETS) throw new Error("READ_BUDGET_EXHAUSTED");
    await assertSpotifyBackoffInactive();
    gets++;
    report.getAttempts = gets;
    lastOperation = `GET ${path.split("?")[0] ?? path}`;
    return spotifyRequestAttempt<T>({
      accessToken: token, method: "GET", operation: "spotify-api", path,
    });
  }
  // Expected restrictions (403, 404) are reported; timeouts, 5xx, 429 abort.
  async function observe(path: string, token: string) {
    try {
      const obj = asObject(await get<unknown>(path, token));
      return { status: 200, object: obj };
    } catch (error) {
      if (error instanceof SpotifyApiError &&
          [403, 404].includes(error.status)) {
        return { status: error.status, object: null };
      }
      throw error;
    }
  }
  async function inspectPlaylist(id: string, token: string, ownerId: string) {
    const details = asObject(await get<unknown>(
      `/playlists/${id}?fields=id,name,public,collaborative,owner(id),snapshot_id,items(total)`,
      token,
    ));
    const identity = playlistIdentity(details, ownerId, id);
    if (!identity.exactId || !identity.exactOwner || !identity.exactName) {
      return { identity, itemsNotRead: "IDENTITY_NOT_VERIFIED" };
    }
    const items = await get<unknown>(
      `/playlists/${id}/items?limit=5&offset=0&additional_types=episode`,
      token,
    );
    return {
      identity, items: playlistItemsShape(
        items, GATE1D.chapterUri, GATE1D.controlEpisodeUri,
      ),
    };
  }
  try {
    if (process.argv.includes("--allow-token-refresh") ||
        process.argv.includes("--execute-post") ||
        process.argv.some(x => x.startsWith("--confirm="))) {
      report.outcome = "FORBIDDEN_WRITE_OR_REFRESH_FLAGS";
      return;
    }
    const email = option("email");
    if (!email) { report.outcome = "EMAIL_REQUIRED"; return; }
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        accounts: {
          where: { provider: "spotify" }, take: 1,
          select: { access_token: true, expires_at: true, scope: true },
        },
      },
    });
    const account = user?.accounts[0];
    if (!account) { report.outcome = "NO_SPOTIFY_ACCOUNT"; return; }
    const scopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("playlist-read-private")) {
      report.outcome = "PLAYLIST_READ_PRIVATE_SCOPE_REQUIRED"; return;
    }
    if (!account.expires_at ||
        account.expires_at <= Math.floor(Date.now() / 1000) + 60) {
      report.outcome = "TOKEN_EXPIRED_NO_REFRESH"; return;
    }
    const token = account.access_token;
    if (!token) { report.outcome = "NO_ACCESS_TOKEN"; return; }

    const me = asObject(await get<unknown>("/me", token));
    const ownerId = profileId(me);
    if (!ownerId) { report.outcome = "PROFILE_UNVERIFIED"; return; }

    const chapter = await observe(`/chapters/${GATE1D.chapterId}?market=BR`, token);
    const chapterAsEpisode = await observe(`/episodes/${GATE1D.chapterId}?market=BR`, token);
    const podcast = await observe(`/episodes/${GATE1D.controlEpisodeId}?market=BR`, token);
    const audiobook = await observe(`/audiobooks/${GATE1D.bookId}?market=BR`, token);

    const chapterShape = contentShape(chapter.object, GATE1D.chapterId);
    const episodeLookupShape = contentShape(chapterAsEpisode.object, GATE1D.chapterId);
    const controlShape = contentShape(podcast.object, GATE1D.controlEpisodeId);
    const audiobookShape = {
      status: audiobook.status,
      idMatches: audiobook.object?.id === GATE1D.bookId,
      type: typeof audiobook.object?.type === "string" ? audiobook.object.type : null,
      totalChapters: typeof audiobook.object?.total_chapters === "number"
        ? audiobook.object.total_chapters : null,
    };

    report.content = {
      chapterEndpoint: { status: chapter.status, ...chapterShape },
      chapterIdViaEpisodeEndpoint: {
        status: chapterAsEpisode.status, ...episodeLookupShape,
      },
      ordinaryEpisodeControl: { status: podcast.status, ...controlShape },
      audiobookEndpoint: audiobookShape,
      apiTypeHypothesis: gate1dHypothesis(
        chapterShape.type, chapterAsEpisode.status,
        episodeLookupShape.type, controlShape.type,
      ),
    };

    const privatePlaylist = await inspectPlaylist(GATE1D.secondPlaylistId, token, ownerId);
    const manualPlaylist = await inspectPlaylist(GATE1D.manualPlaylistId, token, ownerId);
    report.playlists = { privatePodcastControl: privatePlaylist, manualAudiobook: manualPlaylist };
    report.outcome = "GATE1D_READONLY_COMPLETE_INTERPRET_WITH_CARE";
  } catch (error) {
    report.failure = summarizeFailure(error, lastOperation);
    report.outcome = "GATE1D_PARTIAL_NO_WRITES";
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => {
  console.error("Gate 1D read-only startup failed; details suppressed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
