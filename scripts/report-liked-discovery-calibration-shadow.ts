import { prisma } from "@/lib/prisma";
import { getLikedDiscoveryCalibrationShadowReport } from "@/services/music-preference/liked-discovery-calibration-shadow";

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
      "Uso: npm run liked:calibrate-shadow -- --email=usuario@exemplo.com [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const report = await getLikedDiscoveryCalibrationShadowReport(user.id);
  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email ?? user.id, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(44)}${String(value)}`);

  console.log("========== LIKED-01 — GATE 6B CALIBRATION SHADOW ==========");
  p("User:", user.email ?? user.id);
  p("Generated at:", report.generatedAt.toISOString());
  p("Shadow only:", report.safety.shadowOnly);
  p("Planner influence:", report.safety.plannerInfluence);
  p("Database writes:", report.safety.databaseWrites);
  p("Spotify writes:", report.safety.spotifyWrites);
  p("Expansion Last.fm calls:", report.safety.expansionLastFmCalls);
  console.log();

  console.log("Calibration policy:");
  p("  top capacity:", report.policy.topPerCategory);
  p("  max exploratory slots:", report.policy.maxExploratorySlots);
  p("  external score floor:", report.policy.externalScoreFloor);
  p("  external score compression:", report.policy.externalScoreCompression);
  p(
    "  max ambiguity rate for pilot:",
    `${(report.policy.maxAmbiguityRateForPilot * 100).toFixed(1)}%`,
  );
  p("  min resolved candidates:", report.policy.minResolvedCandidatesForPilot);
  console.log();

  console.log("Gate 6A source evidence:");
  p("  source generated at:", report.sourceExpansion.generatedAt.toISOString());
  p("  baseline discovery pool:", report.sourceExpansion.baselineDiscoveryPoolSize);
  p("  resolution attempted:", report.sourceExpansion.attempted);
  p("  resolution resolved:", report.sourceExpansion.resolved);
  p("  resolution ambiguous:", report.sourceExpansion.ambiguous);
  p(
    "  ambiguity rate:",
    `${(report.sourceExpansion.ambiguityRate * 100).toFixed(1)}%`,
  );
  p("  Spotify catalog calls:", report.sourceExpansion.spotifyCatalogCalls);
  p("  Spotify failures:", report.sourceExpansion.spotifyFailures);
  p("  Spotify rate limits:", report.sourceExpansion.spotifyRateLimits);
  p("  Spotify retries:", report.sourceExpansion.spotifyRetries);
  console.log();

  console.log("Score calibration:");
  p("  raw resolved min:", formatScore(report.scoreCalibration.rawResolvedMin));
  p("  raw resolved max:", formatScore(report.scoreCalibration.rawResolvedMax));
  p(
    "  calibrated resolved min:",
    formatScore(report.scoreCalibration.calibratedResolvedMin),
  );
  p(
    "  calibrated resolved max:",
    formatScore(report.scoreCalibration.calibratedResolvedMax),
  );
  console.log();

  console.log("Near-duplicate quarantine:");
  p("  quarantined:", report.nearDuplicates.quarantined);
  if (report.nearDuplicates.rows.length === 0) {
    console.log("    none");
  } else {
    report.nearDuplicates.rows.forEach((row, index) => {
      console.log(
        `    ${index + 1}. ${row.artistName} — ${row.trackName} | raw=${row.rawScore.toFixed(3)} | seed=${row.matchedSeedNames.join(", ")} | ${row.reason}`,
      );
    });
  }
  console.log();

  console.log("Calibrated mixed shadow top:");
  if (report.calibratedTop.length === 0) {
    console.log("    none");
  } else {
    report.calibratedTop.forEach((row, index) => {
      console.log(
        `    ${index + 1}. ${row.artistName} — ${row.trackName} | raw=${row.rawScore.toFixed(3)} | calibrated=${row.calibratedScore.toFixed(3)} | source=${row.source} | signal=${row.signalKind}`,
      );
      if (row.explanation) console.log(`       ${row.explanation}`);
    });
  }
  console.log();

  console.log("Mix diagnostics:");
  p("  current slots:", report.mix.currentSlots);
  p("  exploratory slots:", report.mix.exploratorySlots);
  p("  actual exploratory share:", `${(report.mix.exploratoryShare * 100).toFixed(1)}%`);
  p(
    "  configured capacity share:",
    `${(report.mix.capacityExploratoryShare * 100).toFixed(1)}%`,
  );
  console.log();

  p(
    "Entrants vs LIKED overlay:",
    report.changesVsLikedOverlay.entrants.length > 0
      ? report.changesVsLikedOverlay.entrants
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join("; ")
      : "none",
  );
  p(
    "Exits vs LIKED overlay:",
    report.changesVsLikedOverlay.exits.length > 0
      ? report.changesVsLikedOverlay.exits
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join("; ")
      : "none",
  );
  console.log();

  p("Readiness:", report.readiness.status);
  report.readiness.reasons.forEach((reason) => console.log(`  - ${reason}`));
  console.log();
  console.log(
    "Gate 6B continua somente shadow: a política calibra e mistura o resultado do Gate 6A, mas não persiste candidatos, não altera o planner e não escreve playlists.",
  );
}

function formatScore(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
