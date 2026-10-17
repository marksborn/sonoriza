/**
 * Gate 1C — One-time private Spotify playlist test of one 1984 audiobook chapter.
 * Intentional Spotify writes: at most one POST create + one POST insert.
 * No player commands, no library changes, no removal and no blind POST retries.
 * The result JSON never includes OAuth credentials or personal listening data.
 *
 * Usage: npx tsx scripts/probe-audiobook-playlist-gate1c.ts \\
 *    --email=... --confirm=AUDIOBOOK-01-CRIAR-E-ADICIONAR
 * Optional: --allow-token-refresh (can update OAuth credentials in Account).
 * RE-RUNNING WITH --confirm IS NOT IDEMPOTENT if the first POST outcome was
 * ambiguous. Do not retry on timeouts; inspect Spotify playlist UI first.
 */
import { prisma } from "@/lib/prisma";
import { getSpotifyAccessToken } from "@/services/spotify/token";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { SpotifyApiError } from "@/services/spotify/errors";
import {
  GATE1C, asObject, stringField, safeId, profileId,
  chapterEligible, playlistOwnedPrivate, containsChapter,
} from "@/services/spotify/audiobook-playlist-gate1c";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((part) => part.startsWith(prefix))?.slice(prefix.length) || null;
}
type Report = {
  gate: string;
  audiobookId: string;
  chapterUri: string;
  playlistName: string;
  playlistId: string | null;
  playlistUrl: string | null;
  checks: string[];
  oauthRefreshAllowed: boolean;
  spotifyGetCalls: number;
  spotifyPostAttempts: number;
  outcome: string;
  playlistItemFound?: boolean;
  firstItemType?: string | null;
  playlistItemCount?: number | null;
  snapshotReturned?: boolean;
  providerFailure?: { operation: string; status: number | null; kind: string };
  safety: { productionPlaylistsAltered: false; playerCommands: 0; automaticRetriesOfWrites: 0; };
};

