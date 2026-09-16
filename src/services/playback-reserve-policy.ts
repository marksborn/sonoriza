import { prisma } from "@/lib/prisma";

export type PlaybackReserveModeValue =
  | "NONE"
  | "DURATION"
  | "MUSIC_TRACKS"
  | "PODCAST_EPISODES";

export type PlaybackReservePodcastModeValue = "DISABLED" | "IF_FITS";

export type TargetPlaybackReservePolicyModeValue =
  | "INHERIT_GLOBAL"
  | "OVERRIDE";

export type GenerationPlanRoleValue = "PRIMARY" | "RESERVE";

export type PlaybackReservePolicyInput = Readonly<{
  reserveMode: PlaybackReserveModeValue;
  durationSeconds?: number | null;
  musicTrackCount?: number | null;
  podcastEpisodeCount?: number | null;
  podcastInDurationReserve?: PlaybackReservePodcastModeValue | null;
}>;

export type PlaybackReservePolicySnapshot = Readonly<{
  reserveMode: PlaybackReserveModeValue;
  durationSeconds: number | null;
  musicTrackCount: number | null;
  podcastEpisodeCount: number | null;
  podcastInDurationReserve: PlaybackReservePodcastModeValue;
}>;

export type TargetPlaybackReservePolicyInput = Readonly<{
  policyMode: TargetPlaybackReservePolicyModeValue;
  reserveMode?: PlaybackReserveModeValue | null;
  durationSeconds?: number | null;
  musicTrackCount?: number | null;
  podcastEpisodeCount?: number | null;
  podcastInDurationReserve?: PlaybackReservePodcastModeValue | null;
}>;

export type TargetPlaybackReservePolicySnapshot = Readonly<{
  targetPlaylistId: string;
  policyMode: TargetPlaybackReservePolicyModeValue;
  reserveMode: PlaybackReserveModeValue | null;
  durationSeconds: number | null;
  musicTrackCount: number | null;
  podcastEpisodeCount: number | null;
  podcastInDurationReserve: PlaybackReservePodcastModeValue | null;
}>;

export type EffectivePlaybackReservePolicySnapshot = Readonly<{
  targetPlaylistId: string;
  source: "GLOBAL" | "TARGET_OVERRIDE";
  reserveMode: PlaybackReserveModeValue;
  durationSeconds: number | null;
  musicTrackCount: number | null;
  podcastEpisodeCount: number | null;
  podcastInDurationReserve: PlaybackReservePodcastModeValue;
}>;

export const DEFAULT_PLAYBACK_RESERVE_POLICY = Object.freeze({
  reserveMode: "NONE" as const,
  durationSeconds: null,
  musicTrackCount: null,
  podcastEpisodeCount: null,
  podcastInDurationReserve: "DISABLED" as const,
});

export const DEFAULT_GENERATION_PLAN_ROLE: GenerationPlanRoleValue = "PRIMARY";

/**
 * PLAYBACK-RESERVE-01 Gate 1 contract.
 *
 * Gate 1 persists configuration only. Nothing in the planner imports this
 * service yet and GenerationItem is deliberately unchanged. Missing global
 * configuration is NONE; missing target configuration inherits global.
 */
