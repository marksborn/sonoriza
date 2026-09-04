import { createHash } from "node:crypto";

import { applyMusic06PlannerInfluenceForCurrentRun } from "@/services/music-preference/lastfm-planner-runtime";

export type MusicOrderMode = "STANDARD" | "RANDOMIZED";

export type OrderablePlaylistItem = {
  uri: string;
  type: "MUSIC" | "PODCAST";
  position: number;
  /** CALENDAR-02: items with a block index are randomized/reranked only inside that block. */
  planningBlockIndex?: number;
  /** MUSIC-06 optional identity metadata. Absent fields make the item non-matchable, not unsafe. */
  title?: string | null;
  subtitle?: string | null;
  spotifyTrackId?: string | null;
  primaryArtistId?: string | null;
  primaryArtistName?: string | null;
};

export type MusicOrderEvidence = {
  mode: MusicOrderMode;
  seed: string | null;
  seedSource: "RUN" | "SIMULATION" | null;
  changed: boolean;
  musicCount: number;
  orderHash: string;
};

export function createMusicOrderSeed(runId: string, targetPlaylistId: string): string {
  return createHash("sha256")
    .update(`ORDER-01\0${runId}\0${targetPlaylistId}`)
    .digest("hex")
    .slice(0, 32);
}

function rankingKey(
  seed: string,
  group: string,
  item: OrderablePlaylistItem,
  originalIndex: number,
) {
  // Backward compatibility: the legacy whole-target path must retain the exact
  // ORDER-01 ranking function so an unrelated CALENDAR-02 deploy does not
  // change existing STANDARD/RANDOMIZED semantics.
  const payload =
    group === "whole-target"
      ? `${seed}\0${originalIndex}\0${item.uri}`
      : `${seed}\0${group}\0${originalIndex}\0${item.uri}`;
  return createHash("sha256").update(payload).digest("hex");
}

function orderGroup(item: OrderablePlaylistItem): string {
  return item.planningBlockIndex === undefined
    ? "whole-target"
    : `block:${item.planningBlockIndex}`;
}

export function playlistOrderHash(items: OrderablePlaylistItem[]) {
  return createHash("sha256")
    .update(items.map((item) => `${item.position}:${item.type}:${item.uri}`).join("\n"))
    .digest("hex");
}

/**
 * ORDER-01 runs strictly after selection. RANDOMIZED reassigns only MUSIC
 * identities among positions that are already MUSIC slots. Podcast positions,
 * the type pattern, selected URI set and total duration are untouched.
 *
 * CALENDAR-02 narrows that same operation to each planning block. This prevents
 * differently-sized music items from moving across event boundaries after the
 * segmented planner has already proved that every item fits its own budget.
 *
 * MUSIC-06 Gate 5B then receives the post-ORDER-01 sequence. Its runtime hook is
 * a no-op unless explicitly enabled/allowlisted with READY Last.fm evidence.
 * When active it may only perform the same bounded MUSIC rerank validated in
 * Gate 5A, preserving candidate set, podcast slots and planning blocks.
 */
export function applyMusicOrder<T extends OrderablePlaylistItem>(
  items: T[],
  mode: MusicOrderMode,
  seed: string | null,
  seedSource: MusicOrderEvidence["seedSource"] = seed ? "RUN" : null,
): { items: T[]; evidence: MusicOrderEvidence } {
  const originalMusicUris = musicUris(items);

  if (mode === "STANDARD") {
    const standard = items.map((item) => ({ ...item })) as T[];
    const result = applyMusic06PlannerInfluenceForCurrentRun(standard);
    const finalMusicUris = musicUris(result);
    return {
      items: result,
      evidence: {
        mode,
        seed: null,
        seedSource: null,
        changed: musicOrderChanged(originalMusicUris, finalMusicUris),
        musicCount: finalMusicUris.length,
        orderHash: playlistOrderHash(result),
      },
    };
  }

  if (!seed) throw new Error("RANDOMIZED music order requires a seed");

  const rankedByGroup = new Map<string, T[]>();
  const musicIndexByGroup = new Map<string, number>();

  for (const [group, groupItems] of groupMusic(items)) {
    rankedByGroup.set(
      group,
      groupItems
        .map(({ item, originalIndex }) => ({
          item,
          originalIndex,
          key: rankingKey(seed, group, item, originalIndex),
        }))
        .sort((left, right) =>
          left.key === right.key
            ? left.originalIndex - right.originalIndex
            : left.key.localeCompare(right.key),
        )
        .map((entry) => entry.item),
    );
    musicIndexByGroup.set(group, 0);
  }

  const randomized = items.map((slot) => {
    if (slot.type !== "MUSIC") return { ...slot } as T;
    const group = orderGroup(slot);
    const ranked = rankedByGroup.get(group) ?? [];
    const index = musicIndexByGroup.get(group) ?? 0;
    const selected = ranked[index];
    if (!selected) throw new Error(`Missing randomized music for ${group}`);
    musicIndexByGroup.set(group, index + 1);
    return {
      ...selected,
      position: slot.position,
      ...(slot.planningBlockIndex === undefined
        ? {}
        : { planningBlockIndex: slot.planningBlockIndex }),
    } as T;
  });

  const result = applyMusic06PlannerInfluenceForCurrentRun(randomized);
  const finalMusicUris = musicUris(result);

  return {
    items: result,
    evidence: {
      mode,
      seed,
      seedSource,
      changed: musicOrderChanged(originalMusicUris, finalMusicUris),
      musicCount: originalMusicUris.length,
      orderHash: playlistOrderHash(result),
    },
  };
}

function musicUris(items: readonly OrderablePlaylistItem[]): string[] {
  return items.filter((item) => item.type === "MUSIC").map((item) => item.uri);
}

function musicOrderChanged(original: readonly string[], final: readonly string[]): boolean {
  if (original.length !== final.length) return true;
  return original.some((uri, index) => final[index] !== uri);
}

function groupMusic<T extends OrderablePlaylistItem>(
  items: T[],
): Map<string, Array<{ item: T; originalIndex: number }>> {
  const groups = new Map<string, Array<{ item: T; originalIndex: number }>>();
  items.forEach((item, originalIndex) => {
    if (item.type !== "MUSIC") return;
    const group = orderGroup(item);
    const current = groups.get(group) ?? [];
    current.push({ item, originalIndex });
    groups.set(group, current);
  });
  return groups;
}

export type ReusableMusicOrderEvidence = {
  seed: string;
  orderHash: string;
};

export function readMusicOrderEvidenceFromSummary(
  summary: unknown,
): Record<string, ReusableMusicOrderEvidence> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return {};

  const result: Record<string, ReusableMusicOrderEvidence> = {};
  for (const entry of targets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const target = entry as Record<string, unknown>;
    if (
      target.musicOrderMode === "RANDOMIZED" &&
      typeof target.targetPlaylistId === "string" &&
      typeof target.musicOrderSeed === "string" &&
      target.musicOrderSeed.length > 0 &&
      typeof target.musicOrderHash === "string" &&
      target.musicOrderHash.length > 0
    ) {
      result[target.targetPlaylistId] = {
        seed: target.musicOrderSeed,
        orderHash: target.musicOrderHash,
      };
    }
  }
  return result;
}
