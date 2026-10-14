import type { Prisma } from "@prisma/client";

import type { GeneratePlaylistsOptions } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import { prepareKeepFilledTarget } from "@/services/keep-filled-maintenance";
import { LEGACY_GLOBAL_SHARING_POLICY, resolveEffectiveSharingPolicy } from "@/services/playlist-planner/target-sharing-shadow";
import type { TargetSharingReservationOwner } from "@/services/playlist-planner/target-sharing-runtime";
import { SpotifyClient } from "@/services/spotify";
import { resolveManualKeepFilledCalendarIds } from "@/services/manual-keep-filled-calendar-scope";

type KeepFilledOptions = Pick<
  GeneratePlaylistsOptions,
  "preservedByTargetId" | "keepFilledByTargetId" | "scheduledPolicyByTargetId" |
  "externalReservationsByUri" | "reservedTargetSnapshots"
>;

export type ManualKeepFilledPreflight =
  | Readonly<{
      kind: "NOOP";
      targetId: string;
      reason: "EMPTY_CALENDAR_KEEP" | "EMPTY_CALENDAR_SKIP";
    }>
  | Readonly<{
      kind: "READY";
      targetId: string;
      options: KeepFilledOptions;
    }>;

/**
 * #460 / CALENDAR-127: align preflight with the generator's target-specific
 * duration calendar rules. Never silently fall back from an invalid SELECTED
 * or ALL_QUERYABLE scope to the legacy global duration calendars.
 */
/**
 * Individual manual/simulation path. The request never supplies snapshots,
 * preserved URIs or sharing owners: all state is read server-side with the
 * same preservation algorithm used by the scheduled KEEP_FILLED path.
 *
 * This does not itself perform Spotify writes, enable Reserve, or approve a
 * productive rollout. Generation verifies all snapshots again before writes.
 */
export async function prepareManualKeepFilledTarget(
  userId: string,
  targetId: string,
  date: Date,
): Promise<ManualKeepFilledPreflight> {
  const target = await prisma.targetPlaylist.findFirst({
    where: { id: targetId, userId, enabled: true, updatePolicy: "KEEP_FILLED" },
    include: {
      calendarSelections: {
        select: {
          calendarSelection: {
            select: { googleCalendarId: true, selected: true, userId: true },
          },
        },
      },
    },
  });
  if (!target || !target.spotifyPlaylistId) {
    throw new Error("Destino KEEP_FILLED não disponível ou sem playlist Spotify vinculada.");
  }

  const userCalendars = target.durationMode === "CALENDAR"
    ? await prisma.calendarSelection.findMany({
        where: { userId, selected: true },
        select: { googleCalendarId: true, usedForDuration: true },
      })
    : [];
  const linkedCalendars = target.calendarSelections.map((link) => link.calendarSelection);
  const durationCalendarIds = resolveManualKeepFilledCalendarIds({
    durationMode: target.durationMode,
    calendarMode: target.calendarMode,
    selectedGoogleCalendarIds: linkedCalendars.map((calendar) => calendar.googleCalendarId),
    invalidLinkedCalendarCount: linkedCalendars.filter(
      (calendar) => !calendar.selected || calendar.userId !== userId,
    ).length,
    queryableCalendarIds: userCalendars.map((calendar) => calendar.googleCalendarId),
    legacyDurationCalendarIds: userCalendars
      .filter((calendar) => calendar.usedForDuration)
      .map((calendar) => calendar.googleCalendarId),
  });

  const prepared = await prepareKeepFilledTarget(
    userId,
    target,
    date,
    durationCalendarIds,
  );
  if (prepared.skipReason) {
    // KEEP / SKIP with an empty calendar must not even read the destination.
    return {
      kind: "NOOP",
      targetId,
      reason: prepared.skipReason,
    };
  }
  if (!prepared.patch.snapshotBefore?.trim()) {
    throw new Error("Snapshot de preservação KEEP_FILLED indisponível.");
  }

  const [user, outsideTargets] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { defaultTargetSharingPolicy: true },
    }),
    prisma.targetPlaylist.findMany({
      where: {
        userId,
        enabled: true,
        id: { notIn: [targetId] },
        spotifyPlaylistId: { not: null },
      },
      orderBy: { priority: "asc" },
      select: { id: true, spotifyPlaylistId: true, sharingPolicy: true },
    }),
  ]);
  if (!user) throw new Error("Conta não encontrada.");

  const externalReservationsByUri: Record<string, TargetSharingReservationOwner[]> = {};
  const reservedTargetSnapshots: Record<string, string> = {};
  if (outsideTargets.length > 0) {
    const spotify = await SpotifyClient.forUser(userId);
    for (const outside of outsideTargets) {
      if (!outside.spotifyPlaylistId) continue;
      const state = await spotify.getTargetPlaylistState(outside.spotifyPlaylistId);
      if (!state.snapshotId) {
        throw new Error("Snapshot de outro destino indisponível; geração bloqueada.");
      }
      reservedTargetSnapshots[outside.spotifyPlaylistId] = state.snapshotId;
      const sharingPolicy = resolveEffectiveSharingPolicy(
        outside.sharingPolicy,
        user.defaultTargetSharingPolicy ?? LEGACY_GLOBAL_SHARING_POLICY,
      );
      for (const item of state.items) {
        if (!item.uri) continue;
        (externalReservationsByUri[item.uri] ??= []).push({
          targetPlaylistId: outside.id,
          sharingPolicy,
        });
      }
    }
  }

  return {
    kind: "READY",
    targetId,
    options: {
      preservedByTargetId: { [targetId]: prepared.preserved },
      keepFilledByTargetId: { [targetId]: prepared.patch },
      scheduledPolicyByTargetId: { [targetId]: "KEEP_FILLED" },
      externalReservationsByUri,
      reservedTargetSnapshots,
    },
  };
}

/**
 * Calendar KEEP/SKIP is a deliberate no-change result, not a successful
 * generation or approval of a Reserve simulation. Persist an audit record so
 * the simulation/review UI can explain why no items were planned.
 */
export async function recordManualKeepFilledNoop(input: {
  userId: string;
  targetId: string;
  simulate: boolean;
  reason: "EMPTY_CALENDAR_KEEP" | "EMPTY_CALENDAR_SKIP";
}): Promise<{ runId: string; status: "SUCCESS"; noop: true; noopReason: string }> {
  const reason = input.reason === "EMPTY_CALENDAR_KEEP"
    ? "CALENDAR_EMPTY_KEEP"
    : "CALENDAR_EMPTY_SKIP";
  const run = await prisma.generationRun.create({
    data: {
      userId: input.userId,
      trigger: input.simulate ? "SIMULATION" : "MANUAL",
      simulation: input.simulate,
      status: "SUCCESS",
      summary: {
        simulate: input.simulate,
        targetScope: [input.targetId],
        resolvedTargetIds: [input.targetId],
        qualityPassed: false,
        collectionComplete: false,
        inconclusive: false,
        manualKeepFilledNoop: {
          reason,
          sourceCollectionSkipped: true,
          spotifyWrites: false,
          realRunApprovalEligible: false,
        },
        calendarSkippedTargets: [{ targetPlaylistId: input.targetId, reason }],
        targets: [],
      } as Prisma.InputJsonValue,
    },
  });
  return { runId: run.id, status: "SUCCESS", noop: true, noopReason: reason };
}
