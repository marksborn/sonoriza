import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";
import { computeMusicRepeatCutoff } from "@/services/spotify/recently-played";
import {
  evaluateGate5CIsrcMbid,
  gate5CNormalizeIsrc,
  gate5CNormalizeMbid,
  type Gate5CDecisionResult,
} from "./musicbrainz-isrc-mbid-shadow";
import { Gate5CMusicBrainzClient } from "./musicbrainz-isrc-mbid-shadow-client";
import { validateGate5CHistoricalSelection } from "./musicbrainz-isrc-mbid-shadow-selection";

const MAX_BATCH = 5;
const MAX_HISTORY_EVENTS = 20_000;

export type Gate5CIsrcReport = Readonly<{
  gate: "5C";
  mode: "MANUAL_SPOTIFY_MUSICBRAINZ_ISRC_SHADOW";
  coverage: "LOCAL_LASTFM_LOWER_BOUND_ONLY";
  userId: string;
  targetPlaylistId: string;
  targetName: string;
  sourceRunId: string;
  sourceRunStartedAt: string;
  cutoff: string;
  offset: number;
  requestedLimit: number;
  selectedPositions: readonly number[] | null;
  authority: {
    spotifyCatalogCalls: true;
    musicBrainzCalls: true;
    operationalSpotifyTokenRefreshMayWrite: true;
    canonicalDbWrites: false;
    spotifyPlaylistWrites: false;
    generationWrites: false;
    consumerActivation: false;
    cooldownInfluence: false;
  };
  metrics: {
    spotifyCatalog: ReturnType<SpotifyCatalogSearchClient["getMetrics"]>;
    musicBrainz: ReturnType<Gate5CMusicBrainzClient["getMetrics"]>;
  };
  rows: Array<{
    position: number;
    spotifyTrackId: string;
    publishedTitle: string | null;
    catalogTitle: string | null;
    catalogIsrc: string | null;
    decision: Gate5CDecisionResult["decision"] | "ABSTAIN_SPOTIFY_TRACK_UNAVAILABLE";
    mbids: string[];
    musicBrainzRecordingCount: number;
    durationDeltaMs: number | null;
    localLastFmScrobblesWithCandidateMbid: number;
    productiveCooldownEligible: false;
  }>;
}>;

/**
 * Explicit, bounded, operator-only probe. Historical DB reads use one READ
 * ONLY / REPEATABLE READ snapshot. Provider requests occur AFTER it commits.
 *
 * Neither this function nor its clients mutate identities or playlists.
 * Spotify OAuth token refresh MAY update the Account operational credential.
 */
