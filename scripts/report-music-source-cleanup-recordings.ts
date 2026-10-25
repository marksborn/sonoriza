import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decodeMusicSourceCache } from "@/services/spotify/source-cache";
import { createCleanupRecordingLookup, loadCleanupPlaybackHistory } from "@/services/spotify/source-cleanup-recording-runtime";
import { resolveCleanupRecordingEvidence } from "@/services/spotify/source-cleanup-recording";

async function main() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(user|source|catalog-budget)=(.+)$/.exec(arg);
    const key = match?.[1] ?? (arg === "--ack-provider-reads" ? "ack-provider-reads" : null);
    if (!key || args.has(key)) throw new Error("Unknown or duplicate diagnostic argument");
    args.set(key, match?.[2] ?? "true");
  }
  const userId = args.get("user")?.trim();
  const sourceId = args.get("source")?.trim();
  const budget = Number(args.get("catalog-budget") ?? 0);
  if (!userId || !sourceId || !Number.isInteger(budget) || budget < 0 || budget > 8) {
    throw new Error("Use --user=<id> --source=<id> [--catalog-budget=0..8 --ack-provider-reads]");
  }
  if (budget > 0 && !args.has("ack-provider-reads")) throw new Error("Catalog reads require --ack-provider-reads");
  const source = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return tx.sourcePlaylist.findFirst({ where: { id: sourceId, userId, kind: "MUSIC", spotifyType: "PLAYLIST" } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  if (!source) throw new Error("Source not found in user scope");
  const candidates = decodeMusicSourceCache(source.cachedCandidates);
  if (!source.spotifySnapshotId || !candidates) throw new Error("Complete source cache required");
  const now = new Date();
  const history = await loadCleanupPlaybackHistory(userId, now);
  const catalog = await createCleanupRecordingLookup(userId, budget);
  const result = await resolveCleanupRecordingEvidence({ userId, now, ...history, lookup: catalog.lookup,
    candidates: candidates.map(c => ({ uri: c.uri, aliases: c.spotifyTrackId ? [c.spotifyTrackId] : [],
      isTrack: true, isLocal: false,
      recording: { title: c.title, artistId: c.primaryArtistId ?? null,
        artistName: c.primaryArtistName ?? c.subtitle ?? null, durationMs: c.durationMs, isrc: null } })),
  });
  const byUri = new Map(result.assessments.map(a => [a.uri, a]));
  console.log(JSON.stringify({
    mode: "SOURCE_CACHE_DIAGNOSTIC_NOT_REMOVAL_AUTHORIZATION", generatedAt: now.toISOString(),
    sourceName: source.name, cachedItemCount: candidates.length, cacheUpdatedAt: source.cacheUpdatedAt,
    sourceRetentionMode: source.musicRetentionMode, automationEnabled: source.musicCleanupAutomationEnabled,
    coverage: "PERSISTED_SPOTIFY_FACTS_AND_CACHED_SOURCE_ONLY",
    authority: { playlistWrites: false, cleanupAuditWrites: false, identityWrites: false,
      sourceCacheWrites: false, providerCatalogReadsAllowed: budget > 0,
      operationalCredentialRefreshMayWrite: budget > 0, operationalBackoffMayWrite: budget > 0,
      catalogCacheMayWrite: budget > 0 },
    catalog: catalog.metrics(),
    rows: candidates.map(c => ({ title: c.title, artist: c.primaryArtistName ?? c.subtitle,
      decision: c.spotifyTrackId && history.playedTrackIds.has(c.spotifyTrackId)
        ? "DIRECT_PLAYBACK" : byUri.get(c.uri)?.decision ?? "NO_CONFIRMED_RECORDING_FACT" })),
  }, null, 2));
}

main().catch(error => {
  const knownArgumentError = error instanceof Error && /^(Unknown or duplicate|Use --user|Catalog reads require)/.test(error.message);
  const diagnostic = error as { name?: string; kind?: string; status?: number } | null;
  console.error(knownArgumentError ? (error as Error).message : JSON.stringify({
    error: "Cleanup diagnostic failed", name: diagnostic?.name,
    kind: diagnostic?.kind, status: diagnostic?.status,
  }));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
