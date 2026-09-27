import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  gate4E1RuntimeSummary,
  runWithGate4E1RuntimeState,
} from "@/services/music-identity/canonical-dedupe-runtime";
import { prepareGate4E1CanonicalDedupeRuntime } from "@/services/music-identity/canonical-dedupe-runtime-preparation";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-playback-reserve";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-playback-reserve";

/**
 * MUSIC-IDENTITY-01 Gate 4E1 outer generation boundary.
 *
 * OFF is the default and performs no projection DB read. ACTIVE requires an
 * explicit userId:targetPlaylistId allowlist pair. Preparation reads only the
 * persisted READY projection and current DB snapshot; no resolver/builder or
 * provider client participates. The planner consumes only the prepared
 * in-memory state.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetScope = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : null;

  const state = await prepareGate4E1CanonicalDedupeRuntime({
    userId: opts.userId,
    targetPlaylistIds: targetScope,
    requestedMode: process.env.MUSIC_IDENTITY_GATE4E1_MODE ?? "OFF",
    allowlist: process.env.MUSIC_IDENTITY_GATE4E1_ALLOWLIST ?? null,
  });

  const result = await runWithGate4E1RuntimeState(state, () =>
    baseGeneratePlaylists(opts),
  );

  // Observability is best-effort after the authoritative generation result.
  // It must never convert a successful Spotify write into a retry hazard.
  try {
    const row = await prisma.generationRun.findUnique({
      where: { id: result.runId },
      select: { summary: true },
    });
    const current =
      row?.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
        ? (row.summary as Prisma.JsonObject)
        : {};
    const evidence = JSON.parse(
      JSON.stringify(gate4E1RuntimeSummary(state)),
    ) as Prisma.InputJsonValue;
    await prisma.generationRun.update({
      where: { id: result.runId },
      data: {
        summary: {
          ...current,
          musicIdentityCanonicalDedupe: evidence,
        } as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `MUSIC-IDENTITY Gate 4E1 runtime metrics persistence failed after generation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      // Best-effort observability only.
    }
  }

  return result;
}
