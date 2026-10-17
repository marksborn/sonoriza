/**
 * AUDIOBOOK-01 Gate 1C: inspect existing second playlist after failed
 * post-creation strict-private assertion. READ-ONLY, NO POST/PUT/DELETE.
 * GET budget=3, token refresh disabled. Do not print auth credentials.
 */
import { prisma } from "@/lib/prisma";
import { assertSpotifyBackoffInactive } from "@/services/spotify/backoff";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { SpotifyApiError } from "@/services/spotify/errors";
import { GATE1C, asObject, profileId, safeId } from "@/services/spotify/audiobook-playlist-gate1c";

const TARGET_ID = "1tsFauBmlMXWJLNKTCQFQE";
const MAX_GET = 3;

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((v) => v.startsWith(prefix))?.slice(prefix.length).trim() || null;
}
function state(v: unknown): string {
  return v === true ? "true" : v === false ? "false" : v === null ? "null" : "missing_or_other";
}
async function main() {
  const report: Record<string, unknown> = {
    gate: "AUDIOBOOK-01/1C_CREATED_PLAYLIST_DIAGNOSTIC",
    outcome: "NOT_STARTED",
    playlistId: TARGET_ID,
    playlistUrl: `https://open.spotify.com/playlist/${TARGET_ID}`,
    expectedPlaylistName: GATE1C.secondPrivatePlaylistName,
    requests: 0,
    writes: 0,
    oauthRefresh: false,
  };
  const email = argument("email");
  let lastRead = "LOCAL";
  let requests = 0;
  async function get<T>(path: string, token: string): Promise<T> {
    if (requests >= MAX_GET) throw new Error("GET_BUDGET_EXHAUSTED");
    await assertSpotifyBackoffInactive();
    requests += 1;
    report.requests = requests;
    lastRead = path.split("?")[0] ?? path;
    return spotifyRequestAttempt<T>({ accessToken: token, path, method: "GET", operation: "spotify-api" });
  }
  try {
    if (!email || !/^[A-Za-z0-9]{22}$/.test(TARGET_ID)) {
      report.outcome = "INVALID_ARGUMENTS";
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
    if (!account) { report.outcome = "SPOTIFY_ACCOUNT_NOT_CONNECTED"; return; }
    const scopes = new Set((account.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("playlist-read-private")) {
      report.outcome = "PLAYLIST_READ_PRIVATE_SCOPE_MISSING";
      return;
    }
    const expires = account.expires_at;
    if (!expires || expires <= Math.floor(Date.now() / 1000) + 60) {
      report.outcome = "TOKEN_EXPIRED_NO_REFRESH";
      return;
    }
    const token = account.access_token;
    if (!token) { report.outcome = "NO_TOKEN"; return; }

    const me = asObject(await get<unknown>("/me", token));
    const ownerId = profileId(me);
    if (!ownerId) { report.outcome = "PROFILE_NOT_READABLE"; return; }

    const data = asObject(await get<unknown>(
      `/playlists/${TARGET_ID}?fields=id,name,public,collaborative,owner(id),snapshot_id,items(total)`, token));
    if (!data) { report.outcome = "PLAYLIST_NOT_OBJECT"; return; }
    const actualId = safeId(data.id);
    const observedOwnerId = profileId(data.owner);
    const ownerMatches = observedOwnerId === ownerId;
    const nameMatches = data.name === GATE1C.secondPrivatePlaylistName;
    const idMatches = actualId === TARGET_ID;
    report.playlist = {
      idMatches, ownerMatches, nameMatches,
      publicState: state(data.public),
      collaborativeState: state(data.collaborative),
      // Distinguish response missing field from public=null.
      returnedKeys: ["id","name","public","collaborative","owner","snapshot_id","items"].filter(
        (k) => Object.prototype.hasOwnProperty.call(data, k)),
      snapshotPresent: typeof data.snapshot_id === "string",
      detailsTotal: typeof asObject(data.items)?.total === "number" ? asObject(data.items)?.total : null,
    };
    if (!ownerMatches || !idMatches || !nameMatches) {
      report.outcome = "IDENTITY_NOT_VERIFIED_STOP";
      return;
    }
    const page = asObject(await get<unknown>(
      `/playlists/${TARGET_ID}/items?limit=10&offset=0&additional_types=episode`, token));
    const items = Array.isArray(page?.items) ? page.items : [];
    report.items = {
      total: typeof page?.total === "number" ? page.total : null,
      returned: items.length,
      hasNextPage: Boolean(page?.next),
      // Only show content shape, never personal added_by details.
      itemKinds: items.map((v) => {
        const row = asObject(v);
        const item = asObject(row?.item) ?? asObject(row?.track);
        return {
          type: typeof item?.type === "string" ? item.type : null,
          uriMatchesAuthorizedChapter: item?.uri === GATE1C.chapterUri,
          hasUri: typeof item?.uri === "string",
        };
      }),
    };
    report.outcome = "DIAGNOSTIC_READ_COMPLETE";
  } catch (e) {
    report.outcome = "DIAGNOSTIC_FAILED_NO_WRITES";
    report.failure = e instanceof SpotifyApiError
      ? { operation: lastRead, status: e.status, kind: e.kind }
      : { operation: lastRead, kind: "LOCAL_OR_NETWORK" };
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => {
  console.error("Gate 1C diagnostic initialization failed; no credentials printed.");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
