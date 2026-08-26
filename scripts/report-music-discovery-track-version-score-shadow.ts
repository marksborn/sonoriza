import { prisma } from "@/lib/prisma";
import { buildTrackVersionScoreShadowReport } from "@/services/music-discovery/track-version-score-shadow";
import { getLikedDiscoveryExpansionShadowReport } from "@/services/music-preference/liked-discovery-expansion-shadow";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  const email = argValue("email");
  if (!email) {
    throw new Error(
      "Uso: npm run discovery:track-version-score-shadow -- --email=usuario@exemplo.com [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const expansion = await getLikedDiscoveryExpansionShadowReport(user.id);
  const report = buildTrackVersionScoreShadowReport(
    expansion.resolvedCandidates.map((row) => ({
      candidateKey: row.candidateKey,
      artistName: row.artistName,
      trackName: row.trackName,
      albumName: row.albumName,
      rawScore: row.scoreCard.score,
    })),
  );

  const output = {
    user: user.email ?? user.id,
    source: {
      kind: "LIKED_GATE6A_RESOLVED_CANDIDATES",
      attempted: expansion.resolution.attempted,
      resolved: expansion.resolution.resolved,
      ambiguous: expansion.resolution.ambiguous,
      spotifyCatalogCalls: expansion.resolution.spotifyCatalogCalls,
      spotifyFailures: expansion.resolution.spotifyFailures,
      spotifyRateLimits: expansion.resolution.spotifyRateLimits,
    },
    ...report,
  };

  if (hasArg("json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(42)}${String(value)}`);

  console.log("========== MUSIC-VERSION-01 — GATE 3 SCORE SHADOW ==========");
  p("User:", output.user);
  p("Generated at:", report.generatedAt.toISOString());
  p("Shadow only:", report.safety.shadowOnly);
  p("Planner influence:", report.safety.plannerInfluence);
  p("Database writes:", report.safety.databaseWrites);
  p("Spotify writes:", report.safety.spotifyWrites);
  console.log();

  console.log("Policy:");
  p("  version:", report.policy.version);
  p("  studio/standard multiplier:", report.policy.studioOrStandardMultiplier);
  p("  unknown multiplier:", report.policy.unknownMultiplier);
  p("  live multiplier:", report.policy.liveMultiplier);
  console.log();

  console.log("Source evidence:");
  p("  source:", output.source.kind);
  p("  attempted:", output.source.attempted);
  p("  resolved:", output.source.resolved);
  p("  ambiguous:", output.source.ambiguous);
  p("  Spotify catalog calls:", output.source.spotifyCatalogCalls);
  p("  Spotify failures:", output.source.spotifyFailures);
  p("  Spotify rate limits:", output.source.spotifyRateLimits);
  console.log();

  console.log("Impact:");
  p("  candidates:", report.totals.candidates);
  p("  live candidates:", report.totals.liveCandidates);
  p("  penalized candidates:", report.totals.penalizedCandidates);
  p("  candidates changing rank:", report.totals.changedRankCandidates);
  console.log();

  console.log("Before -> shadow rank:");
  for (const row of report.originalOrder) {
    console.log(
      `  ${row.originalRank} -> ${row.shadowRank}. ${row.artistName} — ${row.trackName} | ${row.version.classification} | raw=${row.rawScore.toFixed(3)} | shadow=${row.adjustedScore.toFixed(3)} | delta=${row.scoreDelta.toFixed(3)} | x${row.multiplier.toFixed(2)}`,
    );
  }
  console.log();

  console.log("Shadow order:");
  for (const row of report.shadowOrder) {
    console.log(
      `  ${row.shadowRank}. ${row.artistName} — ${row.trackName} | ${row.version.classification} | raw=${row.rawScore.toFixed(3)} | shadow=${row.adjustedScore.toFixed(3)}`,
    );
  }
  console.log();

  console.log(
    "Gate 3 é somente shadow: a penalidade LIVE é calculada e comparada, mas não altera score persistido, planner ou playlist.",
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
