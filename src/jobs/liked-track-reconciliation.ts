import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { spotifySavedTracksProfileMaterializationCapability } from "@/services/data-policy";
import {
  DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS,
  reconcileLikedTracks,
  type LikedTrackReconciliationSafetyStatus,
} from "@/services/music-preference/liked-track-reconciliation";

export const LIKED_TRACK_RECONCILIATION_POLICY = {
  version: "source-liked-gate5c-v1",
  activationRule: "SOURCE_CAPABILITY_AND_MASTER_FLAG_AND_USER_ALLOWLIST",
  scan: "FULL_SAVED_TRACKS",
  providerWrite: false,
  plannerInfluence: false,
  defaultMaxUnlikes: DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikes,
  defaultMaxUnlikePercent:
    DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikePercent,
} as const;

export type LikedTrackReconciliationPolicyReason =
  | "SOURCE_CAPABILITY_BLOCKED"
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

export type LikedTrackReconciliationJobResult = {
  userId: string;
  email: string;
  status:
    | "SUCCESS"
    | "NOOP"
    | "REVIEW_REQUIRED"
    | "BASELINE_REQUIRED"
    | "BLOCKED"
    | "FAILED";
  safetyStatus?: LikedTrackReconciliationSafetyStatus;
  providerCalls: number;
  pagesRead: number;
  providerRows: number;
  tracksCreated: number;
  tracksReactivated: number;
  tracksUnliked: number;
  evidenceDeactivated: number;
  artistStatesUpdated: number;
  error?: string;
};

export function resolveLikedTrackReconciliationPolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  sourceCapabilityAllowed?: boolean;
}): {
  enabled: boolean;
  reason: LikedTrackReconciliationPolicyReason;
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
 * Gate 5C periodic reconciliation runner.
 *
 * The Saved Tracks capability is evaluated before feature flags, local user
 * enumeration and the full provider scan. Under the current data-policy matrix
 * this job is inert because Saved Tracks is DENY for behavioral analytics and
 * user profiling. Existing rollout and circuit-breaker controls become relevant
 * only after the source capability itself is explicitly ALLOW.
 */
export async function runLikedTrackReconciliationJob(): Promise<
  LikedTrackReconciliationJobResult[]
> {
  const sourceCapability = spotifySavedTracksProfileMaterializationCapability();
  if (!sourceCapability.allowed) {
    return [];
  }
  if (!parseBoolean(process.env.LIKED_TRACK_RECONCILIATION_ENABLED)) {
    return [];
  }

  const users = (
    await prisma.user.findMany({
      where: { likedTrackPreferences: { some: { isLiked: true } } },
      select: { id: true, email: true },
      orderBy: { id: "asc" },
    })
  ).filter((user) => isEmailAllowed(user.email));

  const maxUnlikes = parsePositiveInteger(
    process.env.LIKED_TRACK_RECONCILIATION_MAX_UNLIKES,
    DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikes,
  );
  const maxUnlikePercent = parsePositiveNumber(
    process.env.LIKED_TRACK_RECONCILIATION_MAX_UNLIKE_PERCENT,
    DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikePercent,
  );

  const results: LikedTrackReconciliationJobResult[] = [];
  for (const user of users) {
    const policy = resolveLikedTrackReconciliationPolicy({
      userEmail: user.email,
      masterEnabled: process.env.LIKED_TRACK_RECONCILIATION_ENABLED,
      allowlistedEmails: process.env.LIKED_TRACK_RECONCILIATION_USER_EMAILS,
      sourceCapabilityAllowed: sourceCapability.allowed,
    });
    if (!policy.enabled || !user.email) continue;

    try {
      const report = await reconcileLikedTracks(user.id, {
        mode: "APPLY",
        limits: { maxUnlikes, maxUnlikePercent },
      });
      const changed =
        report.planned.tracksToCreate > 0 ||
        report.planned.tracksToReactivate > 0 ||
        report.planned.tracksToUnlike > 0 ||
        report.planned.trackMetadataUpdates > 0 ||
        report.planned.evidenceToCreate > 0 ||
        report.planned.evidenceToReactivate > 0 ||
        report.planned.evidenceToDeactivate > 0 ||
        report.planned.evidenceMetadataUpdates > 0 ||
        report.planned.affinityStatesToCreate > 0 ||
        report.planned.affinityStatesToUpdate > 0;

      const status: LikedTrackReconciliationJobResult["status"] =
        report.status === "READY"
          ? changed
            ? "SUCCESS"
            : "NOOP"
          : report.status;
      const result: LikedTrackReconciliationJobResult = {
        userId: user.id,
        email: user.email,
        status,
        safetyStatus: report.status,
        providerCalls: report.provider.providerCalls,
        pagesRead: report.provider.pagesRead,
        providerRows: report.provider.rows,
        tracksCreated: report.planned.tracksToCreate,
        tracksReactivated: report.planned.tracksToReactivate,
        tracksUnliked: report.planned.tracksToUnlike,
        evidenceDeactivated: report.planned.evidenceToDeactivate,
        artistStatesUpdated: report.planned.affinityStatesToUpdate,
      };
      results.push(result);
      console.info("[SOURCE-LIKED-01][reconciliation]", JSON.stringify(result));
    } catch (error) {
      const result: LikedTrackReconciliationJobResult = {
        userId: user.id,
        email: user.email,
        status: "FAILED",
        providerCalls: 0,
        pagesRead: 0,
        providerRows: 0,
        tracksCreated: 0,
        tracksReactivated: 0,
        tracksUnliked: 0,
        evidenceDeactivated: 0,
        artistStatesUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      console.error("[SOURCE-LIKED-01][reconciliation]", JSON.stringify(result));
    }
  }

  return results;
}

function parseBoolean(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