export function normalizePlaybackReservePolicy(
  input: PlaybackReservePolicyInput,
): PlaybackReservePolicySnapshot {
  assertReserveMode(input.reserveMode);

  const podcastMode = input.podcastInDurationReserve ?? "DISABLED";
  assertPodcastMode(podcastMode);

  switch (input.reserveMode) {
    case "NONE":
      assertAbsent(input.durationSeconds, "durationSeconds", "NONE");
      assertAbsent(input.musicTrackCount, "musicTrackCount", "NONE");
      assertAbsent(input.podcastEpisodeCount, "podcastEpisodeCount", "NONE");
      assertPodcastDisabled(podcastMode, "NONE");
      return Object.freeze({ ...DEFAULT_PLAYBACK_RESERVE_POLICY });

    case "DURATION":
      assertPositiveInteger(input.durationSeconds, "durationSeconds");
      assertAbsent(input.musicTrackCount, "musicTrackCount", "DURATION");
      assertAbsent(
        input.podcastEpisodeCount,
        "podcastEpisodeCount",
        "DURATION",
      );
      return Object.freeze({
        reserveMode: "DURATION",
        durationSeconds: Number(input.durationSeconds),
        musicTrackCount: null,
        podcastEpisodeCount: null,
        podcastInDurationReserve: podcastMode,
      });

    case "MUSIC_TRACKS":
      assertAbsent(input.durationSeconds, "durationSeconds", "MUSIC_TRACKS");
      assertPositiveInteger(input.musicTrackCount, "musicTrackCount");
      assertAbsent(
        input.podcastEpisodeCount,
        "podcastEpisodeCount",
        "MUSIC_TRACKS",
      );
      assertPodcastDisabled(podcastMode, "MUSIC_TRACKS");
      return Object.freeze({
        reserveMode: "MUSIC_TRACKS",
        durationSeconds: null,
        musicTrackCount: Number(input.musicTrackCount),
        podcastEpisodeCount: null,
        podcastInDurationReserve: "DISABLED",
      });

    case "PODCAST_EPISODES":
      assertAbsent(
        input.durationSeconds,
        "durationSeconds",
        "PODCAST_EPISODES",
      );
      assertAbsent(
        input.musicTrackCount,
        "musicTrackCount",
        "PODCAST_EPISODES",
      );
      assertPositiveInteger(input.podcastEpisodeCount, "podcastEpisodeCount");
      assertPodcastDisabled(podcastMode, "PODCAST_EPISODES");
      return Object.freeze({
        reserveMode: "PODCAST_EPISODES",
        durationSeconds: null,
        musicTrackCount: null,
        podcastEpisodeCount: Number(input.podcastEpisodeCount),
        podcastInDurationReserve: "DISABLED",
      });
  }
}

export function defaultPlaybackReservePolicy(): PlaybackReservePolicySnapshot {
  return Object.freeze({ ...DEFAULT_PLAYBACK_RESERVE_POLICY });
}

export function normalizeTargetPlaybackReservePolicy(
  targetPlaylistId: string,
  input: TargetPlaybackReservePolicyInput,
): TargetPlaybackReservePolicySnapshot {
  const normalizedTargetId = normalizedRequiredId(
    targetPlaylistId,
    "targetPlaylistId",
  );

  if (input.policyMode === "INHERIT_GLOBAL") {
    assertTargetOverrideFieldsAbsent(input);
    return Object.freeze({
      targetPlaylistId: normalizedTargetId,
      policyMode: "INHERIT_GLOBAL",
      reserveMode: null,
      durationSeconds: null,
      musicTrackCount: null,
      podcastEpisodeCount: null,
      podcastInDurationReserve: null,
    });
  }

  if (input.policyMode !== "OVERRIDE") {
    throw new Error("policyMode must be INHERIT_GLOBAL or OVERRIDE.");
  }

  if (!input.reserveMode) {
    throw new Error("reserveMode is required when policyMode is OVERRIDE.");
  }

  const override = normalizePlaybackReservePolicy({
    reserveMode: input.reserveMode,
    durationSeconds: input.durationSeconds,
    musicTrackCount: input.musicTrackCount,
    podcastEpisodeCount: input.podcastEpisodeCount,
    podcastInDurationReserve: input.podcastInDurationReserve,
  });

  return Object.freeze({
    targetPlaylistId: normalizedTargetId,
    policyMode: "OVERRIDE",
    ...override,
  });
}

export function defaultTargetPlaybackReservePolicy(
  targetPlaylistId: string,
): TargetPlaybackReservePolicySnapshot {
  return normalizeTargetPlaybackReservePolicy(targetPlaylistId, {
    policyMode: "INHERIT_GLOBAL",
  });
}

