import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { computeMusicRepeatCutoff } from "@/services/spotify/recently-played";
import {
  compareGate5BMbidEvidence,
  normalizeGate5BMbid,
  type Gate5BCandidate,
  type Gate5BDecision,
  type Gate5BProviderMbidOwner,
  type Gate5BScrobble,
} from "./canonical-factual-mbid-linkage-shadow";

const MAX_ITEMS = 1_000;
const MAX_LOCAL_SCROBBLES = 20_000;
const MAX_MBID_OWNERS = 3_000;
const SAMPLE_LIMIT = 12;

export type Gate5BMbidAuditReport = Readonly<{
  gate: "5B";
  mode: "LOCAL_LASTFM_MBID_LINKAGE_REVIEW_ONLY";
  userId: string;
  targetPlaylistId: string;
  targetName: string;
  basis: "LAST_SUCCESSFUL_GENERATION_VS_LOCAL_PERSISTED_LASTFM_SCROBBLES";
  coverage: "LOCAL_LOWER_BOUND_ONLY";
  externalProviderCalls: false;
  databaseWrites: false;
  spotifyWrites: false;
  plannerInfluence: false;
  canonicalMutation: false;
  productAuthorization: false;
  abstention: string | null;
  sourceRunId: string | null;
  sourceRunStartedAt: string | null;
  cutoff: string | null;
  counts: {
    publishedMusicItems: number;
    localLastFmScrobbles: number;
    localScrobblesWithValidMbid: number;
    targetTracksWithProviderRef: number;
    targetTracksWithValidProviderMbid: number;
    candidatesWithReviewEvidence: number;
    remasterStandardReview: number;
    sameVersionReview: number;
    targetItemsWithNoProviderRef: number;
    mbidCollisionAbstentions: number;
    artistConflictAbstentions: number;
    titleConflictAbstentions: number;
    versionConflictAbstentions: number;
    missingMetadataAbstentions: number;
    missingProviderMbidAbstentions: number;
    noScrobbleOverlapAbstentions: number;
  };
  samples: Array<{
    trackName: string | null;
    artistName: string | null;
    decision: Gate5BDecision;
    matchedScrobbleCount: number;
    matchedRecordingIdentityCount: number;
    productiveCooldown: false;
  }>;
}>;

function zeroCounts(): Gate5BMbidAuditReport["counts"] {
  return {
    publishedMusicItems: 0,
    localLastFmScrobbles: 0,
    localScrobblesWithValidMbid: 0,
    targetTracksWithProviderRef: 0,
    targetTracksWithValidProviderMbid: 0,
    candidatesWithReviewEvidence: 0,
    remasterStandardReview: 0,
    sameVersionReview: 0,
    targetItemsWithNoProviderRef: 0,
    mbidCollisionAbstentions: 0,
    artistConflictAbstentions: 0,
    titleConflictAbstentions: 0,
    versionConflictAbstentions: 0,
    missingMetadataAbstentions: 0,
    missingProviderMbidAbstentions: 0,
    noScrobbleOverlapAbstentions: 0,
  };
}

/**
 * Read-only historical audit. No live provider calls and no integration in a
 * production generation run. Local Last.fm data is incomplete by design:
 * zero matches must never be read as "never listened".
 *
 * All queries share one REPEATABLE READ snapshot, explicitly READ ONLY.
 */