async function main(): Promise<void> {
  const confirm = arg("confirm");
  const email = arg("email");
  const allowRefresh = process.argv.includes("--allow-token-refresh");
  const report: Report = {
    gate: "AUDIOBOOK-01/1C",
    audiobookId: GATE1C.audiobookId,
    chapterUri: GATE1C.chapterUri,
    playlistName: GATE1C.secondPrivatePlaylistName,
    playlistId: null,
    playlistUrl: null,
    checks: [],
    oauthRefreshAllowed: allowRefresh,
    spotifyGetCalls: 0,
    spotifyPostAttempts: 0,
    outcome: "NOT_STARTED",
    safety: {
      productionPlaylistsAltered: false,
      playerCommands: 0,
      automaticRetriesOfWrites: 0,
    },
  };
  let lastOperation = "LOCAL_PREFLIGHT";

  async function call<T>(method: "GET" | "POST", path: string, accessToken: string, body?: object): Promise<T> {
    await assertSpotifyBackoffInactive();
    lastOperation = `${method} ${path.split("?")[0]}`;
    if (method === "GET") report.spotifyGetCalls++;
    else {
      if (report.spotifyPostAttempts >= 2) throw Error("POST_BUDGET_EXHAUSTED");
      report.spotifyPostAttempts++;
    }
    return spotifyRequestAttempt<T>({
      accessToken,
      path,
      method,
      operation: method === "GET" ? "spotify-api" : "playlist-write",
      ...(body ? { init: { method, body: JSON.stringify(body) } } : {}),
    });
  }

  try {
    if (!email || confirm !== GATE1C.confirm) {
      report.outcome = "EXPLICIT_CONFIRMATION_REQUIRED";
      return;
    }
    const user = await prisma.user.findUnique({
      where: { email }, select: {
        id: true,
        accounts: { where: { provider: "spotify" }, take: 1,
          select: { access_token: true, expires_at: true, scope: true } },
      },
    });
    const account = user?.accounts[0];
    if (!user || !account) {
      report.outcome = "SPOTIFY_ACCOUNT_NOT_CONNECTED";
      return;
    }
    const scopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("playlist-modify-private") || !scopes.has("playlist-read-private")) {
      report.outcome = "MISSING_PRIVATE_PLAYLIST_SCOPES";
      report.checks.push(`modifyPrivate=${scopes.has("playlist-modify-private")}`);
      report.checks.push(`readPrivate=${scopes.has("playlist-read-private")}`);
      return;
    }
    report.checks.push("PRIVATE_PLAYLIST_SCOPES_OK");
    const expired = !account.expires_at ||
      account.expires_at <= Math.floor(Date.now() / 1000) + 60;
    if (expired && !allowRefresh) {
      report.outcome = "TOKEN_EXPIRED_REFRESH_NOT_AUTHORIZED";
      return;
    }
    const tokenOrNull = expired ? await getSpotifyAccessToken(user.id) : account.access_token;
    if (!tokenOrNull) {
      report.outcome = "NO_VALID_ACCESS_TOKEN";
      return;
    }
    const token: string = tokenOrNull;
    const profile = await call<unknown>("GET", "/me", token);
    const ownerId = profileId(profile);
    if (!ownerId) {
      report.outcome = "INVALID_SPOTIFY_PROFILE";
      return;
    }

    const chapter = await call<unknown>("GET", `/chapters/${GATE1C.chapterId}`, token);
    if (!chapterEligible(chapter)) {
      report.outcome = "CHAPTER_UNAVAILABLE_OR_UNEXPECTED";
      return;
    }
    report.checks.push("EXPECTED_PLAYABLE_CHAPTER_CONFIRMED");

    const existing = await call<unknown>("GET", "/me/playlists?limit=50&offset=0", token);
    const listed = asObject(existing);
    const page = Array.isArray(listed?.items) ? listed.items : [];
    if (page.some((value) => {
      const entry = asObject(value);
      return entry?.name === GATE1C.secondPrivatePlaylistName && profileId(entry?.owner) === ownerId;
    })) {
      report.outcome = "TEST_PLAYLIST_NAME_ALREADY_EXISTS_DO_NOT_REPEAT";
      return;
    }
    report.checks.push("NO_MATCHING_PLAYLIST_IN_FIRST_50");

    // Exact first authorized write. POST timeouts have an unknown outcome:
    // NEVER retry automatically; report and inspect Spotify account instead.
    lastOperation = "POST /me/playlists";
    const created = await call<unknown>("POST", "/me/playlists", token, {
      name: GATE1C.secondPrivatePlaylistName, public: false, collaborative: false,
      description: GATE1C.description,
    });
    const createdObj = asObject(created);
    const playlistId = safeId(createdObj?.id);
    if (playlistId) {
      report.playlistId = playlistId;
      report.playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
    }
    if (!playlistId || !playlistOwnedPrivate(created, ownerId, GATE1C.secondPrivatePlaylistName)) {
      report.outcome = "CREATE_RESPONSE_NOT_VERIFIED_PRIVATE_STOP_NO_INSERT";
      return;
    }
    report.checks.push("CREATE_RESPONSE_PRIVATE_OWNER_OK");

    const playlist = await call<unknown>("GET", `/playlists/${playlistId}`, token);
    if (!playlistOwnedPrivate(playlist, ownerId, GATE1C.secondPrivatePlaylistName)) {
      report.outcome = "POST_CREATE_PLAYLIST_NOT_PRIVATE_STOP_NO_INSERT";
      return;
    }
    report.checks.push("POST_CREATE_PRIVATE_PLAYLIST_CONFIRMED");

    // Exact second authorized write, only into verified new empty test playlist.
    const before = await call<unknown>("GET", `/playlists/${playlistId}/items?limit=1&additional_types=episode`, token);
    const beforeState = containsChapter(before);
    if (beforeState.total !== 0) {
      report.outcome = "TEST_PLAYLIST_NOT_EMPTY_STOP_NO_INSERT";
      return;
    }
    report.checks.push("PRIVATE_TEST_PLAYLIST_EMPTY");

    lastOperation = `POST /playlists/${playlistId}/items`;
    const inserted = await call<unknown>("POST", `/playlists/${playlistId}/items`, token, {
      uris: [GATE1C.chapterUri], position: 0,
    });
    report.snapshotReturned = typeof asObject(inserted)?.snapshot_id === "string";
    report.checks.push("INSERT_REQUEST_ACCEPTED");

    const result = await call<unknown>("GET", `/playlists/${playlistId}/items?limit=10&additional_types=episode`, token);
    const checked = containsChapter(result);
    report.playlistItemFound = checked.chapterFound;
    report.playlistItemCount = checked.total;
    report.firstItemType = checked.firstItemType;
    report.outcome = checked.chapterFound
      ? "CHAPTER_PRESENT_IN_PRIVATE_TEST_PLAYLIST_MANUAL_PLAYBACK_PENDING"
      : "INSERT_ACCEPTED_BUT_CHAPTER_NOT_FOUND_MANUAL_REVIEW";
  } catch (error) {
    if (error instanceof SpotifyApiError) {
      report.providerFailure = { operation: lastOperation, status: error.status, kind: error.kind };
      report.outcome = lastOperation.startsWith("POST")
        ? (error.kind === "WRITE_TIMEOUT" ? "WRITE_OUTCOME_UNKNOWN_DO_NOT_RETRY" : "SPOTIFY_POST_REJECTED_DO_NOT_RETRY")
        : "SPOTIFY_READ_BLOCKED_OR_UNAVAILABLE";
    } else {
      report.providerFailure = { operation: lastOperation, status: null, kind: "UNEXPECTED_OR_PRECONDITION" };
      report.outcome = report.spotifyPostAttempts > 0
        ? "POST_MAY_HAVE_CHANGED_SPOTIFY_DO_NOT_RETRY"
        : "PROBE_ABORTED_BEFORE_WRITES";
    }
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main()
  .catch(() => {
    console.error("Gate 1C initialization failed (details suppressed). No automatic retry.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
