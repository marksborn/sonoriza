import { prisma } from "@/lib/prisma";
import { generatePlaylists } from "@/jobs/generate-playlists";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

async function main() {
  const email = argValue("email");
  const targetId = argValue("target-id");
  if (!email || !targetId) {
    throw new Error(
      "Uso: npx tsx scripts/report-liked-track-planner-shadow.ts --email=usuario@exemplo.com --target-id=TARGET_ID",
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
  if (!target) throw new Error(`Destino ativo não encontrado para o usuário: ${targetId}`);

  console.log("========== SOURCE-LIKED-01 — GATE 3B SHADOW ==========");
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

  const summary =
    run.summary && typeof run.summary === "object" && !Array.isArray(run.summary)
      ? (run.summary as Record<string, unknown>)
      : {};
  const shadow =
    summary.likedTrackSourceShadow &&
    typeof summary.likedTrackSourceShadow === "object" &&
    !Array.isArray(summary.likedTrackSourceShadow)
      ? (summary.likedTrackSourceShadow as Record<string, unknown>)
      : null;

  console.log(`Run ID:                ${run.id}`);
  console.log(`Run status:            ${run.status}`);
  console.log(`Simulation:            ${run.simulation}`);
  console.log(`Started:               ${run.startedAt.toISOString()}`);
  console.log(`Finished:              ${run.finishedAt?.toISOString() ?? "-"}`);
  console.log(`Run error:             ${run.error ?? "none"}`);
  console.log();

  if (!shadow) {
    console.log("Shadow evidence:       MISSING");
    process.exitCode = 2;
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(38)}${String(value)}`);

  p("Shadow status:", shadow.status ?? null);
  p("Shadow reason:", shadow.reason ?? null);
  p("Policy enabled:", shadow.policyEnabled ?? null);
  p("Shadow only:", shadow.shadowOnly ?? null);
  p("Planner influence:", shadow.plannerInfluence ?? null);
  p("Provider reads (source):", shadow.providerReads ?? null);
  p("Spotify writes (shadow):", shadow.spotifyWrites ?? null);
  p("Authoritative plan unchanged:", shadow.currentPlanUnchanged ?? null);
  p("Liked source tracks:", shadow.likedSourceTrackCount ?? null);
  p("Liked source resolved:", shadow.likedSourceResolvedCount ?? null);
  p("Liked source unavailable:", shadow.likedSourceUnavailableCount ?? null);
  p("Liked candidates read locally:", shadow.likedSourceCandidatesRead ?? null);
  p("Repeat eligible:", shadow.repeatEligibleCandidates ?? null);
  p("Repeat blocked:", shadow.repeatBlockedCandidates ?? null);
  p("Candidates selected from source:", shadow.likedSourceCandidatesSelected ?? null);
  console.log();

  console.log("Target input / overlap:");
  console.log(JSON.stringify(shadow.targetInputs ?? null, null, 2));
  console.log();
  console.log("Current x shadow plan:");
  console.log(JSON.stringify(shadow.targets ?? null, null, 2));
  console.log();

  const valid =
    run.status === "SUCCESS" &&
    run.simulation === true &&
    shadow.status === "READY" &&
    shadow.reason === "SHADOW_COMPARISON_COMPLETE" &&
    shadow.shadowOnly === true &&
    shadow.plannerInfluence === false &&
    shadow.currentPlanUnchanged === true &&
    shadow.providerReads === false &&
    shadow.spotifyWrites === false;

  console.log(
    valid
      ? "RESULTADO: ✅ GATE 3B SHADOW VALIDADO TECNICAMENTE"
      : "RESULTADO: ⚠️ REVISAR EVIDÊNCIA DO GATE 3B",
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
