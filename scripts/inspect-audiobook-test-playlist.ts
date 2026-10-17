/**
 * AUDIOBOOK-01 Gate 1C reconciliation after duplicate playlist guard.
 *
 * READ ONLY: 5 GET maximum; no Spotify POST/PUT/DELETE and no playlist/player write.
 * Only inspect the existing, exact-named playlist owned by the connected account.
 * OAuth refresh is disabled by default (opt-in flag updates credential storage).
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { getSpotifyAccessToken } from "@/services/spotify/token";
import { SpotifyApiError } from "@/services/spotify/errors";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { GATE1C, asObject, profileId, safeId, stringField } from "@/services/spotify/audiobook-playlist-gate1c";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((part) => part.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

function itemSummary(raw: unknown): Record<string, unknown> {
  const row = asObject(raw);
  // Spotify API 2026 playlist format is 'item'; older responses can use 'track'.
  const content = asObject(row?.item) ?? asObject(row?.track);
  const uri = stringField(content?.uri);
  const uriKind = uri?.match(/^spotify:([a-z_-]+):/)?.[1] ?? null;
  const audiobook = asObject(content?.audiobook);
  const show = asObject(content?.show);
  const duration = content?.duration_ms;
  return {
    type: stringField(content?.type),
    uriKind,
    uri: uriKind === "chapter" || uriKind === "audiobook" || uriKind === "episode" ? uri : null,
    matchesTargetChapter: uri === GATE1C.chapterUri,
    matchesTargetAudiobook: uri === `spotify:audiobook:${GATE1C.audiobookId}`,
    relatedAudiobookId: stringField(audiobook?.id),
    relatedShowId: stringField(show?.id),
    durationMs: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
    playable: typeof content?.is_playable === "boolean" ? content.is_playable : null,
  };
}

async function main() {
  const email = arg("email");
  const allowRefresh = process.argv.includes("--allow-token-refresh");
  const report: Record<string, unknown> = {
    issue: 482, gate: "AUDIOBOOK-01/1C_EXISTING_READ_ONLY",
    outcome: "NOT_STARTED", playlistName: GATE1C.playlistName,
    spotifyGetAttempts: 0, spotifyWrites: 0, oauthRefreshAllowed: allowRefresh,
    targetChapterUri: GATE1C.chapterUri, inspected: null,
  };
  let operation = "local-preflight";
  let attempts = 0;
  async function read<T>(path: string, token: string): Promise<T> {
    if (++attempts > 5) throw new Error("GET_BUDGET_EXHAUSTED");
    report.spotifyGetAttempts = attempts;
    operation = path.split("?")[0] ?? path;
    await assertSpotifyBackoffInactive();
    return spotifyRequestAttempt<T>({ accessToken: token, path, method: "GET", operation: "spotify-api" });
  }

  try {
    if (!email) { report.outcome = "EMAIL_REQUIRED"; return; }
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        accounts: { where: { provider: "spotify" }, take: 1,
          select: { access_token: true, expires_at: true, scope: true } },
      },
    });
    const account = user?.accounts[0];
    if (!user || !account) { report.outcome = "SPOTIFY_ACCOUNT_NOT_CONNECTED"; return; }
    const scope = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scope.has("playlist-read-private")) {
      report.outcome = "PLAYLIST_READ_PRIVATE_SCOPE_MISSING";
      return;
    }
    const expiresSoon = !account.expires_at ||
      account.expires_at <= Math.floor(Date.now() / 1000) + 60;
    if (expiresSoon && !allowRefresh) {
      report.outcome = "TOKEN_EXPIRED_REFRESH_NOT_AUTHORIZED";
      return;
    }
    const candidate = expiresSoon ? await getSpotifyAccessToken(user.id) : account.access_token;
    if (!candidate) { report.outcome = "NO_ACCESS_TOKEN"; return; }
    const token: string = candidate;

    const profile = await read<unknown>("/me", token);
    const userId = profileId(profile);
    if (!userId) { report.outcome = "SPOTIFY_PROFILE_UNVERIFIED"; return; }

    const list = asObject(await read<unknown>("/me/playlists?limit=50&offset=0", token));
    const playlists = Array.isArray(list?.items) ? list.items : [];
    const matches = playlists.map(asObject).filter((p) =>
      p?.name === GATE1C.playlistName && profileId(p?.owner) === userId);
    if (matches.length !== 1) {
      report.outcome = matches.length > 1
        ? "AMBIGUOUS_IDENTICAL_PLAYLIST_NAMES"
        : "PLAYLIST_NOT_FOUND_IN_FIRST_PAGE";
      report.matchCount = matches.length;
      report.firstPageSize = playlists.length;
      report.hasNextPage = Boolean(list?.next);
      return;
    }
    const playlistId = safeId(matches[0]?.id);
    if (!playlistId) { report.outcome = "INVALID_PLAYLIST_ID"; return; }
    const details = asObject(await read<unknown>(
      `/playlists/${playlistId}?fields=id,name,public,collaborative,owner(id),snapshot_id,items(total)`, token));
    const ownerMatches = profileId(details?.owner) === userId;
    if (details?.id !== playlistId || details?.name !== GATE1C.playlistName || !ownerMatches) {
      report.outcome = "PLAYLIST_OWNER_OR_ID_CHANGED";
      return;
    }
    const page = asObject(await read<unknown>(
      `/playlists/${playlistId}/items?limit=10&offset=0&additional_types=episode`, token));
    const items = Array.isArray(page?.items) ? page.items : [];
    const summaries = items.map(itemSummary);
    report.inspected = {
      playlistId,
      playlistUrl: `https://open.spotify.com/playlist/${playlistId}`,
      public: details?.public ?? null, collaborative: details?.collaborative ?? null,
      ownerMatches: true,
      totalItems: typeof page?.total === "number" ? page.total : null,
      returnedItems: items.length,
      hasNextPage: Boolean(page?.next),
      targetChapterFound: summaries.some(s => s.matchesTargetChapter === true),
      targetAudiobookFound: summaries.some(s => s.matchesTargetAudiobook === true),
      items: summaries,
    };
    report.outcome = "EXISTING_TEST_PLAYLIST_INSPECTED_READ_ONLY";
  } catch (err) {
    report.outcome = "GET_FAILED_OR_ABORTED";
    report.failure = err instanceof SpotifyApiError
      ? { status: err.status, kind: err.kind, operation }
      : { operation, kind: "LOCAL_OR_NETWORK_ERROR" };
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => {
  console.error("Gate 1C read-only inspector setup failed; secrets suppressed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
