import { prisma } from "@/lib/prisma";
import { syncLikedTrackDuration } from "@/services/music-preference/liked-track-duration";

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
      "Uso: npx tsx scripts/report-liked-track-duration.ts --email=usuario@exemplo.com [--apply] [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const apply = hasArg("apply");
  const report = await syncLikedTrackDuration(user.id, {
    mode: apply ? "APPLY" : "PREVIEW",
  });

  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(38)}${String(value)}`);

  console.log("========== SOURCE-LIKED-01 — GATE 3A DURATION ==========");
  p("User:", user.email);
  p("Mode:", report.mode);
  p("Generated at:", report.generatedAt.toISOString());
  console.log();

  console.log("Spotify Saved Tracks (read-only):");
  p("  rows:", report.provider.rows);
  p("  canonical tracks:", report.provider.canonicalTracks);
  p("  tracks with duration:", report.provider.tracksWithDuration);
  p("  pages:", report.provider.pagesRead);
  p("  provider calls:", report.provider.providerCalls);
  p("  retries:", report.provider.retries);
  p("  rate limits:", report.provider.rateLimitedCount);
  p("  retry wait:", `${report.provider.retryWaitMs} ms`);
  console.log();

  console.log("Canonical local state:");
  p("  active liked tracks:", report.local.activeLikedTracks);
  p("  before with duration:", report.local.beforeWithDuration);
  p("  duration updates planned:", report.local.updatesPlanned);
  p("  unchanged with duration:", report.local.unchangedWithDuration);
  p("  missing provider track:", report.local.missingProviderTrack);
  p("  missing provider duration:", report.local.missingProviderDuration);
  p("  after with duration:", report.local.afterWithDuration);
  p("  projected coverage:", `${report.local.coveragePercent}%`);
  console.log();

  p("Planner influence:", report.plannerInfluence);
  p("Spotify writes:", report.spotifyWrites);
  console.log();

  if (report.mode === "PREVIEW") {
    console.log(
      "PREVIEW only: nenhuma duração foi persistida. Revise o relatório antes de usar --apply.",
    );
  } else {
    console.log(
      "APPLY concluído: somente durationMs local foi atualizado; a fonte continua sem influência no planner e sem write Spotify.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
