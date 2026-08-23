import { prisma } from "@/lib/prisma";
import {
  ALBUM_DISCOVERY_GATE1_POLICY,
  buildAlbumCoverageFacts,
  selectDiagnosticAlbumSample,
  type AlbumHistoryEvent,
} from "@/services/album-discovery/profile";
import {
  SpotifyAlbumCatalogClient,
  type SpotifyAlbumCatalogSummary,
} from "@/services/spotify/album-catalog";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";
import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
} from "@/services/music-discovery/profile";
import { buildDiscoveryGate22ScoringReport } from "@/services/music-discovery/scoring-gate2-2";
import { resolveExternalDiscoveryCandidate } from "@/services/music-discovery/spotify-resolution";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";

const PROFILE_POOL_SIZE = 100;

const args = parseArgs(process.argv.slice(2));

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const [profile, trackIdentities] = await Promise.all([
    getMusicDiscoveryProfile(user.id, {
      asOf: args.asOf,
      topN: PROFILE_POOL_SIZE,
    }),
    getDiscoveryTrackIdentityEvidence(user.id),
  ]);
  const artists = uniqueArtists([
    ...profile.topArtistsHistorical,
    ...profile.topArtists30d,
    ...profile.topArtists90d,
    ...profile.topArtists365d,
    ...profile.recentMomentum,
    ...profile.dormantFavorites,
    ...profile.rediscoveryReturns,
  ]);
  const tracks = uniqueTracks([
    ...profile.topTracksHistorical,
    ...profile.familiarCandidates,
    ...profile.rediscoveryCandidates,
  ]);
  const scoring = buildDiscoveryGate22ScoringReport({
    generatedAt: profile.generatedAt,
    dormantDays: profile.heuristics.dormantDays,
    rediscoveryGapDays: profile.heuristics.rediscoveryGapDays,
    topN: PROFILE_POOL_SIZE,
    artists,
    tracks,
    trackIdentities,
    candidateUniverse: "DIAGNOSTIC_PARTIAL",
  });

  const search = await SpotifyCatalogSearchClient.forUser(user.id);
  const albumCatalog = await SpotifyAlbumCatalogClient.forUser(user.id);
  const selectedArtists = scoring.deepeningCandidates.slice(0, args.artists);
  const artistReports: Array<Record<string, unknown>> = [];
  const failures: Array<{ subject: string; error: string }> = [];

  for (const candidate of selectedArtists) {
    const resolution = await resolveExternalDiscoveryCandidate(search, {
      candidateKey: `album-artist:${normalized(candidate.artistName)}`,
      candidateType: "ARTIST",
      artistName: candidate.artistName,
      trackName: null,
    });

    if (resolution.status !== "RESOLVED" || !resolution.spotifyArtist) {
      artistReports.push({
        artistName: candidate.artistName,
        deepeningScore: candidate.score,
        deepeningReasons: candidate.reasons.map((reason) => reason.code),
        resolutionStatus: resolution.status,
        resolutionReason: resolution.reason,
        spotifyArtist: null,
        catalogAlbumCount: 0,
        analyzedAlbumCount: 0,
        albums: [],
      });
      continue;
    }

    const spotifyArtist = resolution.spotifyArtist;
    let catalogAlbums: SpotifyAlbumCatalogSummary[];
    try {
      catalogAlbums = await albumCatalog.listArtistAlbums(spotifyArtist.id);
    } catch (error) {
      failures.push({
        subject: `${candidate.artistName}:catalog`,
        error: errorMessage(error),
      });
      artistReports.push({
        artistName: candidate.artistName,
        deepeningScore: candidate.score,
        deepeningReasons: candidate.reasons.map((reason) => reason.code),
        resolutionStatus: resolution.status,
        resolutionReason: resolution.reason,
        spotifyArtist,
        catalogAlbumCount: null,
        analyzedAlbumCount: 0,
        albums: [],
        failure: errorMessage(error),
      });
      continue;
    }

    const events = await loadArtistHistoryEvents({
      userId: user.id,
      spotifyArtistId: spotifyArtist.id,
      requestedArtistName: candidate.artistName,
      resolvedArtistName: spotifyArtist.name,
      asOf: args.asOf,
    });
    const sampledAlbums = selectDiagnosticAlbumSample({
      albums: catalogAlbums,
      events,
      maxAlbums: args.albumsPerArtist,
    });
    const albumReports = [];

    for (const album of sampledAlbums) {
      try {
        const albumTracks = await albumCatalog.getAlbumTracks(album.id);
        albumReports.push(
          buildAlbumCoverageFacts({
            album,
            tracks: albumTracks,
            events,
            spotifyArtistId: spotifyArtist.id,
            spotifyArtistName: spotifyArtist.name,
            asOf: args.asOf,
          }),
        );
      } catch (error) {
        failures.push({
          subject: `${candidate.artistName}:${album.name}:${album.id}`,
          error: errorMessage(error),
        });
      }
    }

    albumReports.sort((a, b) => {
      const aCoverage = a.analyticCoverage ?? Number.POSITIVE_INFINITY;
      const bCoverage = b.analyticCoverage ?? Number.POSITIVE_INFINITY;
      return (
        aCoverage - bCoverage ||
        String(b.releaseDate ?? "").localeCompare(String(a.releaseDate ?? "")) ||
        a.albumName.localeCompare(b.albumName)
      );
    });

    artistReports.push({
      artistName: candidate.artistName,
      deepeningScore: candidate.score,
      deepeningReasons: candidate.reasons.map((reason) => reason.code),
      resolutionStatus: resolution.status,
      resolutionReason: resolution.reason,
      spotifyArtist,
      historyEventCount: events.length,
      catalogAlbumCount: catalogAlbums.length,
      analyzedAlbumCount: albumReports.length,
      diagnosticAlbumSampleLimit: args.albumsPerArtist,
      albums: albumReports,
    });
  }

  const payload = {
    gate: "ALBUM-01 Gate 1",
    mode: "READ_ONLY",
    generatedAt: new Date(),
    asOf: args.asOf,
    user: user.email ?? user.id,
    policy: ALBUM_DISCOVERY_GATE1_POLICY,
    discoveryProfile: {
      scoringVersion: scoring.version,
      candidateUniverse: scoring.selectionPolicy.candidateUniverse,
      note:
        "Gate 1 consumes DISCOVERY-01 deepening/artist scores. It does not create a second artist-affinity formula.",
    },
    scope: {
      requestedArtistCount: args.artists,
      selectedArtistCount: selectedArtists.length,
      maxAlbumsPerArtist: args.albumsPerArtist,
      catalogScope: "FULL_ALBUMS_ONLY",
      editionIdentity: "SPOTIFY_ALBUM_ID",
      diagnosticOnly: true,
    },
    providerMetrics: {
      search: search.getMetrics(),
      albumCatalog: albumCatalog.getMetrics(),
      failures,
    },
    artists: artistReports,
    safety: {
      spotifyWrites: 0,
      databaseWrites: 0,
      music01Changed: false,
      tiaoBrainRequired: false,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== ALBUM-01 — GATE 1 PROFILE READ-ONLY ==========");
  console.log(`User:                    ${payload.user}`);
  console.log(`As of:                   ${args.asOf.toISOString()}`);
  console.log(`Artists analyzed:        ${selectedArtists.length}/${args.artists}`);
  console.log(`Albums/artist max:       ${args.albumsPerArtist}`);
  console.log(`DISCOVERY scoring:       ${scoring.version}`);
  console.log(`Provider failures:       ${failures.length}`);
  console.log("Mode:                    READ_ONLY — zero Spotify/database writes");

  for (const artist of artistReports) {
    console.log("\n------------------------------------------------------------");
    console.log(`Artist:                   ${String(artist.artistName)}`);
    console.log(`Deepening score:          ${String(artist.deepeningScore)}`);
    console.log(
      `Reasons:                  ${(artist.deepeningReasons as string[]).join(", ") || "(none)"}`,
    );
    console.log(
      `Spotify resolution:       ${String(artist.resolutionStatus)} / ${String(artist.resolutionReason)}`,
    );
    if (!artist.spotifyArtist) continue;
    console.log(`Catalog albums:           ${String(artist.catalogAlbumCount)}`);
    console.log(`Analyzed albums:          ${String(artist.analyzedAlbumCount)}`);

    const albums = artist.albums as Array<{
      spotifyAlbumId: string;
      albumName: string;
      releaseDate: string | null;
      eligibleTrackCount: number;
      canonicalObservedTrackCount: number;
      labelOnlyObservedTrackCount: number;
      canonicalCoverage: number | null;
      analyticCoverage: number | null;
      confidence: string;
      matchedEventCount: number;
      explicitSkipEventCount: number;
      plays30d: number;
    }>;
    for (const [index, album] of albums.entries()) {
      console.log(
        `  ${String(index + 1).padStart(2)}. ${album.albumName} (${album.releaseDate ?? "?"})` +
          ` — coverage=${formatRate(album.analyticCoverage)}` +
          ` canonical=${album.canonicalObservedTrackCount}/${album.eligibleTrackCount}` +
          ` labelOnly=${album.labelOnlyObservedTrackCount}` +
          ` confidence=${album.confidence}` +
          ` events=${album.matchedEventCount}` +
          ` recent30d=${album.plays30d}` +
          ` explicitSkips=${album.explicitSkipEventCount}` +
          ` id=${album.spotifyAlbumId}`,
      );
    }
  }

  if (failures.length > 0) {
    console.log("\nProvider failures (isolated; no writes occurred):");
    for (const failure of failures) {
      console.log(`  ${failure.subject}: ${failure.error}`);
    }
  }
}

async function loadArtistHistoryEvents(input: {
  userId: string;
  spotifyArtistId: string;
  requestedArtistName: string;
  resolvedArtistName: string;
  asOf: Date;
}): Promise<AlbumHistoryEvent[]> {
  const artistNames = [...new Set([input.requestedArtistName, input.resolvedArtistName])];
  return prisma.trackListeningEvent.findMany({
    where: {
      userId: input.userId,
      playedAt: { lte: input.asOf },
      OR: [
        { primaryArtistId: input.spotifyArtistId },
        ...artistNames.map((artistName) => ({
          primaryArtistId: null,
          artistName: { equals: artistName, mode: "insensitive" as const },
        })),
      ],
    },
    select: {
      spotifyTrackId: true,
      trackName: true,
      artistName: true,
      primaryArtistId: true,
      albumName: true,
      albumId: true,
      playedAt: true,
      source: true,
      metadata: true,
    },
    orderBy: { playedAt: "asc" },
  });
}

type Args = {
  email: string;
  artists: number;
  albumsPerArtist: number;
  asOf: Date;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  let email = "";
  let artists = 5;
  let albumsPerArtist = 12;
  let asOf = new Date();
  let json = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim().toLowerCase();
      continue;
    }
    if (arg.startsWith("--artists=")) {
      artists = integerArg(arg, "--artists=", 1, 20);
      continue;
    }
    if (arg.startsWith("--albums-per-artist=")) {
      albumsPerArtist = integerArg(arg, "--albums-per-artist=", 1, 30);
      continue;
    }
    if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid --as-of date");
      asOf = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) {
    throw new Error(
      "Usage: npm run album:profile -- --email=<user> [--artists=5] [--albums-per-artist=12] [--as-of=<ISO>] [--json]",
    );
  }
  return { email, artists, albumsPerArtist, asOf, json };
}

function integerArg(
  arg: string,
  prefix: string,
  min: number,
  max: number,
): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function uniqueArtists(rows: DiscoveryArtistProfile[]): DiscoveryArtistProfile[] {
  const byName = new Map<string, DiscoveryArtistProfile>();
  for (const row of rows) {
    const key = normalized(row.artistName);
    if (!byName.has(key)) byName.set(key, row);
  }
  return [...byName.values()];
}

function uniqueTracks(rows: DiscoveryTrackProfile[]): DiscoveryTrackProfile[] {
  const byId = new Map<string, DiscoveryTrackProfile>();
  for (const row of rows) byId.set(row.spotifyTrackId, row);
  return [...byId.values()];
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function formatRate(value: number | null): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
