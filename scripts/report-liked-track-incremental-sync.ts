import { prisma } from "@/lib/prisma";
import { syncLikedTrackIncremental } from "@/services/music-preference/liked-track-incremental-sync";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

async function main() {
  const email = argValue("email");
  const apply = process.argv.includes("--apply");
  if (!email) {
    throw new Error(
      "Uso: npx tsx scripts/report-liked-track-incremental-sync.ts --email=usuario@exemplo.com [--apply]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  console.log("========== SOURCE-LIKED-01 — GATE 4B INCREMENTAL SYNC ==========");
  console.log(`User:                              ${user.email}`);
  console.log(`Mode:                              ${apply ? "APPLY" : "PREVIEW"}`);
  console.log();

  const report = await syncLikedTrackIncremental(user.id, {
    mode: apply ? "APPLY" : "PREVIEW",
  });
  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(35)}${String(value)}`);

  p("Status:", report.status);
  p("Generated at:", report.generatedAt.toISOString());
  p("Watermark addedAt:", report.boundary?.watermarkAddedAt ?? "-");
  p("Boundary track IDs:", report.boundary?.boundaryTrackIds.length ?? 0);
  console.log();

  console.log("Spotify Saved Tracks incremental:");
  p("  rows observed:", report.provider.rowsObserved);
  p("  new rows:", report.provider.newRows);
  p("  new canonical rows:", report.provider.newCanonicalRows);
  p("  new available rows:", report.provider.newAvailableRows);
  p("  new unavailable rows:", report.provider.newUnavailableRows);
  p("  new invalid rows:", report.provider.newInvalidRows);
  p("  pages read:", report.provider.pagesRead);
  p("  provider calls:", report.provider.providerCalls);
  p("  retries:", report.provider.retries);
  p("  rate limits:", report.provider.rateLimitedCount);
  p("  retry wait:", `${report.provider.retryWaitMs} ms`);
  p("  stopped at older item:", report.provider.stoppedAtOlderItem);
  console.log();

  console.log("Canonical reconciliation:");
  p("  before liked tracks:", report.before.likedTracks);
  p("  tracks to create:", report.planned.tracksToCreate);
  p("  tracks to reactivate:", report.planned.tracksToReactivate);
  p("  tracks to unlike:", report.planned.tracksToUnlike);
  p("  metadata updates:", report.planned.trackMetadataUpdates);
  p("  evidence to create:", report.planned.evidenceToCreate);
  p("  evidence to reactivate:", report.planned.evidenceToReactivate);
  p("  evidence to deactivate:", report.planned.evidenceToDeactivate);
  p("  evidence metadata updates:", report.planned.evidenceMetadataUpdates);
  p("  artist states to create:", report.planned.affinityStatesToCreate);
  p("  artist states to update:", report.planned.affinityStatesToUpdate);
  p("  after liked tracks:", report.after.likedTracks);
  console.log();

  p("Full scan avoided:", report.fullScanAvoided);
  p("Removals need reconciliation:", report.removalsRequireReconciliation);
  p("Planner influence:", report.plannerInfluence);
  p("Spotify writes:", report.spotifyWrites);
  console.log();

  if (report.status === "BASELINE_REQUIRED") {
    console.log(
      "RESULTADO: ⚠️ BASELINE REQUIRED — nenhum provider call foi feito; execute o backfill explícito antes do incremental.",
    );
    process.exitCode = 2;
    return;
  }

  const valid =
    report.fullScanAvoided === true &&
    report.planned.tracksToUnlike === 0 &&
    report.plannerInfluence === false &&
    report.spotifyWrites === false;

  console.log(
    valid
      ? `RESULTADO: ✅ GATE 4B ${apply ? "APPLY" : "PREVIEW"} INCREMENTAL SEGURO`
      : "RESULTADO: ⚠️ REVISAR EVIDÊNCIA DO GATE 4B",
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
