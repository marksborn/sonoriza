/**
 * Gate AUDIOBOOK-01 / 1C: controlled one-off chapter insertion in the ALREADY
 * CREATED second experimental playlist. User manually set it private in the app.
 * Spotify API 'public' reflects profile discoverability, not reliable evidence
 * of client-private link access; report its value without claiming equivalence.
 *
 * Allowed: <= 5 Spotify GETs, <= 1 Spotify POST to exact fixed playlist.
 * Never create, delete, rename, change visibility, remove items or play.
 * OAuth refresh is available ONLY through explicit --allow-token-refresh opt-in
 * and may update Account OAuth credential fields in the database.
 * No retries of Spotify writes. Do not run twice after POST.
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { SpotifyApiError } from "@/services/spotify/errors";
import { getSpotifyAccessToken } from "@/services/spotify/token";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import {
  GATE1C, asObject, profileId, chapterEligible, containsChapter,
  mayInsertChapterIntoExistingSecondPlaylist,
} from "@/services/spotify/audiobook-playlist-gate1c";

const TARGET_ID = "1tsFauBmlMXWJLNKTCQFQE";
const CONFIRM = "AUDIOBOOK-01-INSERIR-UM-CAPITULO";
const APP_PRIVACY_CONFIRMATION = "--app-private-confirmed";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((part) => part.startsWith(prefix))?.slice(prefix.length).trim() || null;
}
function boolStatus(value: unknown): string {
  return value === true ? "true" : value === false ? "false" : value === null ? "null" : "absent_or_other";
}
async function main(): Promise<void> {
  const allowTokenRefresh = process.argv.includes("--allow-token-refresh");
  const report: Record<string, unknown> = {
    gate: "AUDIOBOOK-01/1C_EXISTING_SECOND_CHAPTER_WRITE",
    outcome: "NOT_STARTED",
    playlistId: TARGET_ID,
    playlistUrl: `https://open.spotify.com/playlist/${TARGET_ID}`,
    expectedPlaylistName: GATE1C.secondPrivatePlaylistName,
    chapterId: GATE1C.chapterId,
    chapterUri: GATE1C.chapterUri,
    spotifyGetAttempts: 0,
    spotifyPostAttempts: 0,
    spotifyPlaylistCreates: 0,
    spotifyOtherPlaylistWrites: 0,
    spotifyPlayerCommands: 0,
    oauthRefresh: allowTokenRefresh,
    appPrivateUserConfirmed: false,
    noAutomaticWriteRetries: true,
  };
  let lastOperation = "LOCAL_PREFLIGHT";
  let gets = 0;
  let posted = false;
  async function read<T>(path: string, token: string): Promise<T> {
    if (gets >= 5) throw Error("GET_BUDGET_EXHAUSTED");
    await assertSpotifyBackoffInactive();
    gets++;
    report.spotifyGetAttempts = gets;
    lastOperation = `GET ${path.split("?")[0] ?? path}`;
    return spotifyRequestAttempt<T>({
      accessToken: token, path, method: "GET", operation: "spotify-api",
    });
  }
  try {
    const email = option("email");
    if (!email || option("confirm") !== CONFIRM ||
        !process.argv.includes(APP_PRIVACY_CONFIRMATION)) {
      report.outcome = "EXPLICIT_CONFIRMATION_REQUIRED";
      return;
    }
    // This attestation was directly stated by the user in the conversation:
    // "Alterei para privada" in Spotify Android.
    report.appPrivateUserConfirmed = true;

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
    if (!user || !account) { report.outcome = "SPOTIFY_ACCOUNT_NOT_CONNECTED"; return; }
    const scopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("playlist-modify-private") || !scopes.has("playlist-read-private")) {
      report.outcome = "PRIVATE_PLAYLIST_SCOPES_MISSING";
      return;
    }
    const tokenExpiresSoon = !account.expires_at ||
      account.expires_at <= Math.floor(Date.now() / 1000) + 60;
    if (tokenExpiresSoon && !allowTokenRefresh) {
      report.outcome = "TOKEN_EXPIRED_NO_REFRESH";
      return;
    }
    // This is the ONLY OAuth credential mutation permitted by this probe.
    // It is opt-in and occurs before ANY Spotify playlist write.
    const token = tokenExpiresSoon
      ? await getSpotifyAccessToken(user.id)
      : account.access_token;
    if (!token) { report.outcome = "NO_ACCESS_TOKEN"; return; }

    const me = asObject(await read<unknown>("/me", token));
    const ownerId = profileId(me);
    if (!ownerId) { report.outcome = "SPOTIFY_USER_UNVERIFIED"; return; }

    const chapter = await read<unknown>(`/chapters/${GATE1C.chapterId}`, token);
    if (!chapterEligible(chapter)) {
      report.outcome = "CHAPTER_NOT_CONFIRMED_PLAYABLE";
      return;
    }
    report.chapterValidated = true;

    const snapshotPath =
      `/playlists/${TARGET_ID}?fields=id,name,public,collaborative,owner(id),snapshot_id,items(total)`;
    const details = asObject(await read<unknown>(snapshotPath, token));
    const allowed = mayInsertChapterIntoExistingSecondPlaylist(details, ownerId, TARGET_ID);
    const originalSnapshot = typeof details?.snapshot_id === "string" ? details.snapshot_id : null;
    report.playlistPreflight = {
      identityAndEmptyAllowed: allowed,
      apiPublicState: boolStatus(details?.public),
      ownerMatches: profileId(details?.owner) === ownerId,
      nameMatches: details?.name === GATE1C.secondPrivatePlaylistName,
      totalItems: typeof asObject(details?.items)?.total === "number"
        ? asObject(details?.items)?.total : null,
      snapshotPresent: Boolean(originalSnapshot),
      appPrivateUserConfirmed: true,
    };
    if (!allowed || !originalSnapshot) {
      report.outcome = "PLAYLIST_IDENTITY_EMPTY_OR_SNAPSHOT_NOT_VERIFIED";
      return;
    }

    const before = asObject(await read<unknown>(
      `/playlists/${TARGET_ID}/items?limit=10&offset=0&additional_types=episode`, token));
    if (before?.total !== 0 || !Array.isArray(before.items) || before.items.length !== 0) {
      report.outcome = "PLAYLIST_NOT_EMPTY_ABORT_NO_POST";
      return;
    }

    // Exactly one POST, never automatically retry on 4xx, 5xx, timeout, or parse failure.
    posted = true;
    report.spotifyPostAttempts = 1;
    lastOperation = `POST /playlists/${TARGET_ID}/items`;
    try {
      await assertSpotifyBackoffInactive();
      const inserted = asObject(await spotifyRequestAttempt<unknown>({
        accessToken: token,
        path: `/playlists/${TARGET_ID}/items`,
        method: "POST",
        operation: "playlist-write",
        init: { method: "POST",
          body: JSON.stringify({ uris: [GATE1C.chapterUri], position: 0 }) },
      }));
      report.insertSnapshotReturned = typeof inserted?.snapshot_id === "string";
      report.insertResponse = "POST_RETURNED_SUCCESS";
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      report.insertResponse = "BODY_PARSE_FAILED_POST_MAY_HAVE_SUCCEEDED";
    }

    const after = asObject(await read<unknown>(
      `/playlists/${TARGET_ID}/items?limit=10&offset=0&additional_types=episode`, token));
    const checked = containsChapter(after);
    const hasRows = Array.isArray(after?.items);
    const rows = hasRows ? after.items as unknown[] : [];
    report.after = {
      total: checked.total,
      returned: rows.length,
      uriMatched: checked.chapterFound,
      firstItemType: checked.firstItemType,
      firstItemUriMatched: checked.firstItemUri === GATE1C.chapterUri,
      itemObjectNullOrMissing: rows.some(row => {
        const itemRow = asObject(row);
        return !asObject(itemRow?.item) && !asObject(itemRow?.track);
      }),
    };
    report.outcome = checked.chapterFound
      ? "CHAPTER_PRESENT_IN_TEST_PLAYLIST_MANUAL_PLAYBACK_PENDING"
      : "POST_SENT_BUT_CHAPTER_NOT_OBSERVABLE_DO_NOT_REPEAT";
  } catch (error) {
    report.failure = error instanceof SpotifyApiError
      ? { operation: lastOperation, status: error.status, kind: error.kind }
      : { operation: lastOperation, kind: "LOCAL_OR_NETWORK_OR_PARSE_ERROR" };
    report.outcome = posted ? "POST_FAILED_OR_OUTCOME_UNKNOWN_DO_NOT_REPEAT" : "ABORTED_BEFORE_POST";
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(() => {
  console.error("Gate 1C chapter runner startup failed; details suppressed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