export async function reportGate5CIsrcMbidShadow(input: {
  userId: string;
  targetPlaylistId: string;
  offset: number;
  limit: number;
  /** Optional exact historical SUCCESS real run, owned by the same user and target. */
  runId?: string | null;
  /** Optional exact 1–5 item positions; only allowed with runId. */
  positions?: readonly number[] | null;
  spotify?: Pick<SpotifyCatalogSearchClient, "lookupTracksByIds" | "getMetrics">;
  musicBrainz?: Pick<Gate5CMusicBrainzClient, "lookup" | "getMetrics">;
}): Promise<Gate5CIsrcReport> {
  const userId = input.userId.trim();
  const targetPlaylistId = input.targetPlaylistId.trim();
  const { offset, limit } = input;
  const selection = validateGate5CHistoricalSelection({
    runId: input.runId,
    positions: input.positions,
  });
  if (!userId || !targetPlaylistId) throw new Error("Gate 5C: user and target required");
  if (!Number.isInteger(offset) || offset < 0 || offset > 500) {
    throw new Error("Gate 5C: offset must be an integer from 0 to 500");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new Error("Gate 5C: limit must be an integer between 1 and 5");
  }

  const baseline = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const target = await tx.targetPlaylist.findFirst({
      where: { id: targetPlaylistId, userId },
      select: { name: true },
    });
    if (!target) throw new Error("Gate 5C: target not found for this user");

    const policy = await tx.musicPlaybackPolicy.findUnique({
      where: { userId },
      select: { enabled: true, windowValue: true, windowUnit: true },
    });
    if (!policy?.enabled || !policy.windowValue || !policy.windowUnit) {
      throw new Error("Gate 5C: repeat window unavailable; abstain");
    }

    const run = await tx.generationRun.findFirst({
      where: {
        userId, simulation: false, status: "SUCCESS",
        ...(selection.runId ? { id: selection.runId } : {}),
        items: { some: { targetPlaylistId } },
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true, startedAt: true,
        items: {
          where: {
            targetPlaylistId, contentType: "MUSIC",
            ...(selection.positions ? { position: { in: [...selection.positions] } } : {}),
          },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          ...(selection.positions
            ? { take: selection.positions.length }
            : { skip: offset, take: limit }),
          select: { position: true, spotifyTrackId: true, title: true },
        },
      },
    });
    if (!run) {
      throw new Error("Gate 5D.3: selected run must be a successful real generation owned by this user and target");
    }
    if (selection.positions && run.items.length !== selection.positions.length) {
      throw new Error("Gate 5D.3: requested positions do not all belong to MUSIC items on selected target");
    }
    const cutoff = computeMusicRepeatCutoff(
      run.startedAt, policy.windowValue, policy.windowUnit,
    );
    const history = await tx.trackListeningEvent.findMany({
      where: {
        userId,
        source: "LASTFM_SCROBBLE",
        playedAt: { gte: cutoff, lt: run.startedAt },
        trackMbid: { not: null },
      },
      take: MAX_HISTORY_EVENTS + 1,
      select: { trackMbid: true },
    });
    if (history.length > MAX_HISTORY_EVENTS) {
      throw new Error("Gate 5C: local history cap exceeded; abstain");
    }
    const mbidCounts = new Map<string, number>();
    for (const event of history) {
      const mbid = gate5CNormalizeMbid(event.trackMbid);
      if (mbid) mbidCounts.set(mbid, (mbidCounts.get(mbid) ?? 0) + 1);
    }

    return {
      targetName: target.name, runId: run.id,
      runStartedAt: run.startedAt.toISOString(),
      cutoff: cutoff.toISOString(),
      items: run.items, mbidCounts,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  const spotify = input.spotify ?? (await SpotifyCatalogSearchClient.forUser(userId));
  const musicBrainz = input.musicBrainz ?? new Gate5CMusicBrainzClient();
  const rows: Gate5CIsrcReport["rows"] = [];

  // Sequential requests only. Any transient error aborts the whole batch;
  // never present a partial report as if it were complete.
  for (const item of baseline.items) {
    if (!item.spotifyTrackId) continue;
    const [lookup] = await spotify.lookupTracksByIds([item.spotifyTrackId]);
    const track = lookup?.track;
    if (!track) {
      rows.push({
        position: item.position,
        spotifyTrackId: item.spotifyTrackId,
        publishedTitle: item.title,
        catalogTitle: null, catalogIsrc: null,
        decision: "ABSTAIN_SPOTIFY_TRACK_UNAVAILABLE",
        mbids: [], musicBrainzRecordingCount: 0,
        durationDeltaMs: null, localLastFmScrobblesWithCandidateMbid: 0,
        productiveCooldownEligible: false,
      });
      continue;
    }

    const catalogIsrc = gate5CNormalizeIsrc(track.isrc);
    const artistName = track.artists[0]?.name ?? "";
    const providerTrack = {
      title: track.name, artistName, isrc: track.isrc,
      durationMs: track.durationMs,
      linkedFromTrackId:
        track.linkedFromTrackId ||
        (track.id === item.spotifyTrackId ? null : item.spotifyTrackId),
    };
    const remote =
      catalogIsrc && !providerTrack.linkedFromTrackId
        ? await musicBrainz.lookup(catalogIsrc)
        : { kind: "FOUND" as const, recordings: [] };
    const compared = evaluateGate5CIsrcMbid({ spotify: providerTrack, lookup: remote });
    const scrobbleHits = compared.mbids.reduce(
      (total, mbid) => total + (baseline.mbidCounts.get(mbid) ?? 0),
      0,
    );

    rows.push({
      position: item.position,
      spotifyTrackId: item.spotifyTrackId,
      publishedTitle: item.title,
      catalogTitle: track.name,
      catalogIsrc,
      decision: compared.decision,
      mbids: compared.mbids,
      musicBrainzRecordingCount: compared.recordingCount,
      durationDeltaMs: compared.durationDeltaMs,
      localLastFmScrobblesWithCandidateMbid: scrobbleHits,
      productiveCooldownEligible: false,
    });
  }

  return {
    gate: "5C",
    mode: "MANUAL_SPOTIFY_MUSICBRAINZ_ISRC_SHADOW",
    coverage: "LOCAL_LASTFM_LOWER_BOUND_ONLY",
    userId, targetPlaylistId,
    targetName: baseline.targetName,
    sourceRunId: baseline.runId,
    sourceRunStartedAt: baseline.runStartedAt,
    cutoff: baseline.cutoff,
    offset, requestedLimit: limit,
    selectedPositions: selection.positions,
    authority: {
      spotifyCatalogCalls: true, musicBrainzCalls: true,
      operationalSpotifyTokenRefreshMayWrite: true,
      canonicalDbWrites: false, spotifyPlaylistWrites: false,
      generationWrites: false, consumerActivation: false,
      cooldownInfluence: false,
    },
    metrics: {
      spotifyCatalog: spotify.getMetrics(),
      musicBrainz: musicBrainz.getMetrics(),
    },
    rows,
  };
}
