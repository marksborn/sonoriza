/**
 * AUDIOBOOK-01 Gate 1C CONTROL: ordinary podcast episode vs audiobook chapter.
 *
 * DEFAULT MODE IS READ ONLY. Never send Spotify playlist writes unless:
 *   --execute-post --confirm=AUDIOBOOK-01-PODCAST-CONTROLE-UM-EPISODIO
 * are supplied after separate approval. This preparation did NOT authorize it.
 *
 * User selects a normal Spotify podcast episode via --episode-url=...;
 * the Spotify GET /episodes/{id} response MUST establish type=episode,
 * playable=true and a genuine show, not a chapter of an audiobook.
 *
 * Target: existing private empty experimental playlist only. OAuth refresh
 * needs separate explicit --allow-token-refresh flag, may update Account tokens.
 * Max 6 Spotify GET, at most 1 POST, never retried; no playlist creation,
 * removal, privacy modification, player commands, merge or deployment.
 * Upon a POST error, reconcile once by GET, never re-POST.
 */
import { prisma } from "@/lib/prisma";
import { getSpotifyAccessToken } from "@/services/spotify/token";
import { SpotifyApiError } from "@/services/spotify/errors";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { asObject, profileId, stringField } from "@/services/spotify/audiobook-playlist-gate1c";
import {
  PODCAST_CONTROL, controlEpisodeId, eligiblePodcastEpisode,
  eligibleEmptyControlPlaylist, summarizeControlItems,
} from "@/services/spotify/podcast-control-gate1c";

