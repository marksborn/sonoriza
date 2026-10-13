import { prisma } from "@/lib/prisma";
import {
  loadEffectivePlaybackReservePolicy,
  type EffectivePlaybackReservePolicySnapshot,
} from "./playback-reserve-policy";

export type TargetReserveActivation = Readonly<{
  enabled: boolean;
  confirmedAt: Date | null;
}>;

export const DEFAULT_TARGET_RESERVE_ACTIVATION: TargetReserveActivation = Object.freeze({
  enabled: false,
  confirmedAt: null,
});

/** No row is ALWAYS disabled. Never infer consent from a global policy or pilot. */
export async function loadTargetReserveActivation(
  userId: string,
  targetPlaylistId: string,
): Promise<TargetReserveActivation> {
  const row = await prisma.targetPlaybackReserveActivation.findUnique({
    where: { userId_targetPlaylistId: { userId, targetPlaylistId } },
    select: { enabled: true, confirmedAt: true },
  });
  return row
    ? { enabled: row.enabled, confirmedAt: row.confirmedAt }
    : DEFAULT_TARGET_RESERVE_ACTIVATION;
}

export function canEnableTargetReserveActivation(input: Readonly<{
  enabled: boolean;
  spotifyPlaylistId: string | null;
  updatePolicy: string;
  effectivePolicy: Pick<EffectivePlaybackReservePolicySnapshot, "reserveMode">;
}>): boolean {
  return (
    input.enabled &&
    Boolean(input.spotifyPlaylistId) &&
    (input.updatePolicy === "KEEP_FILLED" || input.updatePolicy === "REBUILD_DAILY") &&
    input.effectivePolicy.reserveMode !== "NONE"
  );
}

/**
 * Explicit user opt-in/out. Does not change any Spotify playlist or schedule.
 * Each write confirms/disables just one user-owned target.
 */
export async function saveTargetReserveActivation(input: Readonly<{
  userId: string;
  targetPlaylistId: string;
  enabled: boolean;
}>): Promise<TargetReserveActivation> {
  const { userId, targetPlaylistId, enabled } = input;
  if (!userId.trim() || !targetPlaylistId.trim()) throw new Error("Missing account or destination.");

  const target = await prisma.targetPlaylist.findFirst({
    where: { userId, id: targetPlaylistId },
    select: { enabled: true, spotifyPlaylistId: true, updatePolicy: true },
  });
  if (!target) throw new Error("Target not found for account.");

  if (enabled) {
    const effectivePolicy = await loadEffectivePlaybackReservePolicy(userId, targetPlaylistId);
    if (!canEnableTargetReserveActivation({ ...target, effectivePolicy })) {
      throw new Error("Target must be enabled, linked, policy-compatible and have an explicit non-NONE Reserve rule.");
    }
  }

  const confirmedAt = enabled ? new Date() : null;
  const saved = await prisma.targetPlaybackReserveActivation.upsert({
    where: { userId_targetPlaylistId: { userId, targetPlaylistId } },
    create: { userId, targetPlaylistId, enabled, confirmedAt },
    update: { enabled, confirmedAt },
    select: { enabled: true, confirmedAt: true },
  });
  return { enabled: saved.enabled, confirmedAt: saved.confirmedAt };
}

/**
 * This switch is intentionally independent of PLAYBACK_RESERVE_RUNTIME_MODE.
 * Two gates must be ACTIVE, plus explicit persisted opt-in, before a non-pilot
 * destination can even enter the existing per-run simulation approval process.
 */
export function productReserveAuthorizationRequested(input: Readonly<{
  productMode: string | undefined;
  explicitlyScopedToSingleTarget: boolean;
  targetEnabled: boolean;
  targetLinkedToSpotify: boolean;
  policySupportsMaintenance: boolean;
  reserveMode: "NONE" | "DURATION" | "MUSIC_TRACKS" | "PODCAST_EPISODES";
  activation: TargetReserveActivation | null;
}>): boolean {
  return (
    input.productMode?.trim().toUpperCase() === "ACTIVE" &&
    input.explicitlyScopedToSingleTarget &&
    input.targetEnabled &&
    input.targetLinkedToSpotify &&
    input.policySupportsMaintenance &&
    input.reserveMode !== "NONE" &&
    input.activation?.enabled === true &&
    input.activation.confirmedAt instanceof Date &&
    !Number.isNaN(input.activation.confirmedAt.getTime())
  );
}
