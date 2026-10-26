import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CANONICAL_COOLDOWN_APPROVAL, buildCanonicalCooldown, emptyCanonicalCooldown,
  resolveCanonicalCooldownScope, type CanonicalCooldownRef,
} from "./canonical-factual-cooldown";

export const CANONICAL_COOLDOWN_FACT_LIMIT = 20_000;
export const CANONICAL_COOLDOWN_REF_LIMIT = 10_000;
const refSelect = {
  userId: true, provider: true, providerScope: true, providerTrackId: true,
  recordingIdentityId: true, matchReason: true, confidenceBasisPoints: true,
  isrc: true, trackMbid: true, resolutionLineage: true,
  recording: { select: { versionClass: true,
    song: { select: { canonicalTitle: true, primaryArtist: { select: { canonicalName: true } } } } } },
} satisfies Prisma.TrackProviderRefSelect;
type RefRow = Prisma.TrackProviderRefGetPayload<{ select: typeof refSelect }>;
function mapRef(row: RefRow): CanonicalCooldownRef {
  const { recording, ...ref } = row;
  return { ...ref, versionClass: recording.versionClass, canonicalTitle: recording.song.canonicalTitle,
    canonicalArtist: recording.song.primaryArtist.canonicalName };
}
function assertBound(rows: readonly unknown[], bound: number) {
  if (rows.length > bound) throw new Error("Canonical evidence limit exceeded");
}

/** DB-only, fresh, bounded evidence. No provider client, graph write or dedupe projection. */
export async function prepareCanonicalFactualCooldown(input: {
  userId: string; targetIds?: readonly string[]; asOf: Date; cutoff: Date | null;
  factualReady: boolean; legacyActive: boolean;
}) {
  const scope = resolveCanonicalCooldownScope({ userId: input.userId, targetIds: input.targetIds,
    mode: process.env.MUSIC_REPEAT_CANONICAL_MODE, allowlist: process.env.MUSIC_REPEAT_CANONICAL_ALLOWLIST });
  if (scope.mode === "OFF") return emptyCanonicalCooldown(scope);
  if (!scope.targetId) return emptyCanonicalCooldown(scope, "EVIDENCE_UNAVAILABLE");
  if (!input.factualReady || !input.cutoff || (scope.mode === "ACTIVE" && !input.legacyActive)) {
    return emptyCanonicalCooldown(scope, "FACTUAL_NOT_READY");
  }
  // A narrowly scoped personal consumer review, not a change to the global matrix.
  // Unknown/imported origins never become approved through this setting.
  if (scope.mode === "ACTIVE" && process.env.MUSIC_REPEAT_CANONICAL_APPROVED_USE !== CANONICAL_COOLDOWN_APPROVAL) {
    return emptyCanonicalCooldown(scope, "POLICY_NOT_APPROVED");
  }
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const target = await tx.targetPlaylist.findFirst({ where: { id: scope.targetId!, userId: input.userId, enabled: true }, select: { id: true } });
      if (!target) throw new Error("Canonical target unavailable");
      const facts = await tx.trackListeningEvent.findMany({
        where: { userId: input.userId, source: "LASTFM_SCROBBLE", spotifyTrackId: { not: null },
          playedAt: { gte: input.cutoff!, lte: input.asOf } },
        select: { userId: true, source: true, spotifyTrackId: true, trackName: true, artistName: true,
          isrc: true, trackMbid: true, playedAt: true, metadata: true },
        take: CANONICAL_COOLDOWN_FACT_LIMIT + 1, orderBy: { id: "asc" },
      });
      assertBound(facts, CANONICAL_COOLDOWN_FACT_LIMIT);
      const ids = [...new Set(facts.flatMap(f => f.spotifyTrackId ? [f.spotifyTrackId] : []))];
      const anchors = ids.length ? await tx.trackProviderRef.findMany({
        where: { userId: input.userId, provider: "spotify", providerScope: "global", providerTrackId: { in: ids } },
        select: refSelect, take: CANONICAL_COOLDOWN_REF_LIMIT + 1, orderBy: { id: "asc" },
      }) : [];
      assertBound(anchors, CANONICAL_COOLDOWN_REF_LIMIT);
      const recordingIds = [...new Set(anchors.map(r => r.recordingIdentityId))];
      const refs = recordingIds.length ? await tx.trackProviderRef.findMany({
        where: { userId: input.userId, provider: "spotify", providerScope: "global", recordingIdentityId: { in: recordingIds } },
        select: refSelect, take: CANONICAL_COOLDOWN_REF_LIMIT + 1, orderBy: { id: "asc" },
      }) : [];
      assertBound(refs, CANONICAL_COOLDOWN_REF_LIMIT);
      return buildCanonicalCooldown({ userId: input.userId, scope, cutoff: input.cutoff!, asOf: input.asOf,
        facts, refs: refs.map(mapRef) });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 });
  } catch {
    // SQL errors/limits are not empty evidence. ACTIVE callers must block.
    return emptyCanonicalCooldown(scope, "EVIDENCE_UNAVAILABLE");
  }
}
