import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { readConfigurationFingerprint } from "@/services/configuration-readiness";
import type { PlaybackReserveTargetShadowEvidence } from "@/services/playlist-planner/plan-run-playback-reserve";

export type PlaybackReserveGate7Mode = "OFF" | "SHADOW" | "ACTIVE";

export type PlaybackReserveGate7Runtime = Readonly<{
  gate: 7;
  requestedMode: PlaybackReserveGate7Mode | "INVALID";
  effectiveMode: PlaybackReserveGate7Mode;
  activeTargetIds: ReadonlySet<string>;
  status:
    | "OFF"
    | "READY_SHADOW"
    | "READY_ACTIVE"
    | "ABSTAIN_ACTIVE_TARGET_ALLOWLIST_EMPTY"
    | "ABSTAIN_INVALID_MODE";
}>;

export type PlaybackReserveGate7SimulationEvidence = Readonly<{
  simulationRunId: string;
  configurationFingerprint: string;
  targetPlaylistId: string;
  projectionFingerprint: string;
}>;

export function playbackReserveGate7RuntimeFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlaybackReserveGate7Runtime {
  const raw = env.PLAYBACK_RESERVE_RUNTIME_MODE?.trim().toUpperCase() || "SHADOW";
  const requestedMode =
    raw === "OFF" || raw === "SHADOW" || raw === "ACTIVE" ? raw : "INVALID";
  const activeTargetIds = new Set(
    (env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS ?? "")
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (requestedMode === "INVALID") {
    return Object.freeze({
      gate: 7 as const,
      requestedMode,
      effectiveMode: "OFF" as const,
      activeTargetIds,
      status: "ABSTAIN_INVALID_MODE" as const,
    });
  }
  if (requestedMode === "OFF") {
    return Object.freeze({
      gate: 7 as const,
      requestedMode,
      effectiveMode: "OFF" as const,
      activeTargetIds,
      status: "OFF" as const,
    });
  }
  if (requestedMode === "ACTIVE" && activeTargetIds.size === 0) {
    return Object.freeze({
      gate: 7 as const,
      requestedMode,
      effectiveMode: "SHADOW" as const,
      activeTargetIds,
      status: "ABSTAIN_ACTIVE_TARGET_ALLOWLIST_EMPTY" as const,
    });
  }

  return Object.freeze({
    gate: 7 as const,
    requestedMode,
    effectiveMode: requestedMode,
    activeTargetIds,
    status: requestedMode === "ACTIVE" ? "READY_ACTIVE" : "READY_SHADOW",
  });
}

export function playbackReserveGate7TargetIsActive(
  runtime: PlaybackReserveGate7Runtime,
  targetPlaylistId: string,
): boolean {
  return (
    runtime.effectiveMode === "ACTIVE" &&
    runtime.activeTargetIds.has(targetPlaylistId.trim())
  );
}

/**
 * Stable proof for one target's exact reserve projection. It deliberately binds
 * the effective policy, PRIMARY projection identity and ordered RESERVE suffix.
 * A real Gate 7 write must match a current approved simulation byte-for-byte at
 * this semantic level; otherwise RESERVE abstains and must be simulated again.
 */
export function playbackReserveGate7ProjectionFingerprint(
  target: PlaybackReserveTargetShadowEvidence | unknown,
): string | null {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const row = target as Record<string, unknown>;
  const targetPlaylistId = stringValue(row.targetPlaylistId);
  const policy = objectValue(row.policy);
  const primary = objectValue(row.primary);
  const reserve = objectValue(row.reserve);
  if (!targetPlaylistId || !policy || !primary || !reserve) return null;
  if (stringValue(policy.reserveMode) === "NONE") return null;

  const selectedRaw = Array.isArray(reserve.selectedItems)
    ? reserve.selectedItems
    : null;
  if (!selectedRaw) return null;

  const selectedItems = selectedRaw.map((value) => {
    const item = objectValue(value);
    if (!item) return null;
    const uri = stringValue(item.uri);
    const type = stringValue(item.type);
    const durationMs = numberValue(item.durationMs);
    if (!uri || (type !== "MUSIC" && type !== "PODCAST") || durationMs === null) {
      return null;
    }
    return {
      uri,
      type,
      durationMs,
      spotifyTrackId: stringValue(item.spotifyTrackId),
      spotifyEpisodeId: stringValue(item.spotifyEpisodeId),
      programId: stringValue(item.programId),
    };
  });
  if (selectedItems.some((item) => item === null)) return null;

  const payload = {
    targetPlaylistId,
    policy: {
      source: stringValue(policy.source),
      reserveMode: stringValue(policy.reserveMode),
      durationSeconds: numberValue(policy.durationSeconds),
      musicTrackCount: numberValue(policy.musicTrackCount),
      podcastEpisodeCount: numberValue(policy.podcastEpisodeCount),
      podcastInDurationReserve: stringValue(policy.podcastInDurationReserve),
    },
    primary: {
      itemCount: numberValue(primary.itemCount),
      totalDurationMs: numberValue(primary.totalDurationMs),
      orderHash: stringValue(primary.orderHash),
    },
    reserve: {
      startsAtPosition: numberValue(reserve.startsAtPosition),
      selectedItems,
    },
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function findReusablePlaybackReserveSimulationEvidence(
  userId: string,
  configurationFingerprint: string,
  targetPlaylistIds: readonly string[],
): Promise<ReadonlyMap<string, PlaybackReserveGate7SimulationEvidence>> {
  const targets = [...new Set(targetPlaylistIds.map((id) => id.trim()).filter(Boolean))];
  if (targets.length === 0) return new Map();

  const latestAppliedRealRun = await prisma.generationRun.findFirst({
    where: {
      userId,
      simulation: false,
      status: { in: ["SUCCESS", "PARTIAL"] },
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  const simulations = await prisma.generationRun.findMany({
    where: {
      userId,
      simulation: true,
      status: "SUCCESS",
      ...(latestAppliedRealRun
        ? { startedAt: { gt: latestAppliedRealRun.startedAt } }
        : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: { id: true, summary: true },
  });

  for (const simulation of simulations) {
    if (!summaryQualityPassed(simulation.summary)) continue;
    if (
      readConfigurationFingerprint(simulation.summary) !== configurationFingerprint
    ) {
      continue;
    }

    const projectionByTarget = projectionFingerprintsFromSummary(simulation.summary);
    if (!targets.every((targetId) => projectionByTarget.has(targetId))) continue;

    return new Map(
      targets.map((targetPlaylistId) => [
        targetPlaylistId,
        Object.freeze({
          simulationRunId: simulation.id,
          configurationFingerprint,
          targetPlaylistId,
          projectionFingerprint: projectionByTarget.get(targetPlaylistId)!,
        }),
      ]),
    );
  }

  return new Map();
}

export function projectionFingerprintsFromSummary(
  summary: unknown,
): ReadonlyMap<string, string> {
  const root = objectValue(summary);
  const shadow = objectValue(root?.playbackReserveShadow);
  const targets = Array.isArray(shadow?.targets) ? shadow.targets : [];
  const result = new Map<string, string>();

  for (const raw of targets) {
    const target = objectValue(raw);
    const targetPlaylistId = stringValue(target?.targetPlaylistId);
    if (!targetPlaylistId) continue;
    const fingerprint = playbackReserveGate7ProjectionFingerprint(raw);
    if (fingerprint) result.set(targetPlaylistId, fingerprint);
  }
  return result;
}

function summaryQualityPassed(summary: unknown): boolean {
  const row = objectValue(summary);
  return row?.qualityPassed === true;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
