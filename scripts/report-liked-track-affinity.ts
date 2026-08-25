import { LikedTrackPreferenceProvenance } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { syncLikedTrackAffinity } from "@/services/music-preference/liked-track-affinity";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function provenanceFromArgs(): LikedTrackPreferenceProvenance {
  const raw = argValue("provenance")?.toUpperCase();
  if (!raw || raw === "BACKFILL" || raw === "LIKED_TRACK_BACKFILL") {
    return LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL;
  }
  if (raw === "SYNC" || raw === "LIKED_TRACK_SYNC") {
    return LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC;
  }
  throw new Error("--provenance deve ser BACKFILL ou SYNC");
}

async function main() {
  const email = argValue("email");
  if (!email) {
    throw new Error(
      "Uso: npm run liked:affinity -- --email=usuario@exemplo.com [--apply] [--provenance=BACKFILL|SYNC] [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const apply = hasArg("apply");
  const report = await syncLikedTrackAffinity(user.id, {
    mode: apply ? "APPLY" : "PREVIEW",
    provenance: provenanceFromArgs(),
  });

  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(35)}${String(value)}`);

  console.log("========== LIKED-01 — GATE 2 SHADOW ==========");
  p("User:", user.email);
  p("Mode:", report.mode);
  p("Provenance:", report.provenance);
  p("Generated at:", report.generatedAt.toISOString());
  console.log();

  console.log("Spotify Saved Tracks:");
  p("  rows read:", report.provider.rows);
  p("  distinct canonical tracks:", report.provider.distinctCanonicalTracks);
  p("  technical duplicate rows:", report.provider.technicalDuplicateRows);
  p("  without canonical id:", report.provider.rowsWithoutCanonicalId);
  p("  provider pages:", report.provider.pagesRead);
  p("  provider calls:", report.provider.providerCalls);
  p("  retries:", report.provider.retries);
  p("  rate limits observed:", report.provider.rateLimitedCount);
  p("  retry wait:", `${report.provider.retryWaitMs} ms`);
  console.log();

  console.log("Canonical primary-artist identity:");
  p("  resolved:", report.identity.tracksWithResolvedPrimaryArtist);
  p("  unresolved:", report.identity.tracksWithoutResolvedPrimaryArtist);
  console.log();

  console.log("Before:");
  p("  active liked tracks:", report.before.likedTracks);
  p("  active affinity evidence:", report.before.activeEvidence);
  p("  active artists:", report.before.activeArtists);
  console.log();

  console.log("Planned reconciliation:");
  p("  tracks to create:", report.planned.tracksToCreate);
  p("  tracks to reactivate:", report.planned.tracksToReactivate);
  p("  tracks to unlike:", report.planned.tracksToUnlike);
  p("  track metadata updates:", report.planned.trackMetadataUpdates);
  p("  evidence to create:", report.planned.evidenceToCreate);
  p("  evidence to reactivate:", report.planned.evidenceToReactivate);
  p("  evidence to deactivate:", report.planned.evidenceToDeactivate);
  p("  evidence metadata updates:", report.planned.evidenceMetadataUpdates);
  p("  artist states to create:", report.planned.affinityStatesToCreate);
  p("  artist states to update:", report.planned.affinityStatesToUpdate);
  console.log();

  console.log("After:");
  p("  active liked tracks:", report.after.likedTracks);
  p("  active affinity evidence:", report.after.activeEvidence);
  p("  active artists:", report.after.activeArtists);
  console.log();

  if (report.mode === "PREVIEW") {
    console.log(
      "PREVIEW only: nenhuma preferência/afinidade foi persistida. Use --apply apenas no gate piloto após revisar este relatório.",
    );
  } else {
    console.log(
      "APPLY concluído em shadow mode: estado de LIKE/afinidade persistido, sem influência no planner/discovery e sem escrita no Spotify.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
