import type { DataLineage } from "../data-policy/provenance";

/**
 * MUSIC-IDENTITY-01 Gate 2A/2E.
 *
 * Pure contracts only. Nothing in this module reads provider data, queries the
 * database or changes planner behavior. The resolver itself belongs to a later
 * gate.
 */

export const GLOBAL_PROVIDER_SCOPE = "global" as const;

export const IDENTITY_RESOLUTION_STATUSES = [
  "MATCH",
  "NEW",
  "AMBIGUOUS",
  "REJECTED",
] as const;

export type IdentityResolutionStatus =
  (typeof IDENTITY_RESOLUTION_STATUSES)[number];

export const IDENTITY_MATCH_REASONS = [
  "SINGLETON_BOOTSTRAP",
  "EXACT_PROVIDER_ALIAS",
  "SAME_ISRC",
  "SAME_RECORDING_HIGH_CONFIDENCE",
  "SAME_SONG_DIFFERENT_RECORDING",
  "TEXTUAL_POSSIBLE_MATCH",
  "MANUAL_LINK",
  "AMBIGUOUS",
  "REJECTED",
] as const;

export type IdentityMatchReason = (typeof IDENTITY_MATCH_REASONS)[number];

export const TRACK_PROVIDER_EXECUTION_STATUSES = [
  "KNOWN",
  "EXECUTABLE",
  "UNAVAILABLE",
] as const;

export type TrackProviderExecutionStatus =
  (typeof TRACK_PROVIDER_EXECUTION_STATUSES)[number];

export type IdentityResolutionAudit = Readonly<{
  status: IdentityResolutionStatus;
  reason: IdentityMatchReason;
  confidenceBasisPoints: number;
  lineage: DataLineage;
}>;

export type ProviderRefAssociation = Readonly<{
  userId: string;
  provider: string;
  providerScope: string;
  providerEntityId: string;
  canonicalIdentityId: string;
}>;

export type TrackProviderExecutionShape = Readonly<{
  executionStatus: TrackProviderExecutionStatus;
  providerTrackId: string;
  uri: string | null | undefined;
}>;

/** Provider names are case-insensitive contract keys, not display labels. */
export function normalizeProviderKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Provider key must not be empty.");
  return normalized;
}

/**
 * Provider scope is a Sonoriza-owned namespace key, not an opaque provider ID.
 * Current Spotify references use "global". Lower-casing here is therefore safe
 * and keeps future namespace labels deterministic (for example market:br).
 */
export function normalizeProviderScope(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Provider scope must not be empty.");
  return normalized;
}

/**
 * External IDs are trimmed but otherwise preserved. Some providers use
 * case-sensitive identifiers, so lower-casing them would be destructive.
 */
export function normalizeProviderEntityId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Provider entity ID must not be empty.");
  return normalized;
}

/**
 * ISRC is normalized only as evidence. A matching ISRC is never, by itself, a
 * command to merge canonical identities.
 */
export function normalizeIsrcEvidence(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ?? "";
  return normalized || null;
}

export function assertConfidenceBasisPoints(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("Identity confidence must be an integer from 0 to 10000 basis points.");
  }
  return value;
}

/**
 * Natural keys are user- and provider-scope-scoped in v1. The same provider
 * identifier observed by two Sonoriza users, or under two explicit provider
 * namespaces, therefore does not imply a shared canonical identity.
 */
export function providerRefNaturalKey(input: {
  userId: string;
  provider: string;
  providerScope: string;
  providerEntityId: string;
}): string {
  const userId = input.userId.trim();
  if (!userId) throw new Error("User ID must not be empty.");

  return JSON.stringify([
    userId,
    normalizeProviderKey(input.provider),
    normalizeProviderScope(input.providerScope),
    normalizeProviderEntityId(input.providerEntityId),
  ]);
}

/**
 * A canonical RecordingIdentity is not sufficient for playback. A provider ref
 * is executable only when the execution contract explicitly says so and a
 * concrete provider ID + URI are both present.
 *
 * Spotify-specific stable-ID/URI validation remains at the existing Spotify
 * execution boundary; this provider-neutral check does not replace it.
 */
export function isExecutableTrackProviderRef(
  ref: TrackProviderExecutionShape,
): boolean {
  return Boolean(
    ref.executionStatus === "EXECUTABLE" &&
      ref.providerTrackId.trim() &&
      ref.uri?.trim(),
  );
}

/**
 * Existing provider-ref associations are immutable. Re-associating a ref to
 * another canonical entity, provider namespace or external ID must use a future
 * explicit merge/split operation with audit evidence; a normal update must not
 * silently move it.
 */
export function assertProviderRefAssociationStable(
  current: ProviderRefAssociation,
  next: ProviderRefAssociation,
): void {
  const currentNaturalKey = providerRefNaturalKey({
    userId: current.userId,
    provider: current.provider,
    providerScope: current.providerScope,
    providerEntityId: current.providerEntityId,
  });
  const nextNaturalKey = providerRefNaturalKey({
    userId: next.userId,
    provider: next.provider,
    providerScope: next.providerScope,
    providerEntityId: next.providerEntityId,
  });

  if (currentNaturalKey !== nextNaturalKey) {
    throw new Error("Provider-ref natural key is immutable.");
  }

  if (current.canonicalIdentityId !== next.canonicalIdentityId) {
    throw new Error(
      "Provider-ref canonical association requires an explicit merge/split operation.",
    );
  }
}

/**
 * Gate 2B may bootstrap provider refs as singleton canonical entities. This
 * deliberately prefers temporary duplicate identities over an unsafe merge.
 */
export function singletonBootstrapResolution(
  lineage: DataLineage,
): IdentityResolutionAudit {
  return {
    status: "NEW",
    reason: "SINGLETON_BOOTSTRAP",
    confidenceBasisPoints: 10_000,
    lineage,
  };
}
