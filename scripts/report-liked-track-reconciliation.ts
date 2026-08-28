import { prisma } from "@/lib/prisma";
import {
  reconcileLikedTracks,
  type LikedTrackReconciliationLimits,
} from "@/services/music-preference/liked-track-reconciliation";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function positiveNumberArg(name: string): number | undefined {
  const raw = argValue(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} deve ser um número positivo`);
  }
  return parsed;
}

async function main() {
  const email = argValue("email");
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  if (!email) {
    throw new Error(
      "Uso: npx tsx scripts/report-liked-track-reconciliation.ts --email=usuario@exemplo.com [--apply] [--force] [--max-unlikes=25] [--max-unlike-percent=5]",
    );
  }
  if (force && !apply) {
    throw new Error("--force só pode ser usado junto com --apply após revisar um PREVIEW");
  }

  const maxUnlikesRaw = positiveNumberArg("max-unlikes");
  const maxUnlikePercent = positiveNumberArg("max-unlike-percent");
  if (maxUnlikesRaw !== undefined && !Number.isInteger(maxUnlikesRaw)) {
    throw new Error("--max-unlikes deve ser um inteiro positivo");
  }
  const limits: Partial<LikedTrackReconciliationLimits> = {
    ...(maxUnlikesRaw !== undefined ? { maxUnlikes: maxUnlikesRaw } : {}),
    ...(maxUnlikePercent !== undefined ? { maxUnlikePercent } : {}),
  };

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  console.log("========== SOURCE-LIKED-01 — GATE 4C RECONCILIATION ==========");
  console.log(`User:                              ${user.email}`);
  console.log(`Mode:                              ${apply ? "APPLY" : "PREVIEW"}`);
  console.log(`Force reviewed override:           ${force}`);
  console.log();

  const report = await reconcileLikedTracks(user.id, {
    mode: apply ? "APPLY" : "PREVIEW",
    force,
    limits,
  });
  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(35)}${String(value)}`);

  p("Status:", report.status);
  p("Generated at:", report.generatedAt.toISOString());
  p("Applied:", report.applied);
  p("Forced:", report.forced);
  console.log();

  console.log("Spotify Saved Tracks full reconciliation:");
  p("  rows:", report.provider.rows);
  p("  canonical tracks:", report.provider.distinctCanonicalTracks);
  p("  technical duplicates:", report.provider.technicalDuplicateRows);
  p("  without canonical id:", report.provider.rowsWithoutCanonicalId);
  p("  pages:", report.provider.pagesRead);
  p("  provider calls:", report.provider.providerCalls);
  p("  retries:", report.provider.retries);
  p("  rate limits:", report.provider.rateLimitedCount);
  p("  retry wait:", `${report.provider.retryWaitMs} ms`);
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

  console.log("Safety circuit breaker:");
  p("  reasons:", report.safety.reasons.join(", "));
  p("  unlike count:", report.safety.unlikeCount);
  p("  unlike percent:", `${report.safety.unlikePercent.toFixed(4)}%`);
  p("  max unlikes:", report.safety.limits.maxUnlikes);
  p("  max unlike percent:", `${report.safety.limits.maxUnlikePercent}%`);
  p("  automatic apply allowed:", report.safety.automaticApplyAllowed);
  p("  manual force allowed:", report.safety.manualForceAllowed);
  console.log();

  if (report.unlikeSample.length > 0) {
    console.log("Unlike sample:");
    for (const [index, track] of report.unlikeSample.entries()) {
      console.log(
        `  ${index + 1}. ${track.artist ?? "-"} — ${track.title ?? "-"} | ${track.spotifyTrackId} | saved ${track.addedAt?.toISOString() ?? "-"}`,
      );
    }
    console.log();
  }

  p("Full scan:", report.fullScan);
  p("Planner influence:", report.plannerInfluence);
  p("Spotify writes:", report.spotifyWrites);
  console.log();

  if (report.status === "BASELINE_REQUIRED") {
    console.log(
      "RESULTADO: ⚠️ BASELINE REQUIRED — nenhum provider call foi feito; materialize a biblioteca explicitamente antes da reconciliação periódica.",
    );
    process.exitCode = 2;
    return;
  }
  if (report.status === "BLOCKED") {
    console.log(
      "RESULTADO: ⛔ GATE 4C BLOQUEADO — há lacunas de identidade canônica; não aplique remoções.",
    );
    process.exitCode = 2;
    return;
  }
  if (report.status === "REVIEW_REQUIRED" && !report.applied) {
    console.log(
      "RESULTADO: ⚠️ GATE 4C REQUER REVISÃO — circuito de segurança bloqueou APPLY automático. Revise o sample antes de qualquer --apply --force.",
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    `RESULTADO: ✅ GATE 4C ${apply ? "APPLY" : "PREVIEW"} FULL RECONCILIATION SEGURO`,
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
