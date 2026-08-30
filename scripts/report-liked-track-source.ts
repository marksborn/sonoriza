import { prisma } from "@/lib/prisma";
import { getLikedTrackSourceSnapshot } from "@/services/music-preference/liked-track-source";

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
      "Uso: npx tsx scripts/report-liked-track-source.ts --email=usuario@exemplo.com [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const report = await getLikedTrackSourceSnapshot(user.id);

  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(38)}${String(value)}`);

  console.log("========== SOURCE-LIKED-01 — FONTE LOCAL ==========");
  p("User:", user.email);
  p("Generated at:", report.generatedAt.toISOString());
  console.log();

  console.log("Native source contract:");
  p("  key:", report.source.key);
  p("  type:", report.source.type);
  p("  kind:", report.source.kind);
  p("  semantics:", report.source.semantics);
  p("  persistence:", report.source.persistence);
  p("  provider reads:", report.source.providerReads);
  p("  Spotify writes:", report.source.spotifyWrites);
  p("  planner influence:", report.source.plannerInfluence);
  console.log();

  console.log("Local canonical materialization:");
  p("  active liked tracks:", report.counts.activeLikedTracks);
  p("  available:", report.counts.available);
  p("  unavailable:", report.counts.unavailable);
  p("  invalid:", report.counts.invalid);
  p("  with URI:", report.counts.withUri);
  p("  with title:", report.counts.withTitle);
  p("  with primary artist:", report.counts.withPrimaryArtist);
  p("  with album:", report.counts.withAlbum);
  p("  with duration:", report.counts.withDuration);
  p("  identity materialized locally:", report.counts.locallyMaterializedIdentity);
  p("  planner-ready available:", report.counts.plannerReadyAvailable);
  console.log();

  console.log("Freshness:");
  p("  newest saved at:", report.freshness.newestAddedAt?.toISOString() ?? "-");
  p("  oldest saved at:", report.freshness.oldestAddedAt?.toISOString() ?? "-");
  p("  latest observed at:", report.freshness.latestObservedAt?.toISOString() ?? "-");
  console.log();

  console.log("Planner materialization:");
  p("  ready:", report.plannerMaterialization.ready);
  p("  degraded:", report.plannerMaterialization.degraded);
  p("  blocker:", report.plannerMaterialization.blocker ?? "-");
  p("  missing field:", report.plannerMaterialization.requiredMissingField ?? "-");
  p("  eligible available:", report.plannerMaterialization.eligibleAvailableTracks);
  p("  blocked available:", report.plannerMaterialization.blockedAvailableTracks);
  p(
    "  blocked available percent:",
    `${report.plannerMaterialization.blockedAvailablePercent.toFixed(4)}%`,
  );
  p(
    "  max blocked available:",
    report.plannerMaterialization.limits.maxBlockedAvailableTracks,
  );
  p(
    "  max blocked percent:",
    `${report.plannerMaterialization.limits.maxBlockedAvailablePercent}%`,
  );
  if (report.plannerMaterialization.blockedSample.length > 0) {
    console.log("  blocked sample:");
    for (const item of report.plannerMaterialization.blockedSample) {
      console.log(
        `    - ${item.artist ?? "?"} — ${item.title ?? "?"} | ${item.spotifyTrackId} | missing=${item.missingFields.join(",")}`,
      );
    }
  }
  console.log(`  note: ${report.plannerMaterialization.note}`);
  console.log();

  console.log("Sample:");
  for (const [index, item] of report.sample.entries()) {
    console.log(
      `  ${index + 1}. ${item.artist ?? "?"} — ${item.title ?? "?"} | ${item.spotifyTrackId} | ${item.durationMs ?? "?"} ms | ${item.availability}`,
    );
  }
  if (report.sample.length === 0) console.log("  none");
  console.log();

  console.log(
    "Relatório estritamente local/read-only: nenhuma chamada Spotify, nenhum write e nenhuma influência no planner.",
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
