import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { spotifySavedTracksPlannerCapability } from "@/services/data-policy";
import { syncLikedTracksOperationally } from "@/services/music-preference/liked-track-operational-sync";

export const LIKED_TRACK_INCREMENTAL_SYNC_POLICY = {
  version: "source-liked-operational-sync-v1",
  activationRule:
    "OPERATIONAL_MODE_ACTIVE_AND_SOURCE_CAPABILITY_AND_MASTER_FLAG_AND_USER_ALLOWLIST",
  mode: "OPERATIONAL_TRACK_ONLY_APPLY",
  providerWrite: false,
  plannerInfluence: false,
  affinityWrites: false,
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
  status: "SUCCESS" | "NOOP" | "FAILED";
  strategy?: "BASELINE" | "INCREMENTAL";
  providerCalls: number;
  pagesRead: number;
  newRows: number;
  newCanonicalRows: number;
  tracksCreated: number;
  tracksReactivated: number;
  metadataUpdated: number;
  plannerReadyAvailable?: number;
  blockedAvailableTracks?: number;
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
    input.sourceCapabilityAllowed ?? spotifySavedTracksPlannerCapability().allowed;
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
  const allowed = parseEmailAllowlist(input.allowlistedEmails);
  if (!allowed.includes(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED" };
  }
  return { enabled: true, reason: "ENABLED" };
}

/**
 * Operational SOURCE-LIKED runner.
 *
 * #278 permits Spotify Saved Tracks as a direct OPERATIONAL_PLANNING /
 * PLANNER_ELIGIBILITY candidate pool while behavioral analytics and user
 * profiling remain blocked. The additional OPERATIONAL_SYNC_MODE gate defaults
 * fail-closed so deploying this code cannot rehydrate provider data until the
 * post-deploy PREVIEW has been reviewed explicitly.
 */
export async function runLikedTrackIncrementalSyncJob(): Promise<
  LikedTrackIncrementalJobResult[]
> {
  if (!operationalApplyEnabled(process.env.LIKED_TRACK_OPERATIONAL_SYNC_MODE)) {
    return [];
  }

  const sourceCapability = spotifySavedTracksPlannerCapability();
  if (!sourceCapability.allowed) return [];
  if (!parseBoolean(process.env.LIKED_TRACK_INCREMENTAL_SYNC_ENABLED)) return [];

  const rolloutEmails = parseEmailAllowlist(
    process.env.LIKED_TRACK_INCREMENTAL_SYNC_USER_EMAILS,
  );
  if (rolloutEmails.length === 0) return [];

  const users = (
    await prisma.user.findMany({
      where: { email: { in: rolloutEmails } },
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
      const report = await syncLikedTracksOperationally(user.id, { mode: "APPLY" });
      const changed =
        report.planned.tracksToCreate > 0 ||
        report.planned.tracksToReactivate > 0 ||
        report.planned.trackMetadataUpdates > 0;
      const result: LikedTrackIncrementalJobResult = {
        userId: user.id,
        email: user.email,
        status: changed ? "SUCCESS" : "NOOP",
        strategy: report.strategy,
        providerCalls: report.provider.providerCalls,
        pagesRead: report.provider.pagesRead,
        newRows: report.provider.newRows,
        newCanonicalRows: report.provider.newCanonicalRows,
        tracksCreated: report.planned.tracksToCreate,
        tracksReactivated: report.planned.tracksToReactivate,
        metadataUpdated: report.planned.trackMetadataUpdates,
        plannerReadyAvailable: report.sourceProjection.counts.plannerReadyAvailable,
        blockedAvailableTracks:
          report.sourceProjection.plannerMaterialization.blockedAvailableTracks,
      };
      results.push(result);
      console.info("[SOURCE-LIKED-01][operational-sync]", JSON.stringify(result));
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
      console.error("[SOURCE-LIKED-01][operational-sync]", JSON.stringify(result));
    }
  }

  return results;
}

function operationalApplyEnabled(value: string | null | undefined): boolean {
  return String(value ?? "").trim().toUpperCase() === "ACTIVE";
}

function parseBoolean(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseEmailAllowlist(value: string | null | undefined): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map(normalizeEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}