export function resolveEffectivePlaybackReservePolicy(
  targetPlaylistId: string,
  globalPolicy: PlaybackReservePolicySnapshot,
  targetPolicy: TargetPlaybackReservePolicySnapshot,
): EffectivePlaybackReservePolicySnapshot {
  const normalizedTargetId = normalizedRequiredId(
    targetPlaylistId,
    "targetPlaylistId",
  );

  if (targetPolicy.targetPlaylistId !== normalizedTargetId) {
    throw new Error("Target policy does not match targetPlaylistId.");
  }

  if (targetPolicy.policyMode === "INHERIT_GLOBAL") {
    return Object.freeze({
      targetPlaylistId: normalizedTargetId,
      source: "GLOBAL",
      ...normalizePlaybackReservePolicy(globalPolicy),
    });
  }

  if (!targetPolicy.reserveMode || !targetPolicy.podcastInDurationReserve) {
    throw new Error("Target override is incomplete.");
  }

  const override = normalizePlaybackReservePolicy({
    reserveMode: targetPolicy.reserveMode,
    durationSeconds: targetPolicy.durationSeconds,
    musicTrackCount: targetPolicy.musicTrackCount,
    podcastEpisodeCount: targetPolicy.podcastEpisodeCount,
    podcastInDurationReserve: targetPolicy.podcastInDurationReserve,
  });

  return Object.freeze({
    targetPlaylistId: normalizedTargetId,
    source: "TARGET_OVERRIDE",
    ...override,
  });
}

/**
 * Stable semantic fragment reserved for the later fingerprint gate.
 * Gate 1 intentionally does NOT wire this into the generation fingerprint,
 * because the persisted policy cannot influence a plan yet.
 */
export function playbackReserveFingerprintFragment(
  policy: PlaybackReservePolicySnapshot | EffectivePlaybackReservePolicySnapshot,
) {
  return Object.freeze({
    reserveMode: policy.reserveMode,
    durationSeconds: policy.durationSeconds,
    musicTrackCount: policy.musicTrackCount,
    podcastEpisodeCount: policy.podcastEpisodeCount,
    podcastInDurationReserve: policy.podcastInDurationReserve,
  });
}

export function normalizeGenerationPlanRole(
  role: GenerationPlanRoleValue | null | undefined,
): GenerationPlanRoleValue {
  if (role == null) return DEFAULT_GENERATION_PLAN_ROLE;
  if (role !== "PRIMARY" && role !== "RESERVE") {
    throw new Error("Generation plan role must be PRIMARY or RESERVE.");
  }
  return role;
}

export async function loadPlaybackReservePolicy(
  userId: string,
): Promise<PlaybackReservePolicySnapshot> {
  const normalizedUserId = normalizedRequiredId(userId, "userId");
  const row = await prisma.playbackReservePolicy.findUnique({
    where: { userId: normalizedUserId },
  });

  if (!row) return defaultPlaybackReservePolicy();

  return normalizePlaybackReservePolicy({
    reserveMode: row.reserveMode,
    durationSeconds: row.durationSeconds,
    musicTrackCount: row.musicTrackCount,
    podcastEpisodeCount: row.podcastEpisodeCount,
    podcastInDurationReserve: row.podcastInDurationReserve,
  });
}

export async function savePlaybackReservePolicy(
  userId: string,
  input: PlaybackReservePolicyInput,
): Promise<PlaybackReservePolicySnapshot> {
  const normalizedUserId = normalizedRequiredId(userId, "userId");
  const resolved = normalizePlaybackReservePolicy(input);

  await assertUserExists(normalizedUserId);

  await prisma.playbackReservePolicy.upsert({
    where: { userId: normalizedUserId },
    create: {
      userId: normalizedUserId,
      ...resolved,
    },
    update: resolved,
  });

  return resolved;
}

export async function loadTargetPlaybackReservePolicy(
  userId: string,
  targetPlaylistId: string,
): Promise<TargetPlaybackReservePolicySnapshot> {
  const normalizedUserId = normalizedRequiredId(userId, "userId");
  const normalizedTargetId = normalizedRequiredId(
    targetPlaylistId,
    "targetPlaylistId",
  );

  await assertOwnedTarget(normalizedUserId, normalizedTargetId);

  const row = await prisma.targetPlaybackReservePolicy.findUnique({
    where: {
      userId_targetPlaylistId: {
        userId: normalizedUserId,
        targetPlaylistId: normalizedTargetId,
      },
    },
  });

  if (!row) return defaultTargetPlaybackReservePolicy(normalizedTargetId);

  return normalizeTargetPlaybackReservePolicy(normalizedTargetId, {
    policyMode: row.policyMode,
    reserveMode: row.reserveMode,
    durationSeconds: row.durationSeconds,
    musicTrackCount: row.musicTrackCount,
    podcastEpisodeCount: row.podcastEpisodeCount,
    podcastInDurationReserve: row.podcastInDurationReserve,
  });
}

