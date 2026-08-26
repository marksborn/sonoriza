import { prisma } from "@/lib/prisma";
import { getLikedDiscoveryExpansionShadowReport } from "@/services/music-preference/liked-discovery-expansion-shadow";
import { buildTrackVersionShadowReport } from "@/services/music-discovery/track-version-preference";

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
      "Uso: npm run discovery:track-version-shadow -- --email=usuario@exemplo.com [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const expansion = await getLikedDiscoveryExpansionShadowReport(user.id);
  const report = buildTrackVersionShadowReport(
    expansion.resolvedCandidates.map((row) => ({
      spotifyTrackId: row.spotifyTrackId,
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

  console.log("========== MUSIC-VERSION-01 — GATE 1 SHADOW ==========");
  p("User:", output.user);
  p("Generated at:", report.generatedAt.toISOString());
  p("Shadow only:", report.safety.shadowOnly);
  p("Planner influence:", report.safety.plannerInfluence);
  p("Database writes:", report.safety.databaseWrites);
  p("Spotify writes:", report.safety.spotifyWrites);
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

  console.log("Version classification:");
  p("  candidates:", report.totals.candidates);
  p("  live:", report.totals.live);
  p("  studio/standard:", report.totals.studioOrStandard);
  p("  unknown:", report.totals.unknown);
  p("  live share:", `${(report.totals.liveShare * 100).toFixed(1)}%`);
  console.log();

  console.log("Resolved candidates:");
  if (report.rows.length === 0) {
    console.log("  none");
  } else {
    report.rows.forEach((row, index) => {
      console.log(
        `  ${index + 1}. ${row.artistName} — ${row.trackName} | album=${row.albumName ?? "n/a"} | version=${row.version.classification} | reason=${row.version.reason} | raw=${row.rawScore?.toFixed(3) ?? "n/a"}`,
      );
      if (row.version.matchedText) {
        console.log(
          `     evidence=${row.version.source}:${row.version.matchedText}`,
        );
      }
    });
  }
  console.log();

  console.log(
    "Gate 1 é somente diagnóstico: classifica a versão já escolhida pelo resolver atual. Não procura uma alternativa de estúdio e não altera a seleção. Essa comparação entra no Gate 2.",
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
