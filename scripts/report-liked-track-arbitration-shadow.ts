import { prisma } from "@/lib/prisma";
import { generatePlaylists } from "@/jobs/generate-playlists";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value
        .map(record)
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

async function main() {
  const email = argValue("email");
  const targetId = argValue("target-id");
  if (!email || !targetId) {
    throw new Error(
      "Uso: npx tsx scripts/report-liked-track-arbitration-shadow.ts --email=usuario@exemplo.com --target-id=TARGET_ID",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const target = await prisma.targetPlaylist.findFirst({
    where: { id: targetId, userId: user.id, enabled: true },
    select: { id: true, name: true },
  });
  if (!target) {
    throw new Error(`Destino ativo não encontrado para o usuário: ${targetId}`);
  }

  console.log("========== SOURCE-LIKED-01 — GATE 3C ARBITRATION SHADOW ==========");
  console.log(`User:                  ${user.email}`);
  console.log(`Target:                ${target.name} (${target.id})`);
  console.log("Mode:                  SIMULATION + SHADOW_ONLY");
  console.log();

  const result = await generatePlaylists({
    userId: user.id,
    trigger: "SIMULATION",
    simulate: true,
    targetPlaylistIds: [target.id],
  });

  const run = await prisma.generationRun.findUnique({
    where: { id: result.runId },
    select: {
      id: true,
      status: true,
      simulation: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      summary: true,
    },
  });
  if (!run) throw new Error(`GenerationRun não encontrado: ${result.runId}`);

  const summary = record(run.summary) ?? {};
  const shadow = record(summary.likedTrackSourceShadow);
  const arbitration = shadow ? record(shadow.arbitrationShadow) : null;

  console.log(`Run ID:                ${run.id}`);
  console.log(`Run status:            ${run.status}`);
  console.log(`Simulation:            ${run.simulation}`);
  console.log(`Started:               ${run.startedAt.toISOString()}`);
  console.log(`Finished:              ${run.finishedAt?.toISOString() ?? "-"}`);
  console.log(`Run error:             ${run.error ?? "none"}`);
  console.log();

  if (!shadow || !arbitration) {
    console.log("Gate 3C evidence:      MISSING");
    process.exitCode = 2;
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(40)}${String(value)}`);

  p("Gate 3B shadow status:", shadow.status ?? null);
  p("Authoritative plan unchanged:", shadow.currentPlanUnchanged ?? null);
  p("Gate 3C policy version:", arbitration.policyVersion ?? null);
  p("Gate 3C mode:", arbitration.mode ?? null);
  p("Gate 3C strategy:", arbitration.strategy ?? null);
  p("Planner influence:", arbitration.plannerInfluence ?? null);
  p("Exposure scenarios:", JSON.stringify(arbitration.exposures ?? null));
  console.log();

  console.log("Current plan liked representation:");
  console.log(JSON.stringify(arbitration.currentRepresentation ?? null, null, 2));
  console.log();

  console.log("Arbitration variants 5/10/20%:");
  console.log(JSON.stringify(arbitration.variants ?? null, null, 2));
  console.log();

  const current = records(arbitration.currentRepresentation);
  const variants = records(arbitration.variants);
  const targetCurrent = current.find(
    (item) => item.targetPlaylistId === target.id,
  );

  if (targetCurrent) {
    p("Current selected music:", targetCurrent.selectedMusicCount ?? null);
    p("Current selected already liked:", targetCurrent.selectedLikedCount ?? null);
    p(
      "Current liked share of selected music:",
      `${targetCurrent.selectedLikedPercentOfMusic ?? null}%`,
    );
  }

  for (const variant of variants) {
    const exposure = variant.exposurePercent;
    const targetVariant = records(variant.targets).find(
      (item) => item.targetPlaylistId === target.id,
    );
    if (!targetVariant) continue;
    console.log();
    console.log(`--- Exposure ${exposure}% ---`);
    p("Shadow selected liked:", targetVariant.shadowLikedSelectedCount ?? null);
    p("Delta liked selected:", targetVariant.deltaLikedSelected ?? null);
    p(
      "Exclusive liked selected:",
      targetVariant.exclusiveLikedSelectedCount ?? null,
    );
    p("Tracks added vs current:", targetVariant.selectedAddedVsCurrent ?? null);
    p("Tracks removed vs current:", targetVariant.selectedRemovedVsCurrent ?? null);
    p("Duration delta ms:", targetVariant.durationDeltaMs ?? null);
    p("Distinct artist delta:", targetVariant.distinctArtistDelta ?? null);
    p("Distinct album delta:", targetVariant.distinctAlbumDelta ?? null);
    p(
      "Composition quality preserved:",
      targetVariant.compositionQualityPreserved ?? null,
    );
    p(
      "Sequence quality preserved:",
      targetVariant.sequenceQualityPreserved ?? null,
    );
  }

  console.log();
  const exposures = Array.isArray(arbitration.exposures)
    ? arbitration.exposures.map(Number)
    : [];
  const valid =
    run.status === "SUCCESS" &&
    run.simulation === true &&
    shadow.status === "READY" &&
    shadow.currentPlanUnchanged === true &&
    shadow.plannerInfluence === false &&
    arbitration.policyVersion === "source-liked-gate3c-v1" &&
    arbitration.mode === "SHADOW_ONLY" &&
    arbitration.plannerInfluence === false &&
    JSON.stringify(exposures) === JSON.stringify([5, 10, 20]) &&
    current.length > 0 &&
    variants.length === 3;

  console.log(
    valid
      ? "RESULTADO: ✅ GATE 3C ARBITRATION SHADOW CAPTURADO COM SEGURANÇA"
      : "RESULTADO: ⚠️ REVISAR EVIDÊNCIA DO GATE 3C",
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