export async function saveTargetPlaybackReservePolicy(
  userId: string,
  targetPlaylistId: string,
  input: TargetPlaybackReservePolicyInput,
): Promise<TargetPlaybackReservePolicySnapshot> {
  const normalizedUserId = normalizedRequiredId(userId, "userId");
  const resolved = normalizeTargetPlaybackReservePolicy(targetPlaylistId, input);

  await assertOwnedTarget(normalizedUserId, resolved.targetPlaylistId);

  const persisted = {
    policyMode: resolved.policyMode,
    reserveMode: resolved.reserveMode,
    durationSeconds: resolved.durationSeconds,
    musicTrackCount: resolved.musicTrackCount,
    podcastEpisodeCount: resolved.podcastEpisodeCount,
    podcastInDurationReserve: resolved.podcastInDurationReserve,
  };

  await prisma.targetPlaybackReservePolicy.upsert({
    where: {
      userId_targetPlaylistId: {
        userId: normalizedUserId,
        targetPlaylistId: resolved.targetPlaylistId,
      },
    },
    create: {
      userId: normalizedUserId,
      targetPlaylistId: resolved.targetPlaylistId,
      ...persisted,
    },
    update: persisted,
  });

  return resolved;
}

export async function loadEffectivePlaybackReservePolicy(
  userId: string,
  targetPlaylistId: string,
): Promise<EffectivePlaybackReservePolicySnapshot> {
  const [globalPolicy, targetPolicy] = await Promise.all([
    loadPlaybackReservePolicy(userId),
    loadTargetPlaybackReservePolicy(userId, targetPlaylistId),
  ]);

  return resolveEffectivePlaybackReservePolicy(
    targetPlaylistId,
    globalPolicy,
    targetPolicy,
  );
}

async function assertUserExists(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) throw new Error("User does not exist.");
}

async function assertOwnedTarget(userId: string, targetPlaylistId: string) {
  const target = await prisma.targetPlaylist.findFirst({
    where: {
      id: targetPlaylistId,
      userId,
    },
    select: { id: true },
  });

  if (!target) {
    throw new Error(
      "Target playlist does not exist or does not belong to the user.",
    );
  }
}

function assertTargetOverrideFieldsAbsent(input: TargetPlaybackReservePolicyInput) {
  for (const [label, value] of [
    ["reserveMode", input.reserveMode],
    ["durationSeconds", input.durationSeconds],
    ["musicTrackCount", input.musicTrackCount],
    ["podcastEpisodeCount", input.podcastEpisodeCount],
    ["podcastInDurationReserve", input.podcastInDurationReserve],
  ] as const) {
    if (value != null) {
      throw new Error(`${label} must be absent when policyMode is INHERIT_GLOBAL.`);
    }
  }
}

function assertReserveMode(
  value: string,
): asserts value is PlaybackReserveModeValue {
  if (
    value !== "NONE" &&
    value !== "DURATION" &&
    value !== "MUSIC_TRACKS" &&
    value !== "PODCAST_EPISODES"
  ) {
    throw new Error(
      "reserveMode must be NONE, DURATION, MUSIC_TRACKS or PODCAST_EPISODES.",
    );
  }
}

function assertPodcastMode(
  value: string,
): asserts value is PlaybackReservePodcastModeValue {
  if (value !== "DISABLED" && value !== "IF_FITS") {
    throw new Error(
      "podcastInDurationReserve must be DISABLED or IF_FITS.",
    );
  }
}

function assertPositiveInteger(
  value: number | null | undefined,
  label: string,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertAbsent(
  value: unknown,
  label: string,
  reserveMode: PlaybackReserveModeValue,
) {
  if (value != null) {
    throw new Error(`${label} must be absent for reserveMode ${reserveMode}.`);
  }
}

function assertPodcastDisabled(
  value: PlaybackReservePodcastModeValue,
  reserveMode: PlaybackReserveModeValue,
) {
  if (value !== "DISABLED") {
    throw new Error(
      `podcastInDurationReserve must be DISABLED for reserveMode ${reserveMode}.`,
    );
  }
}

function normalizedRequiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
