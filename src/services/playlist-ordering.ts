import { createHash } from "node:crypto";

export type MusicOrderMode = "STANDARD" | "RANDOMIZED";

export type OrderablePlaylistItem = {
  uri: string;
  type: "MUSIC" | "PODCAST";
  position: number;
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

function rankingKey(seed: string, item: OrderablePlaylistItem, originalIndex: number) {
  return createHash("sha256")
    .update(`${seed}\0${originalIndex}\0${item.uri}`)
    .digest("hex");
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
 */
export function applyMusicOrder<T extends OrderablePlaylistItem>(
  items: T[],
  mode: MusicOrderMode,
  seed: string | null,
  seedSource: MusicOrderEvidence["seedSource"] = seed ? "RUN" : null,
): { items: T[]; evidence: MusicOrderEvidence } {
  if (mode === "STANDARD") {
    const result = items.map((item) => ({ ...item })) as T[];
    return {
      items: result,
      evidence: {
        mode,
        seed: null,
        seedSource: null,
        changed: false,
        musicCount: result.filter((item) => item.type === "MUSIC").length,
        orderHash: playlistOrderHash(result),
      },
    };
  }

  if (!seed) throw new Error("RANDOMIZED music order requires a seed");

  const originalMusic = items.filter((item) => item.type === "MUSIC");
  const rankedMusic = originalMusic
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      key: rankingKey(seed, item, originalIndex),
    }))
    .sort((left, right) =>
      left.key === right.key
        ? left.originalIndex - right.originalIndex
        : left.key.localeCompare(right.key),
    )
    .map((entry) => entry.item);

  let musicIndex = 0;
  const result = items.map((slot) => {
    if (slot.type !== "MUSIC") return { ...slot } as T;
    const selected = rankedMusic[musicIndex++]!;
    return { ...selected, position: slot.position } as T;
  });

  const originalMusicUris = originalMusic.map((item) => item.uri);
  const finalMusicUris = result
    .filter((item) => item.type === "MUSIC")
    .map((item) => item.uri);

  return {
    items: result,
    evidence: {
      mode,
      seed,
      seedSource,
      changed: originalMusicUris.some((uri, index) => finalMusicUris[index] !== uri),
      musicCount: originalMusic.length,
      orderHash: playlistOrderHash(result),
    },
  };
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
