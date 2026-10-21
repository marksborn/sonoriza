import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { computeMusicRepeatCutoff } from "@/services/spotify/recently-played";
import {
  compareGate5AFactualCooldown,
  type Gate5ACanonicalDecision,
  type Gate5AFactualEvent,
  type Gate5AProviderRef,
} from "./canonical-factual-cooldown-shadow";

const MAX_ITEMS = 1_000;
const MAX_LOCAL_SCROBBLES = 20_000;
const SAMPLE_LIMIT = 12;

export type Gate5AShadowReport = Readonly<{
  gate: "5A";
  mode: "LOCAL_PERSISTED_LASTFM_CANONICAL_COOLDOWN_SHADOW_READ_ONLY";
  userId: string;
  targetPlaylistId: string;
  targetName: string;
  basis: "LAST_SUCCESSFUL_GENERATION_VERSUS_LOCAL_PERSISTED_LASTFM_SCROBBLES";
  coverage: "LOCAL_LOWER_BOUND_ONLY";
  liveProviderRead: false;
  spotifyWrites: false;
  databaseWrites: false;
  consumerActivation: false;
  plannerInfluence: false;
  abstention: string | null;
  sourceRunId: string | null;
  sourceRunStartedAt: string | null;
  cutoff: string | null;
  counts: {
    publishedMusicItems: number;
    localLastFmScrobbles: number;
    localScrobblesWithProviderTrackId: number;
    publishedItemsWithProviderRef: number;
    textOnlyLegacyMatches: number;
    exactProviderEvidence: number;
    strongCrossRecordingEvidence: number;
    weakSameRecordingReview: number;
    identifierOnlyReview: number;
    noCanonicalEvidence: number;
    additionalCooldownEvidence: number;
  };
  samples: Array<{
    trackName: string | null;
    artistName: string | null;
    legacyTextMatch: boolean;
    canonical: Gate5ACanonicalDecision;
    additionalCooldownEvidence: boolean;
  }>;
}>;

function emptyCounts(): Gate5AShadowReport["counts"] {
  return {
    publishedMusicItems: 0,
    localLastFmScrobbles: 0,
    localScrobblesWithProviderTrackId: 0,
    publishedItemsWithProviderRef: 0,
    textOnlyLegacyMatches: 0,
    exactProviderEvidence: 0,
    strongCrossRecordingEvidence: 0,
    weakSameRecordingReview: 0,
    identifierOnlyReview: 0,
    noCanonicalEvidence: 0,
    additionalCooldownEvidence: 0,
  };
}

/**
 * Gate 5A inventory only. In particular:
 * - The source is persisted, historical Last.fm events, not the LIVE Last.fm
 *   read required by productive cooldown. A negative result proves nothing.
 * - All DB reads happen within an explicitly read-only transaction.
 * - The latest successful GenerationRun is a historical published-plan
 *   snapshot, not a current read of the Spotify playlist.
 */
