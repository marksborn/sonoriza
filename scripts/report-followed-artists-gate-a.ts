/**
 * DISCOVERY-FOLLOWED-01 (#564) Gate A — read-only inventory of followed artists.
 *
 *   npx tsx --env-file=.env scripts/report-followed-artists-gate-a.ts --email you@example.com [--sample 10] [--albums-per-artist 3]
 *
 * Only Spotify GET requests (followed artists, artist albums, album tracks).
 * No playlist/library/follow writes and no Sonoriza data writes besides the
 * usual access-token refresh. Prints aggregates only, never tokens.
 *
 * Measures: how many followed artists are reachable and at what cost; for a
 * deterministic sample, catalog size, how many tracks are not liked, how many
 * have known plays, and the projected cost of reading the whole catalog.
 * Policy: the follow list only bounds a candidate catalog (PERSONAL §8.1); the
 * output must not be used as taste evidence.
 */
import { prisma } from "@/lib/prisma";
import { spotifyFollowedArtistsCandidateCapability } from "@/services/data-policy/legacy-consumer-policy";
import { SpotifyClient } from "@/services/spotify/client";
import { SpotifyApiError } from "@/services/spotify/errors";

const FOLLOW_SCOPE = "user-follow-read";
const ALBUM_PAGE_SIZE = 10;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capability = spotifyFollowedArtistsCandidateCapability();
  if (!capability.allowed) throw new Error("Policy capability for followed artists is not allowed.");

  const user = await prisma.user.findUnique({ where: { email: args.email }, select: { id: true } });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);
  const account = await prisma.account.findFirst({
    where: { userId: user.id, provider: "spotify" },
    select: { scope: true },
  });
  const scopes = new Set((account?.scope ?? "").split(/\s+/).filter(Boolean));
  if (!scopes.has(FOLLOW_SCOPE)) {
    console.log(`Spotify grant lacks ${FOLLOW_SCOPE}. Reconnect Spotify in Configuração → Fontes and run again.`);
    return;
  }

  const client = await SpotifyClient.forUser(user.id);
  const followed = await client.listFollowedArtists();

  const [liked, heardStates, lastFmArtists, lastFmTracks] = await Promise.all([
    prisma.likedTrackPreference.findMany({
      where: { userId: user.id, isLiked: true },
      select: { spotifyTrackId: true, primaryArtistId: true },
    }),
    prisma.trackListeningState.findMany({ where: { userId: user.id }, select: { spotifyTrackId: true } }),
    prisma.trackListeningEvent.groupBy({
      by: ["artistName"],
      where: { userId: user.id, source: "LASTFM_SCROBBLE" },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["artistName", "trackName"],
      where: { userId: user.id, source: "LASTFM_SCROBBLE" },
    }),
  ]);
  const likedTrackIds = new Set(liked.map((row) => row.spotifyTrackId));
  const likedArtistIds = new Set(liked.flatMap((row) => (row.primaryArtistId ? [row.primaryArtistId] : [])));
  const heardTrackIds = new Set(heardStates.map((row) => row.spotifyTrackId));
  const lastFmArtistNames = new Set(lastFmArtists.map((row) => normalize(row.artistName)));
  const lastFmTrackKeys = new Set(lastFmTracks.map((row) => `${normalize(row.artistName)}|${normalize(row.trackName)}`));

  const artists = followed.artists;
  const withLikedTracks = artists.filter((artist) => likedArtistIds.has(artist.id)).length;
  const withLastFm = artists.filter((artist) => lastFmArtistNames.has(normalize(artist.name))).length;

  // Deterministic sample: spread across the list, independent of order changes.
  const sample = [...artists].sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.sample);
  let albumTotal = 0;
  let albumTotalsKnown = 0;
  let tracksRead = 0;
  let tracksLiked = 0;
  let tracksHeardSpotifyState = 0;
  let tracksLastFm = 0;
  let tracksUnknownPlay = 0;
  let projectedCallsForSample = 0;
  let sampleFailures = 0;

  for (const artist of sample) {
    try {
      const first = await client.getArtistAlbumsPage(artist.id, 0);
      const total = first.total ?? first.items.length;
      if (first.total !== null) albumTotalsKnown += 1;
      albumTotal += total;
      projectedCallsForSample += Math.max(1, Math.ceil(total / ALBUM_PAGE_SIZE)) + total;
      for (const album of first.items.slice(0, args.albumsPerArtist)) {
        if (!album.id) continue;
        const tracks = await client.getReleaseTracks(album.id);
        for (const track of tracks) {
          if (!track.id) continue;
          tracksRead += 1;
          const isLiked = likedTrackIds.has(track.id);
          const heardState = heardTrackIds.has(track.id);
          const heardLastFm = lastFmTrackKeys.has(`${normalize(artist.name)}|${normalize(track.name ?? "")}`);
          if (isLiked) tracksLiked += 1;
          if (heardState) tracksHeardSpotifyState += 1;
          if (heardLastFm) tracksLastFm += 1;
          if (!isLiked && !heardState && !heardLastFm) tracksUnknownPlay += 1;
        }
      }
    } catch (error) {
      sampleFailures += 1;
      console.log(`sample read failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
      if (error instanceof SpotifyApiError && (error.kind === "QUOTA_EXCEEDED" || error.kind === "RATE_LIMITED")) break;
    }
  }

  const sampled = sample.length - sampleFailures;
  const callsPerArtist = sampled > 0 ? projectedCallsForSample / sampled : null;
  const report = {
    policy: { capability: "spotifyFollowedArtistsCandidateCapability", allowed: capability.allowed },
    followed: {
      reachable: artists.length,
      totalReportedBySpotify: followed.total,
      pagesRead: followed.pagesRead,
      withLikedTracks,
      withLastFmScrobbles: withLastFm,
      withoutLikedOrLastFm: artists.filter(
        (artist) => !likedArtistIds.has(artist.id) && !lastFmArtistNames.has(normalize(artist.name)),
      ).length,
    },
    sample: {
      artists: sample.length,
      failures: sampleFailures,
      albumsAndSinglesTotal: albumTotal,
      albumTotalsKnown,
      avgAlbumsPerArtist: sampled > 0 ? round(albumTotal / sampled) : null,
      tracksRead,
      tracksLiked,
      tracksNotLiked: tracksRead - tracksLiked,
      tracksWithSpotifyListeningState: tracksHeardSpotifyState,
      tracksMatchedInLastFmByName: tracksLastFm,
      tracksNotLikedWithoutKnownPlay: tracksUnknownPlay,
      note: "Last.fm match is by normalized artist+title only (no #374 identity); 'without known play' is not proof of never heard.",
    },
    cost: {
      projectedCallsPerArtistFullCatalog: callsPerArtist === null ? null : round(callsPerArtist),
      projectedCallsAllFollowedFullCatalog:
        callsPerArtist === null ? null : Math.round(callsPerArtist * artists.length),
      daysAt20ArtistsPerDay: Math.ceil(artists.length / 20),
      callsThisRun: client.getRequestMetrics().callsByOperation,
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const email = value("--email");
  if (!email) throw new Error("Usage: --email you@example.com [--sample 10] [--albums-per-artist 3]");
  const sample = Number(value("--sample") ?? 10);
  const albumsPerArtist = Number(value("--albums-per-artist") ?? 3);
  if (!Number.isInteger(sample) || sample < 0 || sample > 50) throw new Error("--sample must be 0..50");
  if (!Number.isInteger(albumsPerArtist) || albumsPerArtist < 0 || albumsPerArtist > 10) {
    throw new Error("--albums-per-artist must be 0..10");
  }
  return { email, sample, albumsPerArtist };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