const MAX_GETS = 6;
function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(p => p.startsWith(prefix))?.slice(prefix.length).trim() || null;
}
function publicStatus(v: unknown): string {
  return v === false ? "false" : v === true ? "true" : v === null ? "null" : "missing";
}
function failureInfo(e: unknown, operation: string) {
  return e instanceof SpotifyApiError
    ? { operation, status: e.status, kind: e.kind }
    : { operation, status: null, kind: "LOCAL_NETWORK_OR_PARSE" };
}
async function main() {
  const execute = process.argv.includes("--execute-post");
  const confirm = option("confirm");
  const refresh = process.argv.includes("--allow-token-refresh");
  const email = option("email");
  const id = controlEpisodeId(option("episode-url") ?? option("episode"));
  const uri = id ? `spotify:episode:${id}` : null;
  const report: Record<string, unknown> = {
    issue: 482,
    gate: "AUDIOBOOK-01/1C_PODCAST_CONTROL",
    mode: execute ? "ONE_TIME_POST_OPT_IN" : "DRY_RUN_READ_ONLY",
    outcome: "NOT_STARTED",
    playlistId: PODCAST_CONTROL.playlistId,
    playlistUrl: `https://open.spotify.com/playlist/${PODCAST_CONTROL.playlistId}`,
    episodeId: id, episodeUri: uri,
    spotifyGetAttempts: 0,
    spotifyPostAttempts: 0,
    oauthRefreshOptIn: refresh,
    playlistCreates: 0,
    playlistRemovals: 0,
    privacyChanges: 0,
    playerCommands: 0,
    automatedPostRetries: 0,
  };
  let gets = 0;
  let postAttempted = false;
  let operation = "PREFLIGHT";

  async function read<T>(path: string, token: string): Promise<T> {
    if (gets >= MAX_GETS) throw Error("GET_BUDGET_EXCEEDED");
    await assertSpotifyBackoffInactive();
    gets++;
    report.spotifyGetAttempts = gets;
    operation = `GET ${path.split("?")[0] ?? path}`;
    return spotifyRequestAttempt<T>({
      accessToken: token, method: "GET", path, operation: "spotify-api",
    });
  }
  const playlistPath = `/playlists/${PODCAST_CONTROL.playlistId}`;
  const detailsPath = `${playlistPath}?fields=id,name,public,collaborative,owner(id),snapshot_id,items(total)`;
  const itemsPath = `${playlistPath}/items?limit=10&offset=0&additional_types=episode`;

  try {
    if (!email || !id || !uri) {
      report.outcome = "EMAIL_AND_VALID_PODCAST_EPISODE_LINK_REQUIRED";
      return;
    }
    if ((execute && confirm !== PODCAST_CONTROL.writeConfirm) ||
        (!execute && confirm !== null)) {
      report.outcome = "EXPLICIT_CONTROL_WRITE_CONFIRMATION_REQUIRED";
      return;
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        accounts: {
          where: { provider: "spotify" }, take: 1,
          select: { access_token: true, expires_at: true, scope: true },
        },
      },
    });
    const account = user?.accounts[0];
    if (!user || !account) { report.outcome = "NO_CONNECTED_SPOTIFY_ACCOUNT"; return; }
    const scopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("playlist-read-private") ||
        (execute && !scopes.has("playlist-modify-private"))) {
      report.outcome = "REQUIRED_PRIVATE_PLAYLIST_SCOPES_MISSING";
      return;
    }
    const expired = !account.expires_at ||
      account.expires_at <= Math.floor(Date.now() / 1000) + 60;
    if (expired && !refresh) {
      report.outcome = "TOKEN_EXPIRED_NO_REFRESH";
      return;
    }
    // Opt-in only; token renewal may update the Account credential fields.
    const token = expired ? await getSpotifyAccessToken(user.id) : account.access_token;
    if (!token) { report.outcome = "NO_ACCESS_TOKEN"; return; }

    const profile = asObject(await read<unknown>("/me", token));
    const ownerId = profileId(profile);
    if (!ownerId) { report.outcome = "SPOTIFY_USER_UNVERIFIED"; return; }

    const episode = asObject(await read<unknown>(`/episodes/${id}?market=BR`, token));
    if (!eligiblePodcastEpisode(episode, id)) {
      report.outcome = "NOT_A_PLAYABLE_ORDINARY_PODCAST_EPISODE";
      return;
    }
    report.episode = {
      id,
      uri,
      title: stringField(episode?.name),
      showName: stringField(asObject(episode?.show)?.name),
      showType: stringField(asObject(episode?.show)?.type),
      isPlayable: episode?.is_playable === true,
      episodeType: stringField(episode?.type),
    };

    const playlist = asObject(await read<unknown>(detailsPath, token));
    report.target = {
      exactPlaylistAndOwnerAndEmpty: eligibleEmptyControlPlaylist(playlist, ownerId),
      nameMatches: playlist?.name === PODCAST_CONTROL.playlistName,
      ownerMatches: profileId(playlist?.owner) === ownerId,
      apiPublic: publicStatus(playlist?.public),
      collaborative: playlist?.collaborative === true,
      totalItems: typeof asObject(playlist?.items)?.total === "number"
        ? asObject(playlist?.items)?.total : null,
    };
    if (!eligibleEmptyControlPlaylist(playlist, ownerId)) {
      report.outcome = "TARGET_NOT_VERIFIED_PRIVATE_AND_EMPTY";
      return;
    }
    const snapshot = stringField(playlist?.snapshot_id);

    const before = asObject(await read<unknown>(itemsPath, token));
    const beforeRows = Array.isArray(before?.items) ? before.items : null;
    if (!beforeRows || before?.total !== 0 || beforeRows.length !== 0) {
      report.outcome = "PLAYLIST_NOT_EMPTY_ABORT_NO_WRITE";
      return;
    }
    if (!execute) {
      report.outcome = "CONTROL_DRY_RUN_READY_NO_WRITES";
      return;
    }

    // Resolve race: verify the same snapshot and empty playlist immediately
    // before the one authorized POST. Never overwrite pre-existing items.
    const lastCheck = asObject(await read<unknown>(detailsPath, token));
    if (!eligibleEmptyControlPlaylist(lastCheck, ownerId) ||
        !snapshot || lastCheck?.snapshot_id !== snapshot) {
      report.outcome = "PLAYLIST_CHANGED_SINCE_PREFLIGHT_NO_WRITE";
      return;
    }

    let postError: ReturnType<typeof failureInfo> | null = null;
    let successResponse = false;
    try {
      await assertSpotifyBackoffInactive();
      operation = `POST ${playlistPath}/items`;
      report.spotifyPostAttempts = 1;
      postAttempted = true;
      const response = asObject(await spotifyRequestAttempt<unknown>({
        accessToken: token, method: "POST",
        path: `${playlistPath}/items`,
        operation: "playlist-write",
        init: { method: "POST", body: JSON.stringify({ uris: [uri], position: 0 }) },
      }));
      successResponse = true;
      report.postSnapshotReturned = typeof response?.snapshot_id === "string";
    } catch (e) {
      postError = failureInfo(e, operation);
      report.postFailure = postError;
      // No retry, including on an HTTP 502, 429, timeout or JSON parse error.
    }

    // Reconcile ONCE even when POST returns HTTP 502. This GET never inserts.
    operation = `GET ${playlistPath}/items`;
    try {
      const after = await read<unknown>(itemsPath, token);
      const state = summarizeControlItems(after, uri);
      report.reconciled = state;
      if (state.matched) {
        report.outcome = postError
          ? "CONTROL_EPISODE_PRESENT_AFTER_POST_ERROR_MANUAL_PLAYBACK_PENDING"
          : "CONTROL_EPISODE_PRESENT_MANUAL_PLAYBACK_PENDING";
      } else if (state.total === 0 && state.returned === 0) {
        report.outcome = postError
          ? "CONTROL_POST_ERROR_AND_EMPTY_NO_AUTOMATIC_RETRY"
          : "CONTROL_POST_SUCCESS_BUT_EMPTY_NEEDS_REVIEW";
      } else {
        report.outcome = "CONTROL_ITEM_OPAQUE_OR_UNEXPECTED_NEEDS_REVIEW";
      }
      report.postRequestReturned = successResponse;
    } catch (readError) {
      report.reconciliationFailure = failureInfo(readError, operation);
      report.outcome = "CONTROL_POST_OUTCOME_UNKNOWN_READ_AFTER_FAILED_NO_RETRY";
    }
  } catch (error) {
    report.failure = failureInfo(error, operation);
    report.outcome = postAttempted
      ? "CONTROL_POST_OUTCOME_UNKNOWN_DO_NOT_RETRY"
      : "CONTROL_PREFLIGHT_ABORTED_NO_WRITES";
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => {
  console.error("Podcast control runner initialization failed; no credentials printed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
