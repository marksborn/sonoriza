import { spawnSync } from "node:child_process";

import { prisma } from "@/lib/prisma";
import {
  resolveExternalDiscoveryCandidates,
  type SpotifyDiscoveryResolution,
  type SpotifyDiscoveryResolutionCandidate,
} from "@/services/music-discovery/spotify-resolution";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";

type Args = {
  email: string;
  json: boolean;
  gate5dArgs: string[];
};

type Gate5DSelectedCandidate = SpotifyDiscoveryResolutionCandidate & {
  historyClass: string;
  acquisitionDepth: number;
  scoreCard: { score: number };
  arbitrationAdjustedScore: number;
  pathLabel: string;
};

type Gate5DPayload = {
  user: string;
  generatedAt: string;
  gate: string;
  mode: "READ_ONLY";
  sourceGate: {
    totalProviderCalls: number;
    totalProviderFailures: number;
    combinedCandidateCount: number;
    eligibleCount: number;
  };
  arbitration: {
    selectedCount: number;
    rejectedEligibleCount: number;
    selected: Gate5DSelectedCandidate[];
  };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gate5d = runGate5D(args.gate5dArgs);
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const spotify = await SpotifyCatalogSearchClient.forUser(user.id);
  const batch = await resolveExternalDiscoveryCandidates(spotify, gate5d.arbitration.selected);
  const metrics = spotify.getMetrics();
  const resolutionByKey = new Map(batch.resolutions.map((row) => [row.candidateKey, row] as const));
  const failureByKey = new Map(batch.failures.map((row) => [row.candidateKey, row] as const));
  const statusCounts = countStatuses(batch.resolutions);

  const rows = gate5d.arbitration.selected.map((candidate) => ({
    candidate,
    resolution: resolutionByKey.get(candidate.candidateKey) ?? null,
    failure: failureByKey.get(candidate.candidateKey) ?? null,
  }));

  const payload = {
    user: user.email ?? user.id,
    generatedAt: new Date(),
    gate: "DISCOVERY-01 Gate 5E",
    mode: "READ_ONLY" as const,
    policy: {
      trackIdentity: "EXACT_NORMALIZED_TRACK_AND_ARTIST",
      duplicateTrackIdentity: "SAME_ISRC_COLLAPSES__DIFFERENT_RECORDING_IS_AMBIGUOUS",
      artistIdentity: "EXACT_NORMALIZED_ARTIST_NAME__MULTIPLE_IDS_IS_AMBIGUOUS",
      newArtistRepresentativeTrack: "FIRST_SEARCH_RESULT_BOUND_TO_RESOLVED_ARTIST_ID",
      spotifyEndpoints: ["GET /search"],
    },
    sourceGate: {
      gate: gate5d.gate,
      generatedAt: gate5d.generatedAt,
      lastFmCalls: gate5d.sourceGate.totalProviderCalls,
      lastFmFailures: gate5d.sourceGate.totalProviderFailures,
      combinedCandidateCount: gate5d.sourceGate.combinedCandidateCount,
      eligibleBeforeArbitration: gate5d.sourceGate.eligibleCount,
      selectedAfterArbitration: gate5d.arbitration.selectedCount,
      rejectedByArbitration: gate5d.arbitration.rejectedEligibleCount,
    },
    spotify: {
      metrics,
      resolvedCount: statusCounts.RESOLVED,
      ambiguousCount: statusCounts.AMBIGUOUS,
      notFoundCount: statusCounts.NOT_FOUND,
      providerFailureCount: batch.failures.length,
    },
    rows,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 5E SPOTIFY RESOLUTION READ-ONLY ==========");
  console.log(`User:                         ${payload.user}`);
  console.log(`Gate 5D selected:             ${payload.sourceGate.selectedAfterArbitration}`);
  console.log(`Last.fm calls (source):       ${payload.sourceGate.lastFmCalls}`);
  console.log(`Last.fm failures:             ${payload.sourceGate.lastFmFailures}`);
  console.log(`Spotify catalog calls:        ${metrics.totalCalls}`);
  console.log(`Spotify request failures:     ${metrics.failures}`);
  console.log(`Spotify rate limits:          ${metrics.rateLimitedCount}`);
  console.log(`Spotify retries:              ${metrics.retries}`);
  console.log(`RESOLVED:                     ${payload.spotify.resolvedCount}`);
  console.log(`AMBIGUOUS:                    ${payload.spotify.ambiguousCount}`);
  console.log(`NOT_FOUND:                    ${payload.spotify.notFoundCount}`);
  console.log(`Provider failures by item:    ${payload.spotify.providerFailureCount}`);
  console.log("");
  console.log("Canonical Spotify resolution:");

  rows.forEach((row, index) => {
    const subject = row.candidate.trackName
      ? `${row.candidate.artistName} — ${row.candidate.trackName}`
      : row.candidate.artistName;
    const prefix = `  ${String(index + 1).padStart(2)}. ${subject}`;
    if (row.failure) {
      console.log(`${prefix} — PROVIDER_ERROR — ${row.failure.error}`);
      return;
    }
    if (!row.resolution) {
      console.log(`${prefix} — PROVIDER_ERROR — missing resolution result`);
      return;
    }
    console.log(`${prefix} — ${formatResolution(row.resolution)}`);
    console.log(
      `      source: class=${row.candidate.historyClass}, depth=${row.candidate.acquisitionDepth}, raw=${row.candidate.scoreCard.score}, adjusted=${row.candidate.arbitrationAdjustedScore}, path=${row.candidate.pathLabel}`,
    );
  });

  console.log("");
  console.log(
    "No writes: Spotify catalog GET only; no playlist, MUSIC-03, preference, score persistence or planner changes.",
  );
}

function runGate5D(args: string[]): Gate5DPayload {
  const command = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const result = spawnSync(
    command,
    ["scripts/report-music-discovery-external-arbitration.ts", ...args, "--json"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`Gate 5D source report failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as Gate5DPayload;
  } catch (error) {
    throw new Error(
      `Gate 5D source report did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatResolution(row: SpotifyDiscoveryResolution): string {
  if (row.status !== "RESOLVED") {
    return `${row.status} reason=${row.reason} alternatives=${row.alternatives.length}`;
  }
  const artist = row.spotifyArtist
    ? `artistId=${row.spotifyArtist.id} artist=${row.spotifyArtist.name}`
    : "artistId=missing";
  const track = row.spotifyTrack
    ? `trackId=${row.spotifyTrack.id} track=${row.spotifyTrack.name} isrc=${row.spotifyTrack.isrc ?? "n/a"}`
    : "trackId=missing";
  return `RESOLVED reason=${row.reason} ${artist} ${track}`;
}

function countStatuses(
  rows: SpotifyDiscoveryResolution[],
): Record<SpotifyDiscoveryResolution["status"], number> {
  const counts = { RESOLVED: 0, AMBIGUOUS: 0, NOT_FOUND: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let json = false;
  const gate5dArgs: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      gate5dArgs.push(arg);
    } else if (arg === "--json") {
      json = true;
    } else {
      gate5dArgs.push(arg);
    }
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, json, gate5dArgs };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
