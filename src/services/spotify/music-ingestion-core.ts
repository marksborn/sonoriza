export type MusicIngestionTrack = {
  spotifyTrackId: string;
  uri: string;
  title: string;
  subtitle?: string;
  durationMs: number;
  albumId?: string;
  albumType?: string;
  discNumber?: number;
  trackNumber?: number;
};

export type SavedTrackEvent = {
  addedAt: string;
  track: MusicIngestionTrack;
};

export type PlaylistRuleState = {
  version: 1;
  kind: "PLAYLIST_COPY";
  initialized: true;
  snapshotId: string;
  trackCounts: Record<string, number>;
};

export type SavedRuleState = {
  version: 1;
  kind: "SAVED_TRACK" | "SAVED_TRACK_ALBUM";
  initialized: true;
  watermarkAddedAt: string | null;
  boundaryTrackIds: string[];
};

export type IngestionRuleState = PlaylistRuleState | SavedRuleState;

export type IngestionOrigin = {
  kind: "PLAYLIST_COPY" | "SAVED_TRACK" | "SAVED_TRACK_ALBUM" | "MANUAL";
  sourceSpotifyId?: string;
  eventTrackId?: string;
  eventAddedAt?: string;
  albumId?: string;
};

export type IngestionCandidate = {
  track: MusicIngestionTrack;
  origin: IngestionOrigin;
};

export type IngestionPlan = {
  add: IngestionCandidate[];
  duplicate: IngestionCandidate[];
  cooldown: IngestionCandidate[];
};

export function parseIngestionRuleState(value: unknown): IngestionRuleState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || state.initialized !== true || typeof state.kind !== "string") {
    return null;
  }

  if (state.kind === "PLAYLIST_COPY") {
    if (typeof state.snapshotId !== "string" || !state.snapshotId) return null;
    if (!state.trackCounts || typeof state.trackCounts !== "object" || Array.isArray(state.trackCounts)) {
      return null;
    }
    const trackCounts: Record<string, number> = {};
    for (const [trackId, count] of Object.entries(state.trackCounts as Record<string, unknown>)) {
      if (!trackId || typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
      trackCounts[trackId] = count;
    }
    return {
      version: 1,
      kind: "PLAYLIST_COPY",
      initialized: true,
      snapshotId: state.snapshotId,
      trackCounts,
    };
  }

  if (state.kind === "SAVED_TRACK" || state.kind === "SAVED_TRACK_ALBUM") {
    const watermarkAddedAt = state.watermarkAddedAt;
    if (!(watermarkAddedAt === null || typeof watermarkAddedAt === "string")) return null;
    if (!Array.isArray(state.boundaryTrackIds) || !state.boundaryTrackIds.every((id) => typeof id === "string" && id)) {
      return null;
    }
    return {
      version: 1,
      kind: state.kind,
      initialized: true,
      watermarkAddedAt,
      boundaryTrackIds: [...new Set(state.boundaryTrackIds as string[])],
    };
  }

  return null;
}

export function playlistTrackCounts(tracks: MusicIngestionTrack[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const track of tracks) counts[track.spotifyTrackId] = (counts[track.spotifyTrackId] ?? 0) + 1;
  return counts;
}

export function createPlaylistRuleState(
  snapshotId: string,
  tracks: MusicIngestionTrack[],
): PlaylistRuleState {
  return {
    version: 1,
    kind: "PLAYLIST_COPY",
    initialized: true,
    snapshotId,
    trackCounts: playlistTrackCounts(tracks),
  };
}

/**
 * Returns only occurrences that were added since the prior observed version.
 * Counts, rather than a forever-seen set, are intentional: removing an
 * occurrence from the discovery source and adding it again later is a new
 * event, while a MUSIC-02 removal from the target inbox does not affect this
 * source state and therefore cannot resurrect an old event.
 */
