import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { spotifySavedTracksProfileMaterializationCapability } from "@/services/data-policy";
import { syncLikedTrackIncremental } from "@/services/music-preference/liked-track-incremental-sync";

export const LIKED_TRACK_INCREMENTAL_SYNC_POLICY = {
  version: "source-liked-gate5c-v1",
  activationRule: "SOURCE_CAPABILITY_AND_MASTER_FLAG_AND_USER_ALLOWLIST",
  mode: "LOCAL_CANONICAL_APPLY",
  providerWrite: false,
  plannerInfluence: false,
} as const;

export type LikedTrackIncrementalSyncPolicyReason =
  | "SOURCE_CAPABILITY_BLOCKED"
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

export type LikedTrackIncrementalJobResult = {
  userId: string;
  email: string;
  status: "SUCCESS" | "NOOP" | "BASELINE_REQUIRED" | "FAILED";
  providerCalls: number;
  pagesRead: number;
  newRows: number;
  newCanonicalRows: number;
  tracksCreated: number;
  tracksReactivated: number;
  metadataUpdated: number;
  error?: string;
};

export function resolveLikedTrackIncrementalSyncPolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  sourceCapabilityAllowed?: boolean;
}): {
  enabled: boolean;
  reason: LikedTrackIncrementalSyncPolicyReason;
} {
  const sourceCapabilityAllowed =
    input.sourceCapabilityAllowed ??
    spotifySavedTracksProfileMaterializationCapability().allowed;
  if (!sourceCapabilityAllowed) {
    return { enabled: false, reason: "SOURCE_CAPABILITY_BLOCKED" };
  }
  if (!parseBoolean(input.masterEnabled)) {
    return { enabled: false, reason: "MASTER_DISABLED" };
  }
  const email = normalizeEmail(input.userEmail);
  if (!email) {
    return { enabled: false, reason: "USER_EMAIL_MISSING" };
  }
  const allowed = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!allowed.has(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED" };
  }
  return { enabled: true, reason: "ENABLED" };
}

/**
 * Gate 5C cron runner. The Saved Tracks capability is evaluated before the
 * feature flag, user enumeration and provider access. Under the current matrix
 * this returns no work because Saved Tracks is DENY for behavioral analytics
 * and user profiling. The legacy rollout controls remain available only after
 * the source capability itself becomes explicitly ALLOW.
 */
export async function runLikedTrackIncrementalSyncJob(): Promise<
  LikedTrackIncrementalJobResult[]
> {
  const sourceCapability = spotifySavedTracksProfileMaterializationCapability();
  if (!sourceCapability.allowed) {
    return [];
  }
  if (!parseBoolean(process.env.LIKED_TRACK_INCREMENTAL_SYNC_ENABLED)) {
    return [];
  }

  const users = (
    await prisma.user.findMany({
      where: { likedTrackPreferences: { some: {} } },
      select: { id: true, email: true },
      orderBy: { id: "asc" },
    })
  ).filter((user) => isEmailAllowed(user.email));

  const results: LikedTrackIncrementalJobResult[] = [];
  for (const user of users) {
    const policy = resolveLikedTrackIncrementalSyncPolicy({
      userEmail: user.email,
      masterEnabled: process.env.LIKED_TRACK_INCREMENTAL_SYNC_ENABLED,
      allowlistedEmails: process.env.LIKED_TRACK_INCREMENTAL_SYNC_USER_EMAILS,
      sourceCapabilityAllowed: sourceCapability.allowed,
    });
    if (!policy.enabled || !user.email) continue;

    try {
      const report = await syncLikedTrackIncremental(user.id, { mode: "APPLY" });
      const status =
        report.status === "BASELINE_REQUIRED"
          ? "BASELINE_REQUIRED"
          : report.provider.newRows > 0
            ? "SUCCESS"
            : "NOOP";
      const result: LikedTrackIncrementalJobResult = {
        userId: user.id,
        email: user.email,
        status,
        providerCalls: report.provider.providerCalls,
        pagesRead: report.provider.pagesRead,
        newRows: report.provider.newRows,
        newCanonicalRows: report.provider.newCanonicalRows,
        tracksCreated: report.planned.tracksToCreate,
        tracksReactivated: report.planned.tracksToReactivate,
        metadataUpdated: report.planned.trackMetadataUpdates,
      };
      results.push(result);
      console.info("[SOURCE-LIKED-01][incremental-sync]", JSON.stringify(result));
    } catch (error) {
      const result: LikedTrackIncrementalJobResult = {
        userId: user.id,
        email: user.email,
        status: "FAILED",
        providerCalls: 0,
        pagesRead: 0,
        newRows: 0,
        newCanonicalRows: 0,
        tracksCreated: 0,
        tracksReactivated: 0,
        metadataUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      console.error("[SOURCE-LIKED-01][incremental-sync]", JSON.stringify(result));
    }
  }

  return results;
}

function parseBoolean(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}
