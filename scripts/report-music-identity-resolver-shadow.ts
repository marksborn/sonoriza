import { prisma } from "@/lib/prisma";
import { runMusicIdentityShadowResolverReport } from "@/services/music-identity/shadow-resolver-report";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  if (hasArg("write")) {
    throw new Error("Gate 3 is SHADOW_READ_ONLY; --write is not supported.");
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npm run music-identity:resolver-shadow -- --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityShadowResolverReport(userId);
  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(44)}${String(value)}`);

  console.log("========== MUSIC-IDENTITY-01 — GATE 3 SHADOW ==========");
  p("User:", report.userId);
  p("Mode:", report.mode);
  p("Provider calls:", report.authority.providerCalls);
  p("Writes:", report.authority.writes);
  p("Persisted snapshot:", report.authority.interpretation);
  console.log();

  console.log("Canonical/cache coverage:");
  p("  TrackProviderRef:", report.canonical.trackProviderRefs);
  p("  Spotify/global refs:", report.canonical.spotifyGlobalTrackProviderRefs);
  p("  Cache-enriched refs:", report.canonical.cacheEnrichedTrackProviderRefs);
  p("  Canonical outside cache:", report.canonical.canonicalOutsidePersistedCache);
  p("  Persisted cache tracks:", report.cache.distinctSpotifyTracks);
  console.log();

  console.log("Evidence groups:");
  p("  Exact alias groups:", report.evidence.exactAliasGroups);
  p("  Same ISRC groups:", report.evidence.sameIsrcGroups);
  p("  Same track MBID groups:", report.evidence.sameTrackMbidGroups);
  p("  Cross-artist title collisions:", report.evidence.crossArtistTitleCollisionGroups);
  p("  Album edition candidates:", report.evidence.albumEditionGroups);
  console.log();

  console.log("Shadow resolution:");
  p("  Candidate pairs:", report.resolution.pairCount);
  p("  Exact provider aliases:", report.resolution.exactProviderAliasPairs);
  p("  Same recording high confidence:", report.resolution.sameRecordingHighConfidencePairs);
  p("  Same song / different recording:", report.resolution.sameSongDifferentRecordingPairs);
  p("  Textual possible matches:", report.resolution.textualPossibleMatchPairs);
  p("  Ambiguous:", report.resolution.ambiguousPairs);
  p("  Live vs studio:", report.resolution.liveVsStudioPairs);
  p("  Remaster pairs:", report.resolution.remasterPairs);
  p("  Acoustic pairs:", report.resolution.acousticPairs);
  p("  Remix pairs:", report.resolution.remixPairs);
  p("  Demo pairs:", report.resolution.demoPairs);
  p("  Confidence high:", report.resolution.confidence.high);
  p("  Confidence medium:", report.resolution.confidence.medium);
  p("  Confidence low:", report.resolution.confidence.low);
  console.log();

  console.log("Sample candidate pairs:");
  if (report.resolution.pairs.length === 0) {
    console.log("  none");
  } else {
    report.resolution.pairs.forEach((pair, index) => {
      console.log(
        `  ${index + 1}. ${pair.left.primaryArtistName} — ${pair.left.trackName ?? "n/a"} [${pair.left.providerTrackId}] <> ${pair.right.trackName ?? "n/a"} [${pair.right.providerTrackId}]`,
      );
      console.log(
        `     ${pair.resolution.status}/${pair.resolution.reason} level=${pair.resolution.level} action=${pair.resolution.action} confidence=${pair.resolution.confidenceBasisPoints}`,
      );
      console.log(
        `     isrc=${pair.evidence.sameIsrc} mbid=${pair.evidence.sameTrackMbid} artist=${pair.evidence.samePrimaryArtistProviderId} baseTitle=${pair.evidence.sameBaseTitleSignal} versions=${pair.evidence.leftVersionTrait}/${pair.evidence.rightVersionTrait} durationDeltaMs=${pair.evidence.durationDeltaMs ?? "n/a"}`,
      );
    });
  }
  console.log();

  console.log(
    "Gate 3 is diagnostic only. MATCH in this report is a shadow resolver conclusion, not a persisted merge. No canonical association, planner decision, cache or provider is modified.",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