export function playlistNewOccurrences(
  previous: PlaylistRuleState | null,
  currentTracks: MusicIngestionTrack[],
): MusicIngestionTrack[] {
  if (!previous) return currentTracks;
  const remaining = { ...playlistTrackCounts(currentTracks) };
  for (const [trackId, priorCount] of Object.entries(previous.trackCounts)) {
    remaining[trackId] = Math.max(0, (remaining[trackId] ?? 0) - priorCount);
  }

  const out: MusicIngestionTrack[] = [];
  for (const track of currentTracks) {
    const count = remaining[track.spotifyTrackId] ?? 0;
    if (count <= 0) continue;
    out.push(track);
    remaining[track.spotifyTrackId] = count - 1;
  }
  return out;
}

export function createSavedRuleState(
  kind: "SAVED_TRACK" | "SAVED_TRACK_ALBUM",
  events: SavedTrackEvent[],
  previous: SavedRuleState | null = null,
): SavedRuleState {
  let watermarkAddedAt = previous?.watermarkAddedAt ?? null;
  const boundary = new Set(previous?.boundaryTrackIds ?? []);

  for (const event of events) {
    if (!watermarkAddedAt || event.addedAt > watermarkAddedAt) {
      watermarkAddedAt = event.addedAt;
      boundary.clear();
      boundary.add(event.track.spotifyTrackId);
    } else if (event.addedAt === watermarkAddedAt) {
      boundary.add(event.track.spotifyTrackId);
    }
  }

  return {
    version: 1,
    kind,
    initialized: true,
    watermarkAddedAt,
    boundaryTrackIds: [...boundary].sort(),
  };
}

export function savedTrackNewEvents(
  previous: SavedRuleState | null,
  events: SavedTrackEvent[],
): SavedTrackEvent[] {
  if (!previous?.watermarkAddedAt) return events;
  const boundary = new Set(previous.boundaryTrackIds);
  return events.filter(
    (event) =>
      event.addedAt > previous.watermarkAddedAt! ||
      (event.addedAt === previous.watermarkAddedAt && !boundary.has(event.track.spotifyTrackId)),
  );
}

export function planMusicIngestion(
  incoming: IngestionCandidate[],
  existingTargetTrackIds: ReadonlySet<string>,
  blockedTrackIds: ReadonlySet<string>,
): IngestionPlan {
  const add: IngestionCandidate[] = [];
  const duplicate: IngestionCandidate[] = [];
  const cooldown: IngestionCandidate[] = [];
  const selected = new Set<string>();

  for (const candidate of incoming) {
    const trackId = candidate.track.spotifyTrackId;
    if (blockedTrackIds.has(trackId)) {
      cooldown.push(candidate);
      continue;
    }
    if (existingTargetTrackIds.has(trackId) || selected.has(trackId)) {
      duplicate.push(candidate);
      continue;
    }
    selected.add(trackId);
    add.push(candidate);
  }

  return { add, duplicate, cooldown };
}

export function sortAlbumTracks<T extends MusicIngestionTrack>(tracks: T[]): T[] {
  return [...tracks].sort((a, b) => {
    const disc = (a.discNumber ?? Number.MAX_SAFE_INTEGER) - (b.discNumber ?? Number.MAX_SAFE_INTEGER);
    if (disc !== 0) return disc;
    const track = (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER);
    if (track !== 0) return track;
    return a.spotifyTrackId.localeCompare(b.spotifyTrackId);
  });
}

export type SpotifyReference =
  | { type: "track"; id: string }
  | { type: "album"; id: string };

export function parseSpotifyReference(value: string): SpotifyReference | null {
  const trimmed = value.trim();
  let match = /^spotify:(track|album):([A-Za-z0-9]+)$/.exec(trimmed);
  if (match) return { type: match[1] as "track" | "album", id: match[2] };

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "open.spotify.com") return null;
    match = /^\/(track|album)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    return { type: match[1] as "track" | "album", id: match[2] };
  } catch {
    return null;
  }
}
