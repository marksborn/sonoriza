/**
 * #449 — One-shot podcast duration preview for the active Trabalho target.
 *
 * Launch only from a production checkout after PR CI and a reviewed deploy:
 *   node --env-file=.env --import tsx scripts/report-podcast08-work-preview.ts
 *
 * Reads Spotify sources through the existing simulation pipeline, records a
 * GenerationRun in the DB, but never writes/reorders Spotify playlists,
 * updates a TargetPlaylist or edits duration settings.
 *
 * DO NOT schedule this script or run while a productive generation is active.
 */
import { generatePlaylists } from "@/jobs/generate-playlists";
import { prisma } from "@/lib/prisma";
import { parseSequencePattern } from "@/services/playlist-planner";
import {
  validatePodcast08EphemeralPreviewRequest,
} from "@/services/playlist-planner/podcast-duration-ephemeral-preview";

const WORK_ID = "cmsj5ognn0001ji57670mc04x";

async function main() {
  if (
    process.env.PODCAST08_ACTIVE_MODE === "ACTIVE" ||
    process.env.PODCAST08_DURATION_EDITOR_ENABLED === "1" ||
    process.env.PODCAST08_SHADOW_MODE === "SHADOW"
  ) {
    throw new Error("PODCAST-08 #449 refuses to run with active/editor/shadow environment flags.");
  }

  const target = await prisma.targetPlaylist.findUnique({
    where: { id: WORK_ID },
    select: {
      id: true,
      userId: true,
      name: true,
      enabled: true,
      compositionMode: true,
      updatePolicy: true,
      sequencePattern: true,
    },
  });
  if (
    !target ||
    target.name !== "Trabalho" ||
    !target.enabled ||
    target.compositionMode !== "SEQUENCE" ||
    target.updatePolicy !== "REBUILD_DAILY"
  ) {
    throw new Error("Active Trabalho target no longer matches the explicitly authorized pilot.");
  }

  const sequence = parseSequencePattern(target.sequencePattern);
  const bands = sequence.map((type) =>
    type === "PODCAST" ? "SHORT" as const : "ANY" as const,
  );
  if (!bands.includes("SHORT")) {
    throw new Error("No PODCAST slot in active Trabalho sequence.");
  }
  const preview = { targetPlaylistId: WORK_ID, bands };
  validatePodcast08EphemeralPreviewRequest({
    simulate: true,
    targetScope: [WORK_ID],
    preview,
    activeMode: process.env.PODCAST08_ACTIVE_MODE,
  });

  console.log(JSON.stringify({
    phase: "START",
    target: "Trabalho",
    targetId: WORK_ID,
    mode: "SIMULATION_SHADOW_ONLY",
    requestedBands: bands,
    spotifyWrites: false,
    settingsPersisted: false,
  }));

  const result = await generatePlaylists({
    userId: target.userId,
    trigger: "SIMULATION",
    simulate: true,
    targetPlaylistIds: [WORK_ID],
    podcast08EphemeralPreview: preview,
  });
  const run = await prisma.generationRun.findUnique({
    where: { id: result.runId },
    select: { id: true, status: true, summary: true },
  });
  const summary = run?.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Preview simulation did not generate a structured summary.");
  }
  const evidence = summary as Record<string, unknown>;
  const shadow = evidence.podcast08Shadow;
  console.log(JSON.stringify({
    phase: "RESULT",
    runId: run.id,
    status: run.status,
    preview: evidence.podcast08EphemeralPreview,
    shadow,
    simulationOnly: evidence.podcast08SimulationOnly,
    notForApproval: evidence.podcast08PreviewNotForApproval,
  }, null, 2));
  if (
    evidence.podcast08SimulationOnly !== true ||
    evidence.podcast08PreviewNotForApproval !== true
  ) {
    throw new Error("PODCAST-08 preview safety evidence was not recorded.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unexpected preview failure");
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
