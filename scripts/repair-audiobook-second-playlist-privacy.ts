/**
 * AUDIOBOOK-01 Gate 1C — One-shot repair of the visibility of the API-created
 * SECOND experimental empty playlist. Never add chapters in this step.
 * Max 3 GET, 1 PUT; no retries of writes, no changes to existing/manual
 * playlists, no OAuth refresh.
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { SpotifyApiError } from "@/services/spotify/errors";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import {
  GATE1C, asObject, profileId, mayChangeSecondPlaylistToPrivate,
} from "@/services/spotify/audiobook-playlist-gate1c";

const TARGET_ID = "1tsFauBmlMXWJLNKTCQFQE";
const CONFIRM = "AUDIOBOOK-01-CONVERTER-PRIVADA";
function value(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((s) => s.startsWith(prefix))?.slice(prefix.length).trim() || null;
}
async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    gate: "AUDIOBOOK-01/1C_PRIVACY_CORRECTION",
    outcome: "NOT_RUN",
    targetPlaylistId: TARGET_ID,
    targetPlaylistName: GATE1C.secondPrivatePlaylistName,
    playlistUrl: `https://open.spotify.com/playlist/${TARGET_ID}`,
    GET: 0,
    PUT: 0,
    spotifyItemWrites: 0,
    oauthRefresh: false,
    otherPlaylistsAltered: false,
  };
  let method = "PREFLIGHT";
  let reads = 0;
  async function get<T>(path: string, token: string): Promise<T> {
    if (reads >= 3) throw Error("READ_LIMIT_EXCEEDED");
    await assertSpotifyBackoffInactive();
    reads++;
    report.GET = reads;
    method = `GET ${path.split("?")[0] ?? path}`;
    return spotifyRequestAttempt<T>({
      accessToken: token, method: "GET", path, operation: "spotify-api",
    });
  }
  try {
    if (!value("email") || value("confirm") !== CONFIRM) {
      report.outcome = "EXPLICIT_CONFIRMATION_REQUIRED";
      return;
    }
    const user = await prisma.user.findUnique({
      where: { email: value("email") ?? "" },
      select: {
        id: true,
        accounts: { where: { provider: "spotify" }, take: 1,
          select: { access_token: true, expires_at: true, scope: true } },
      },
    });
    const account = user?.accounts[0];
    if (!account) { report.outcome = "NO_SPOTIFY_ACCOUNT"; return; }
    const scopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("playlist-modify-private") || !scopes.has("playlist-read-private")) {
      report.outcome = "REQUIRED_SCOPES_MISSING";
      return;
    }
    if (!account.expires_at || account.expires_at <= Math.floor(Date.now() / 1000) + 60) {
      report.outcome = "TOKEN_EXPIRED_NO_REFRESH";
      return;
    }
    const token = account.access_token;
    if (!token) { report.outcome = "NO_VALID_TOKEN"; return; }

    const me = asObject(await get<unknown>("/me", token));
    const ownerId = profileId(me);
    if (!ownerId) { report.outcome = "UNVERIFIED_ACCOUNT"; return; }
    const detailsPath =
      `/playlists/${TARGET_ID}?fields=id,name,public,collaborative,owner(id),items(total)`;
    const before = asObject(await get<unknown>(detailsPath, token));
    report.before = {
      exactOwner: profileId(before?.owner) === ownerId,
      exactName: before?.name === GATE1C.secondPrivatePlaylistName,
      exactId: before?.id === TARGET_ID,
      publicState: before?.public === true ? "true" :
        before?.public === false ? "false" :
        before?.public === null ? "null" : "unknown",
      totalItems: typeof asObject(before?.items)?.total === "number"
        ? asObject(before?.items)?.total : null,
    };
    if (before?.public === false &&
        before.id === TARGET_ID &&
        before.name === GATE1C.secondPrivatePlaylistName &&
        profileId(before.owner) === ownerId) {
      report.outcome = "ALREADY_NONPUBLIC_NO_WRITE";
      return;
    }
    if (!mayChangeSecondPlaylistToPrivate(before, TARGET_ID, ownerId)) {
      report.outcome = "VISIBILITY_REPAIR_PRECONDITIONS_FAILED";
      return;
    }
    // One explicit PUT only. Timeout outcome is unknown; never auto-retry.
    method = `PUT /playlists/${TARGET_ID}`;
    await assertSpotifyBackoffInactive();
    report.PUT = 1;
    await spotifyRequestAttempt<unknown>({
      accessToken: token, path: `/playlists/${TARGET_ID}`,
      method: "PUT", operation: "playlist-write",
      init: { method: "PUT", body: JSON.stringify({ public: false }) },
    });
    report.outcome = "PUT_ACCEPTED_CONFIRMATION_PENDING";
    const after = asObject(await get<unknown>(detailsPath, token));
    report.after = {
      exactId: after?.id === TARGET_ID,
      exactOwner: profileId(after?.owner) === ownerId,
      exactName: after?.name === GATE1C.secondPrivatePlaylistName,
      publicState: after?.public === true ? "true" :
        after?.public === false ? "false" :
        after?.public === null ? "null" : "unknown",
      totalItems: typeof asObject(after?.items)?.total === "number"
        ? asObject(after?.items)?.total : null,
    };
    report.outcome = after?.public === false &&
      after.id === TARGET_ID && after.name === GATE1C.secondPrivatePlaylistName &&
      profileId(after.owner) === ownerId &&
      asObject(after.items)?.total === 0
      ? "PRIVATE_CONFIRMED_CHAPTER_NOT_YET_INSERTED"
      : "PUT_ACCEPTED_BUT_PRIVATE_NOT_CONFIRMED_STOP";
  } catch (error) {
    report.failure = error instanceof SpotifyApiError
      ? { operation: method, httpStatus: error.status, kind: error.kind }
      : { operation: method, kind: "LOCAL_OR_NETWORK_ERROR" };
    report.outcome = Number(report.PUT) > 0
      ? "PUT_OUTCOME_UNKNOWN_OR_FAILED_DO_NOT_RETRY"
      : "ABORTED_BEFORE_WRITE";
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => {
  console.error("Gate 1C privacy diagnostic startup failed; details suppressed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