export async function reportGate5ACanonicalFactualCooldown(input: {
  userId: string;
  targetPlaylistId: string;
}): Promise<Gate5AShadowReport> {
  const userId = input.userId.trim();
  const targetPlaylistId = input.targetPlaylistId.trim();
  if (!userId || !targetPlaylistId) {
    throw new Error("userId and targetPlaylistId are required");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    const target = await tx.targetPlaylist.findFirst({
      where: { id: targetPlaylistId, userId },
      select: { id: true, name: true },
    });
    if (!target) throw new Error("Target missing or does not belong to user");

    const base: Gate5AShadowReport = {
      gate: "5A",
      mode: "LOCAL_PERSISTED_LASTFM_CANONICAL_COOLDOWN_SHADOW_READ_ONLY",
      userId,
      targetPlaylistId,
      targetName: target.name,
      basis: "LAST_SUCCESSFUL_GENERATION_VERSUS_LOCAL_PERSISTED_LASTFM_SCROBBLES",
      coverage: "LOCAL_LOWER_BOUND_ONLY",
      liveProviderRead: false,
      spotifyWrites: false,
      databaseWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      abstention: null,
      sourceRunId: null,
      sourceRunStartedAt: null,
      cutoff: null,
      counts: emptyCounts(),
      samples: [],
    };

    const policy = await tx.musicPlaybackPolicy.findUnique({
      where: { userId },
      select: { enabled: true, windowValue: true, windowUnit: true },
    });
    if (!policy?.enabled || !policy.windowUnit || !policy.windowValue) {
      return { ...base, abstention: "NO_ENABLED_REPEAT_POLICY" };
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
          select: {
            title: true,
            subtitle: true,
            spotifyTrackId: true,
          },
        },
      },
    });

    if (!run) return { ...base, abstention: "NO_SUCCESSFUL_REAL_RUN" };
    const prepared = {
      ...base,
      sourceRunId: run.id,
      sourceRunStartedAt: run.startedAt.toISOString(),
    };
    if (run.items.length > MAX_ITEMS) {
      return { ...prepared, abstention: "ITEM_LIMIT_EXCEEDED" };
    }

    const cutoff = computeMusicRepeatCutoff(
      run.startedAt,
      policy.windowValue,
      policy.windowUnit,
    );
    const reportBase = { ...prepared, cutoff: cutoff.toISOString() };
    const events = await tx.trackListeningEvent.findMany({
      where: {
        userId,
        source: "LASTFM_SCROBBLE",
        playedAt: { gte: cutoff, lt: run.startedAt },
      },
      orderBy: [{ playedAt: "desc" }, { id: "asc" }],
      take: MAX_LOCAL_SCROBBLES + 1,
      select: {
        trackName: true,
        artistName: true,
        spotifyTrackId: true,
        isrc: true,
        trackMbid: true,
      },
    });
    if (events.length > MAX_LOCAL_SCROBBLES) {
      return { ...reportBase, abstention: "SCROBBLE_LIMIT_EXCEEDED" };
    }

    const trackIds = [...new Set([
      ...run.items.map((item) => item.spotifyTrackId),
      ...events.map((event) => event.spotifyTrackId),
    ].filter((id): id is string => Boolean(id)))];

    const refs = trackIds.length
      ? await tx.trackProviderRef.findMany({
          where: {
            userId,
            provider: "spotify",
            providerScope: "global",
            providerTrackId: { in: trackIds },
          },
          select: {
            providerTrackId: true,
            recordingIdentityId: true,
            matchReason: true,
            confidenceBasisPoints: true,
            isrc: true,
            trackMbid: true,
          },
        })
      : [];

    const mappedEvents: Gate5AFactualEvent[] = events;
    const mappedRefs: Gate5AProviderRef[] = refs;
    const referencedIds = new Set(refs.map((ref) => ref.providerTrackId));
    const counts = emptyCounts();
    counts.publishedMusicItems = run.items.length;
    counts.localLastFmScrobbles = events.length;
    counts.localScrobblesWithProviderTrackId = events.filter((e) => e.spotifyTrackId).length;
    counts.publishedItemsWithProviderRef = run.items.filter(
      (item) => item.spotifyTrackId && referencedIds.has(item.spotifyTrackId),
    ).length;

    const samples: Gate5AShadowReport["samples"] = [];
    for (const item of run.items) {
      const result = compareGate5AFactualCooldown({
        published: {
          spotifyTrackId: item.spotifyTrackId,
          trackName: item.title,
          artistName: item.subtitle,
        },
        events: mappedEvents,
        refs: mappedRefs,
      });
      if (result.legacyTextMatch) counts.textOnlyLegacyMatches += 1;
      switch (result.canonical) {
        case "EXACT_PROVIDER_REF":
          counts.exactProviderEvidence += 1;
          break;
        case "STRONG_SAME_RECORDING":
          counts.strongCrossRecordingEvidence += 1;
          break;
        case "REVIEW_WEAK_SAME_RECORDING":
          counts.weakSameRecordingReview += 1;
          break;
        case "REVIEW_ISRC_OR_MBID_ONLY":
          counts.identifierOnlyReview += 1;
          break;
        case "ABSTAIN_NO_CANONICAL_EVIDENCE":
          counts.noCanonicalEvidence += 1;
          break;
      }
      if (result.canonicalIsAdditionalCooldown) {
        counts.additionalCooldownEvidence += 1;
      }
      if (
        samples.length < SAMPLE_LIMIT &&
        (result.canonical !== "ABSTAIN_NO_CANONICAL_EVIDENCE" || result.legacyTextMatch)
      ) {
        samples.push({
          trackName: item.title,
          artistName: item.subtitle,
          legacyTextMatch: result.legacyTextMatch,
          canonical: result.canonical,
          additionalCooldownEvidence: result.canonicalIsAdditionalCooldown,
        });
      }
    }

    return { ...reportBase, counts, samples };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
