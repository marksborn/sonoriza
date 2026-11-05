import { prisma } from "@/lib/prisma";

import {
  FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX,
  firstPartySpotifyTrackSubjectKey,
} from "./first-party-planner-preferences";
import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  prismaFirstPartyPlaybackPreferenceStore,
  type FirstPartyPlaybackPreferenceStore,
} from "./first-party-playback-preference-store";

/**
 * MUSIC-08 (#319): "não tocar mais" as an explicit, reversible, per-user
 * decision on one exact Spotify recording. It never touches listening history
 * or cooldown, and nothing but a user action creates one.
 */

const SPOTIFY_TRACK_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

export function isSpotifyTrackId(value: unknown): value is string {
  return typeof value === "string" && SPOTIFY_TRACK_ID_PATTERN.test(value);
}

export function excludedSpotifyTrackIds(
  preferences: readonly FirstPartyPlaybackPreference[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const preference of preferences) {
    if (preference.subjectType !== "TRACK" || preference.policy !== "EXCLUDED") continue;
    if (!preference.subjectKey.startsWith(FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX)) continue;
    const id = preference.subjectKey.slice(FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX.length).trim();
    if (id) ids.add(id);
  }
  return ids;
}

export async function loadExcludedSpotifyTrackIds(
  userId: string,
  store: FirstPartyPlaybackPreferenceStore = prismaFirstPartyPlaybackPreferenceStore,
): Promise<ReadonlySet<string>> {
  return excludedSpotifyTrackIds(await store.list(userId, "TRACK"));
}

export async function excludeTrackForUser(
  userId: string,
  spotifyTrackId: string,
  store: FirstPartyPlaybackPreferenceStore = prismaFirstPartyPlaybackPreferenceStore,
): Promise<void> {
  if (!isSpotifyTrackId(spotifyTrackId)) throw new Error("Invalid Spotify track id");
  await store.set({
    userId,
    subjectType: "TRACK",
    subjectKey: firstPartySpotifyTrackSubjectKey(spotifyTrackId),
    policy: "EXCLUDED",
    source: "USER_EXPLICIT",
  });
}

/** Removes only an exclusion: any other preference on the track stays. */
export async function restoreTrackForUser(
  userId: string,
  spotifyTrackId: string,
  store: FirstPartyPlaybackPreferenceStore = prismaFirstPartyPlaybackPreferenceStore,
): Promise<boolean> {
  if (!isSpotifyTrackId(spotifyTrackId)) throw new Error("Invalid Spotify track id");
  const excluded = await loadExcludedSpotifyTrackIds(userId, store);
  if (!excluded.has(spotifyTrackId)) return false;
  return store.remove(userId, "TRACK", firstPartySpotifyTrackSubjectKey(spotifyTrackId));
}

export type ExcludedTrackRow = Readonly<{
  spotifyTrackId: string;
  title: string | null;
  subtitle: string | null;
  excludedAt: Date;
}>;

/** Labels come from the user's own generations; no provider call. */
export async function listExcludedTracksForUser(userId: string): Promise<ExcludedTrackRow[]> {
  const preferences = (
    await prismaFirstPartyPlaybackPreferenceStore.list(userId, "TRACK")
  ).filter((preference) => preference.policy === "EXCLUDED");
  const rows = preferences.flatMap((preference) => {
    const [id] = excludedSpotifyTrackIds([preference]);
    return id ? [{ spotifyTrackId: id, excludedAt: preference.updatedAt }] : [];
  });
  if (rows.length === 0) return [];

  const labels = await prisma.generationItem.findMany({
    where: {
      spotifyTrackId: { in: rows.map((row) => row.spotifyTrackId) },
      run: { userId },
    },
    distinct: ["spotifyTrackId"],
    select: { spotifyTrackId: true, title: true, subtitle: true },
  });
  const labelById = new Map(labels.map((label) => [label.spotifyTrackId, label]));
  return rows
    .map((row) => ({
      ...row,
      title: labelById.get(row.spotifyTrackId)?.title ?? null,
      subtitle: labelById.get(row.spotifyTrackId)?.subtitle ?? null,
    }))
    .sort((a, b) => b.excludedAt.getTime() - a.excludedAt.getTime());
}