export async function reportGate5BMbidLinkage(input: {
  userId: string;
  targetPlaylistId: string;
}): Promise<Gate5BMbidAuditReport> {
  const userId = input.userId.trim();
  const targetPlaylistId = input.targetPlaylistId.trim();
  if (!userId || !targetPlaylistId) {
    throw new Error("userId and targetPlaylistId are required");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    const target = await tx.targetPlaylist.findFirst({
      where: { id: targetPlaylistId, userId },
      select: { name: true },
    });
    if (!target) throw new Error("Target unavailable or owned by another user");

    const base: Gate5BMbidAuditReport = {
      gate: "5B",
      mode: "LOCAL_LASTFM_MBID_LINKAGE_REVIEW_ONLY",
      userId, targetPlaylistId, targetName: target.name,
      basis: "LAST_SUCCESSFUL_GENERATION_VS_LOCAL_PERSISTED_LASTFM_SCROBBLES",
      coverage: "LOCAL_LOWER_BOUND_ONLY",
      externalProviderCalls: false,
      databaseWrites: false,
      spotifyWrites: false,
      plannerInfluence: false,
      canonicalMutation: false,
      productAuthorization: false,
      abstention: null,
      sourceRunId: null,
      sourceRunStartedAt: null,
      cutoff: null,
      counts: zeroCounts(),
      samples: [],
    };

    const policy = await tx.musicPlaybackPolicy.findUnique({
      where: { userId },
      select: { enabled: true, windowValue: true, windowUnit: true },
    });
    if (!policy?.enabled || !policy.windowValue || !policy.windowUnit) {
      return { ...base, abstention: "REPEAT_POLICY_DISABLED_OR_INCOMPLETE" };
    }

    const run = await tx.generationRun.findFirst({
      where: {
        userId,
        simulation: false,
        status: "SUCCESS",
        items: { some: { targetPlaylistId } },
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        items: {
          where: { targetPlaylistId, contentType: "MUSIC" },
          orderBy: { position: "asc" },
          take: MAX_ITEMS + 1,
          select: { title: true, subtitle: true, spotifyTrackId: true },
        },
      },
    });
    if (!run) return { ...base, abstention: "NO_REAL_SUCCESSFUL_GENERATION" };

    const runBase = {
      ...base,
      sourceRunId: run.id,
      sourceRunStartedAt: run.startedAt.toISOString(),
    };
    if (run.items.length > MAX_ITEMS) {
      return { ...runBase, abstention: "ITEM_LIMIT_EXCEEDED" };
    }

    const cutoff = computeMusicRepeatCutoff(
      run.startedAt,
      policy.windowValue,
      policy.windowUnit,
    );
    const windowBase = { ...runBase, cutoff: cutoff.toISOString() };

    const events = await tx.trackListeningEvent.findMany({
      where: {
        userId,
        source: "LASTFM_SCROBBLE",
        playedAt: { gte: cutoff, lt: run.startedAt },
      },
      orderBy: [{ playedAt: "desc" }, { id: "asc" }],
      take: MAX_LOCAL_SCROBBLES + 1,
      select: { trackName: true, artistName: true, trackMbid: true },
    });
    if (events.length > MAX_LOCAL_SCROBBLES) {
      return { ...windowBase, abstention: "SCROBBLE_LIMIT_EXCEEDED" };
    }

    const providerTrackIds = [...new Set(
      run.items.flatMap((item) => item.spotifyTrackId ? [item.spotifyTrackId] : []),
    )];
    const targetRefs = providerTrackIds.length > 0
      ? await tx.trackProviderRef.findMany({
          where: {
            userId,
            provider: "spotify",
            providerScope: "global",
            providerTrackId: { in: providerTrackIds },
          },
          select: {
            providerTrackId: true,
            recordingIdentityId: true,
            trackMbid: true,
          },
        })
      : [];

    const targetRefById = new Map(targetRefs.map((ref) => [ref.providerTrackId, ref]));
    const normalizedTargetMbids = [...new Set(
      targetRefs.flatMap((ref) => {
        const mbid = normalizeGate5BMbid(ref.trackMbid);
        return mbid ? [mbid] : [];
      }),
    )];
    const owners: Gate5BProviderMbidOwner[] = normalizedTargetMbids.length
      ? await tx.$queryRaw<Gate5BProviderMbidOwner[]>(
          Prisma.sql`SELECT "recordingIdentityId", "trackMbid"
            FROM "TrackProviderRef"
            WHERE "userId" = ${userId}
              AND "provider" = 'spotify'
              AND "providerScope" = 'global'
              AND LOWER("trackMbid") IN (${Prisma.join(normalizedTargetMbids)})
            LIMIT ${MAX_MBID_OWNERS + 1}`,
        )
      : [];

    // A truncated inventory may hide collisions. Abstain instead of claiming
    // a unique RecordingIdentity from partial data.
    if (owners.length > MAX_MBID_OWNERS) {
      return { ...windowBase, abstention: "MBID_OWNER_LIMIT_EXCEEDED" };
    }

    const eventsByMbid = new Map<string, Gate5BScrobble[]>();
    for (const event of events) {
      const mbid = normalizeGate5BMbid(event.trackMbid);
      if (!mbid) continue;
      const bucket = eventsByMbid.get(mbid) ?? [];
      bucket.push(event);
      eventsByMbid.set(mbid, bucket);
    }

    const ownersByMbid = new Map<string, Gate5BProviderMbidOwner[]>();
    for (const owner of owners) {
      const mbid = normalizeGate5BMbid(owner.trackMbid);
      if (!mbid) continue;
      const bucket = ownersByMbid.get(mbid) ?? [];
      bucket.push(owner);
      ownersByMbid.set(mbid, bucket);
    }

    const counts = zeroCounts();
    counts.publishedMusicItems = run.items.length;
    counts.localLastFmScrobbles = events.length;
    counts.localScrobblesWithValidMbid = [...eventsByMbid.values()]
      .reduce((total, rows) => total + rows.length, 0);
    counts.targetTracksWithProviderRef = run.items.filter(
      (item) => item.spotifyTrackId && targetRefById.has(item.spotifyTrackId),
    ).length;
    counts.targetTracksWithValidProviderMbid = run.items.filter((item) => {
      const ref = item.spotifyTrackId ? targetRefById.get(item.spotifyTrackId) : null;
      return Boolean(normalizeGate5BMbid(ref?.trackMbid));
    }).length;

    const samples: Gate5BMbidAuditReport["samples"] = [];
    for (const item of run.items) {
      const ref = item.spotifyTrackId
        ? targetRefById.get(item.spotifyTrackId)
        : undefined;
      if (!ref) {
        counts.targetItemsWithNoProviderRef += 1;
        continue;
      }
      const mbid = normalizeGate5BMbid(ref.trackMbid);
      const candidate: Gate5BCandidate = {
        providerTrackId: ref.providerTrackId,
        title: item.title,
        artistName: item.subtitle,
        recordingIdentityId: ref.recordingIdentityId,
        providerTrackMbid: ref.trackMbid,
      };
      const classification = compareGate5BMbidEvidence({
        candidate,
        scrobbles: mbid ? eventsByMbid.get(mbid) ?? [] : [],
        mbidOwners: mbid ? ownersByMbid.get(mbid) ?? [] : [],
      });
      switch (classification.decision) {
        case "REVIEW_MBID_SAME_VERSION":
          counts.sameVersionReview += 1;
          counts.candidatesWithReviewEvidence += 1;
          break;
        case "REVIEW_MBID_REMASTER_STANDARD":
          counts.remasterStandardReview += 1;
          counts.candidatesWithReviewEvidence += 1;
          break;
        case "ABSTAIN_MBID_RECORDING_COLLISION":
          counts.mbidCollisionAbstentions += 1;
          break;
        case "ABSTAIN_ARTIST_CONFLICT":
          counts.artistConflictAbstentions += 1;
          break;
        case "ABSTAIN_TITLE_CONFLICT":
          counts.titleConflictAbstentions += 1;
          break;
        case "ABSTAIN_VERSION_CONFLICT":
          counts.versionConflictAbstentions += 1;
          break;
        case "ABSTAIN_METADATA_INCOMPLETE":
          counts.missingMetadataAbstentions += 1;
          break;
        case "ABSTAIN_PROVIDER_MBID_MISSING":
          counts.missingProviderMbidAbstentions += 1;
          break;
        case "ABSTAIN_NO_SCROBBLE_MBID_MATCH":
          counts.noScrobbleOverlapAbstentions += 1;
          break;
      }
      if (
        samples.length < SAMPLE_LIMIT &&
        classification.matchedScrobbleCount > 0
      ) {
        samples.push({
          trackName: item.title,
          artistName: item.subtitle,
          decision: classification.decision,
          matchedScrobbleCount: classification.matchedScrobbleCount,
          matchedRecordingIdentityCount: classification.matchedRecordingIdentityCount,
          productiveCooldown: false,
        });
      }
    }
    return { ...windowBase, counts, samples };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
