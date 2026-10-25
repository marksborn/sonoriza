import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SpotifyCatalogReadSession, SpotifyCatalogRequestBudgetExceededError } from "./catalog-read-session";
import { SpotifyCatalogSearchClient } from "./catalog-search";
import { SpotifyApiError } from "./errors";
import {
  resolveCleanupRecordingEvidence,
  type CleanupPlaybackFact,
  type CleanupRecordingCandidate,
} from "./source-cleanup-recording";

const MAX_HISTORY_ROWS = 20_000;
export const CLEANUP_RECORDING_REQUEST_BUDGET = 4;

export async function createCleanupRecordingLookup(userId: string, requestBudget = CLEANUP_RECORDING_REQUEST_BUDGET) {
  if (!Number.isInteger(requestBudget) || requestBudget < 0 || requestBudget > 8) throw new Error("Invalid recording catalog budget");
  const session = new SpotifyCatalogReadSession(userId, { requestBudget });
  const client = await SpotifyCatalogSearchClient.forUser(userId, { readSession: session });
  const lookup = async (id: string) => {
    try {
      const [row] = await client.lookupTracksByIds([id]);
      const track = row?.track;
      if (!track || row.requestedTrackId !== id || track.uri !== `spotify:track:${track.id}` ||
          (track.id !== id && track.linkedFromTrackId !== id)) return null;
      return { title: track.name, artistId: track.artists[0]?.id ?? null,
        artistName: track.artists[0]?.name ?? null, durationMs: track.durationMs, isrc: track.isrc };
    } catch (error) {
      if (error instanceof SpotifyCatalogRequestBudgetExceededError) return "BUDGET" as const;
      if (error instanceof SpotifyApiError && error.status === 404) return null;
      throw error;
    }
  };
  return { lookup, metrics: () => session.getMetrics() };
}

/** Both legacy ID facts and recording facts come from one user-scoped snapshot. */
export async function loadCleanupPlaybackHistory(userId: string, now: Date) {
  if (!userId.trim() || !Number.isFinite(now.getTime())) throw new Error("Invalid cleanup history scope");
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const states = await tx.trackListeningState.findMany({
      where: { userId, lastPlayedAt: { lte: now } },
      select: { spotifyTrackId: true }, take: MAX_HISTORY_ROWS + 1,
    });
    const events = await tx.trackListeningEvent.findMany({
      where: { userId, source: "SPOTIFY_RECENTLY_PLAYED", playedAt: { lte: now },
        spotifyTrackId: { not: null }, isrc: { not: null } },
      select: { userId: true, spotifyTrackId: true, trackName: true, artistName: true,
        primaryArtistId: true, isrc: true, metadata: true, source: true, playedAt: true },
      take: MAX_HISTORY_ROWS + 1,
    });
    if (states.length > MAX_HISTORY_ROWS || events.length > MAX_HISTORY_ROWS) {
      throw new Error("O histórico excedeu o limite de conferência. A limpeza foi interrompida antes de remover faixas.");
    }
    const facts: CleanupPlaybackFact[] = events.map(event => {
      const metadata = event.metadata as { spotifyRecentlyPlayed?: { trackDurationMs?: unknown } } | null;
      const duration = metadata?.spotifyRecentlyPlayed?.trackDurationMs;
      return {
        userId: event.userId, spotifyTrackId: event.spotifyTrackId,
        title: event.trackName, artistName: event.artistName,
        artistId: event.primaryArtistId, isrc: event.isrc,
        durationMs: typeof duration === "number" ? duration : null,
        source: event.source, playedAt: event.playedAt,
      };
    });
    return { playedTrackIds: new Set(states.map(state => state.spotifyTrackId)), facts };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** No remote searches or history-ID hydration; at most four source-track GETs. */
export async function resolvePersistedCleanupRecordingEvidence(
  userId: string,
  candidates: readonly CleanupRecordingCandidate[],
  now: Date,
) {
  const history = await loadCleanupPlaybackHistory(userId, now);
  const catalog = await createCleanupRecordingLookup(userId);
  const resolved = await resolveCleanupRecordingEvidence({
    userId, candidates, ...history, now,
    // Quota, auth, timeout, cache failure and unexpected responses propagate.
    lookup: catalog.lookup,
  });
  return { ...resolved, catalog: catalog.metrics() };
}
