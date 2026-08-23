import { prisma } from "@/lib/prisma";
import {
  buildHistoricalArtistIdentityEvidence,
  type HistoricalArtistIdentityEvidence,
} from "@/services/album-discovery/artist-identity";
import {
  ALBUM_OPPORTUNITY_POLICY,
  rankAlbumOpportunities,
  scoreAlbumOpportunity,
  type AlbumOpportunityCandidate,
} from "@/services/album-discovery/opportunity";
import { buildAlbumCoverageFacts, type AlbumHistoryEvent } from "@/services/album-discovery/profile";
import { SpotifyAlbumCatalogClient } from "@/services/spotify/album-catalog";
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
    getMusicDiscoveryProfile(user.id, { asOf: args.asOf, topN: PROFILE_POOL_SIZE }),
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
  const discovery = buildDiscoveryGate22ScoringReport({
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
  const selectedArtists = discovery.deepeningCandidates.slice(0, args.artists);
  const candidates: AlbumOpportunityCandidate[] = [];
  const artistReports: Array<Record<string, unknown>> = [];
  const failures: Array<{ subject: string; error: string }> = [];

  for (const artistCandidate of selectedArtists) {
    const identity = await loadHistoricalArtistIdentity({
      userId: user.id,
      artistName: artistCandidate.artistName,
      asOf: args.asOf,
    });
    const resolution = await resolveExternalDiscoveryCandidate(search, {
      candidateKey: `album-opportunity:${normalized(artistCandidate.artistName)}`,
      candidateType: "ARTIST",
      artistName: artistCandidate.artistName,
      trackName: null,
      preferredSpotifyArtistId: identity.primaryArtistId,
    });

    if (resolution.status !== "RESOLVED" || !resolution.spotifyArtist) {
      artistReports.push({
        artistName: artistCandidate.artistName,
        artistDeepeningScore: artistCandidate.score,
        historicalArtistIdentity: identity,
        resolutionStatus: resolution.status,
        resolutionReason: resolution.reason,
        catalogAlbumCount: 0,
        scoredAlbumCount: 0,
      });
      continue;
    }

    const spotifyArtist = resolution.spotifyArtist;
    try {
      const [catalogAlbums, events] = await Promise.all([
        albumCatalog.listArtistAlbums(spotifyArtist.id),
        loadArtistHistoryEvents({
          userId: user.id,
          spotifyArtistId: spotifyArtist.id,
          requestedArtistName: artistCandidate.artistName,
          resolvedArtistName: spotifyArtist.name,
          asOf: args.asOf,
        }),
      ]);
      let scoredAlbumCount = 0;
      for (const album of catalogAlbums) {
        try {
          const albumTracks = await albumCatalog.getAlbumTracks(album.id);
          const coverage = buildAlbumCoverageFacts({
            album,
            tracks: albumTracks,
            events,
            spotifyArtistId: spotifyArtist.id,
            spotifyArtistName: spotifyArtist.name,
            asOf: args.asOf,
          });
          const scored = scoreAlbumOpportunity({
            artistName: artistCandidate.artistName,
            artistDeepeningScore: artistCandidate.score,
            coverage,
          });
          candidates.push(scored);
          if (scored.eligible) scoredAlbumCount += 1;
        } catch (error) {
          failures.push({
            subject: `${artistCandidate.artistName}:${album.name}:${album.id}`,
            error: errorMessage(error),
          });
        }
      }
      artistReports.push({
        artistName: artistCandidate.artistName,
        artistDeepeningScore: artistCandidate.score,
        historicalArtistIdentity: identity,
        resolutionStatus: resolution.status,
        resolutionReason: resolution.reason,
        spotifyArtist,
        catalogAlbumCount: catalogAlbums.length,
        scoredAlbumCount,
      });
    } catch (error) {
      failures.push({
        subject: `${artistCandidate.artistName}:catalog`,
        error: errorMessage(error),
      });
    }
  }

  const ranked = rankAlbumOpportunities(candidates);
  const payload = {
    gate: "ALBUM-01 Gate 2",
    mode: "READ_ONLY",
    generatedAt: new Date(),
    asOf: args.asOf,
    user: user.email ?? user.id,
    policy: ALBUM_OPPORTUNITY_POLICY,
    discoveryProfile: {
      scoringVersion: discovery.version,
      note:
        "DISCOVERY-01 deepening score is reused as the artist component. ALBUM-01 adds only album-specific facts.",
    },
    scope: {
      requestedArtistCount: args.artists,
      selectedArtistCount: selectedArtists.length,
      catalogScope: "ALL_FULL_ALBUM_EDITIONS_FOR_RESOLVED_ARTISTS",
      editionIdentity: "SPOTIFY_ALBUM_ID",
      topOutput: args.top,
    },
    artistReports,
    candidateCount: ranked.length,
    ranked: ranked.slice(0, args.top),
    providerMetrics: {
      search: search.getMetrics(),
      albumCatalog: albumCatalog.getMetrics(),
      failures,
    },
    safety: {
      spotifyWrites: 0,
      databaseWrites: 0,
      queueWrites: 0,
      music01Changed: false,
      tiaoBrainRequired: false,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== ALBUM-01 — GATE 2 OPPORTUNITY READ-ONLY ==========");
  console.log(`User:                    ${payload.user}`);
  console.log(`As of:                   ${args.asOf.toISOString()}`);
  console.log(`Artists selected:        ${selectedArtists.length}/${args.artists}`);
  console.log(`Eligible albums scored: ${ranked.length}`);
  console.log(`Provider failures:       ${failures.length}`);
  console.log(`Policy:                  ${ALBUM_OPPORTUNITY_POLICY.version}`);
  console.log("Mode:                    READ_ONLY — zero Spotify/database/queue writes");

  console.log("\nArtist resolution:");
  for (const artist of artistReports) {
    const identity = artist.historicalArtistIdentity as HistoricalArtistIdentityEvidence;
    console.log(
      `  ${String(artist.artistName)} — deepening=${String(artist.artistDeepeningScore)}` +
        ` historyId=${identity.status}${identity.primaryArtistId ? `:${identity.primaryArtistId}` : ""}` +
        ` spotify=${String(artist.resolutionStatus)}/${String(artist.resolutionReason)}` +
        ` albums=${String(artist.scoredAlbumCount)}/${String(artist.catalogAlbumCount)}`,
    );
  }

  console.log(`\nTop ${Math.min(args.top, ranked.length)} album opportunities:`);
  for (const [index, row] of ranked.slice(0, args.top).entries()) {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${row.artistName} — ${row.albumName} (${row.releaseDate ?? "?"})` +
        ` — score=${row.score}` +
        ` coverage=${formatRate(row.coverage.analyticCoverage)}` +
        ` canonical=${row.coverage.canonicalObservedTrackCount}/${row.coverage.eligibleTrackCount}` +
        ` labelOnly=${row.coverage.labelOnlyObservedTrackCount}` +
        ` recent30d=${row.coverage.plays30d}` +
        ` skipAdj=${formatRate(row.components.adjustedExplicitSkipRate)}` +
        ` penalty=${row.components.negativePenalty}` +
        ` confidence=${row.coverage.confidence}` +
        ` reasons=${row.reasons.map((reason) => reason.code).join("|") || "(none)"}` +
        ` id=${row.spotifyAlbumId}`,
    );
  }

  if (failures.length > 0) {
    console.log("\nProvider failures (isolated; no writes occurred):");
    for (const failure of failures) console.log(`  ${failure.subject}: ${failure.error}`);
  }
}

async function loadHistoricalArtistIdentity(input: {
  userId: string;
  artistName: string;
  asOf: Date;
}): Promise<HistoricalArtistIdentityEvidence> {
  const rows = await prisma.trackListeningEvent.groupBy({
    by: ["primaryArtistId"],
    where: {
      userId: input.userId,
      playedAt: { lte: input.asOf },
      primaryArtistId: { not: null },
      artistName: { equals: input.artistName, mode: "insensitive" },
    },
    _count: { _all: true },
  });
  return buildHistoricalArtistIdentityEvidence(
    rows.map((row) => ({
      primaryArtistId: row.primaryArtistId,
      eventCount: row._count._all,
    })),
  );
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

type Args = { email: string; artists: number; top: number; asOf: Date; json: boolean };

function parseArgs(argv: string[]): Args {
  let email = "";
  let artists = 5;
  let top = 20;
  let asOf = new Date();
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--email=")) email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--artists=")) artists = integerArg(arg, "--artists=", 1, 20);
    else if (arg.startsWith("--top=")) top = integerArg(arg, "--top=", 1, 100);
    else if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid --as-of date");
      asOf = parsed;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!email) {
    throw new Error(
      "Usage: npm run album:opportunity -- --email=<user> [--artists=5] [--top=20] [--as-of=<ISO>] [--json]",
    );
  }
  return { email, artists, top, asOf, json };
}

function integerArg(arg: string, prefix: string, min: number, max: number): number {
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
