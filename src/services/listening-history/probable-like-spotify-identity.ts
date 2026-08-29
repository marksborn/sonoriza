import { prisma } from "@/lib/prisma";
import {
  SpotifyCatalogSearchClient,
  type SpotifyCatalogTrackSummary,
} from "@/services/spotify/catalog-search";

export type HistoricalSpotifyTrackEvidence = {
  historicalSpotifyTrackId: string;
  trackName: string;
  artistName: string;
  primaryArtistId: string | null;
  albumName: string | null;
  isrc: string | null;
};

export type HistoricalSpotifyTrackFallbackEvidence = Omit<
  HistoricalSpotifyTrackEvidence,
  "historicalSpotifyTrackId"
>;

export type ResolvedProbableLikeSpotifyIdentity = {
  historicalSpotifyTrackId: string;
  spotifyTrackId: string;
  spotifyUri: string;
  spotifyUrl: string;
  trackName: string;
  primaryArtistId: string;
  primaryArtistName: string;
  albumId: string | null;
  albumName: string | null;
  durationMs: number;
  isrc: string | null;
  resolution:
    | "HISTORICAL_ID_STILL_CURRENT"
    | "ISRC_MATCH"
    | "TRACK_ARTIST_ALBUM_MATCH"
    | "TRACK_ARTIST_MATCH";
};

type SearchTracks = (input: {
  userId: string;
  trackName: string;
  artistName: string;
}) => Promise<SpotifyCatalogTrackSummary[]>;

export async function resolveProbableLikeSpotifyIdentity(
  input: {
    userId: string;
    historicalSpotifyTrackId: string;
    fallbackEvidence?: HistoricalSpotifyTrackFallbackEvidence;
  },
  dependencies: { searchTracks?: SearchTracks } = {},
): Promise<ResolvedProbableLikeSpotifyIdentity> {
  const evidence = await loadHistoricalSpotifyTrackEvidence(input);
  const searchTracks = dependencies.searchTracks ?? searchSpotifyTracks;

  for (const artistName of spotifySearchArtistNames(evidence.artistName)) {
    const matches = await searchTracks({
      userId: input.userId,
      trackName: evidence.trackName,
      artistName,
    });
    const selected = selectStrongSpotifyTrackMatch(evidence, matches);
    if (!selected) continue;

    return {
      historicalSpotifyTrackId: evidence.historicalSpotifyTrackId,
      spotifyTrackId: selected.track.id,
      spotifyUri: selected.track.uri,
      spotifyUrl:
        selected.track.spotifyUrl ??
        `https://open.spotify.com/track/${encodeURIComponent(selected.track.id)}`,
      trackName: selected.track.name,
      primaryArtistId: selected.track.artists[0]!.id,
      primaryArtistName: selected.track.artists[0]!.name,
      albumId: selected.track.albumId,
      albumName: selected.track.albumName,
      durationMs: selected.track.durationMs,
      isrc: selected.track.isrc,
      resolution: selected.resolution,
    };
  }

  throw new ProbableLikeSpotifyIdentityNotResolvedError(evidence);
}

export async function loadHistoricalSpotifyTrackEvidence(input: {
  userId: string;
  historicalSpotifyTrackId: string;
  fallbackEvidence?: HistoricalSpotifyTrackFallbackEvidence;
}): Promise<HistoricalSpotifyTrackEvidence> {
  const event = await prisma.trackListeningEvent.findFirst({
    where: {
      userId: input.userId,
      spotifyTrackId: input.historicalSpotifyTrackId,
    },
    orderBy: [{ playedAt: "desc" }, { id: "desc" }],
    select: {
      trackName: true,
      artistName: true,
      primaryArtistId: true,
      albumName: true,
      isrc: true,
    },
  });
  if (event) {
    return {
      historicalSpotifyTrackId: input.historicalSpotifyTrackId,
      trackName: event.trackName,
      artistName: event.artistName,
      primaryArtistId: event.primaryArtistId,
      albumName: event.albumName,
      isrc: event.isrc,
    };
  }

  if (input.fallbackEvidence) {
    return {
      historicalSpotifyTrackId: input.historicalSpotifyTrackId,
      ...input.fallbackEvidence,
    };
  }

  throw new ProbableLikeSpotifyIdentityNotResolvedError({
    historicalSpotifyTrackId: input.historicalSpotifyTrackId,
    trackName: "Faixa histórica",
    artistName: "Artista desconhecido",
    primaryArtistId: null,
    albumName: null,
    isrc: null,
  });
}

export function selectStrongSpotifyTrackMatch(
  evidence: HistoricalSpotifyTrackEvidence,
  tracks: SpotifyCatalogTrackSummary[],
): {
  track: SpotifyCatalogTrackSummary;
  resolution: ResolvedProbableLikeSpotifyIdentity["resolution"];
} | null {
  const exactTitle = tracks.filter(
    (track) =>
      normalizeIdentityText(track.name) === normalizeIdentityText(evidence.trackName),
  );
  if (exactTitle.length === 0) return null;

  const sameHistoricalId = exactTitle.find(
    (track) => track.id === evidence.historicalSpotifyTrackId,
  );
  if (sameHistoricalId) {
    return {
      track: sameHistoricalId,
      resolution: "HISTORICAL_ID_STILL_CURRENT",
    };
  }

  // ISRC identifies the recording itself and is stronger than presentation
  // differences in artist strings (for example Spotify's joined collaborators).
  const evidenceIsrc = normalizeIsrc(evidence.isrc);
  if (evidenceIsrc) {
    const sameIsrc = exactTitle.filter(
      (track) => normalizeIsrc(track.isrc) === evidenceIsrc,
    );
    if (sameIsrc.length > 0) {
      return {
        track: preferAlbumMatch(evidence, sameIsrc) ?? sameIsrc[0]!,
        resolution: "ISRC_MATCH",
      };
    }
  }

  const exactTrackArtist = exactTitle.filter((track) =>
    trackMatchesHistoricalArtist(evidence, track),
  );
  if (exactTrackArtist.length === 0) return null;

  const sameAlbum = exactTrackArtist.filter(
    (track) =>
      evidence.albumName !== null &&
      track.albumName !== null &&
      normalizeIdentityText(track.albumName) === normalizeIdentityText(evidence.albumName),
  );
  if (sameAlbum.length === 1) {
    return {
      track: sameAlbum[0]!,
      resolution: "TRACK_ARTIST_ALBUM_MATCH",
    };
  }

  if (exactTrackArtist.length === 1) {
    return {
      track: exactTrackArtist[0]!,
      resolution: "TRACK_ARTIST_MATCH",
    };
  }

  const nonNullIsrcs = new Set(
    exactTrackArtist
      .map((track) => normalizeIsrc(track.isrc))
      .filter((value): value is string => Boolean(value)),
  );
  if (nonNullIsrcs.size === 1) {
    return {
      track: preferAlbumMatch(evidence, exactTrackArtist) ?? exactTrackArtist[0]!,
      resolution: "TRACK_ARTIST_MATCH",
    };
  }

  return null;
}

export function probableLikeTrackIdentityKey(input: {
  trackName: string | null | undefined;
  artistName: string | null | undefined;
}): string | null {
  const trackName = normalizeIdentityText(input.trackName ?? "");
  const artistName = normalizeIdentityText(input.artistName ?? "");
  if (!trackName || !artistName) return null;
  return `${trackName}\u0000${artistName}`;
}

export class ProbableLikeSpotifyIdentityNotResolvedError extends Error {
  readonly evidence: HistoricalSpotifyTrackEvidence;

  constructor(evidence: HistoricalSpotifyTrackEvidence) {
    super(
      `Não foi possível localizar com segurança a versão atual de ${evidence.trackName} — ${evidence.artistName} no Spotify.`,
    );
    this.name = "ProbableLikeSpotifyIdentityNotResolvedError";
    this.evidence = evidence;
  }
}

async function searchSpotifyTracks(input: {
  userId: string;
  trackName: string;
  artistName: string;
}): Promise<SpotifyCatalogTrackSummary[]> {
  const client = await SpotifyCatalogSearchClient.forUser(input.userId);
  return client.searchTracks({
    trackName: input.trackName,
    artistName: input.artistName,
    limit: 10,
  });
}

function spotifySearchArtistNames(artistName: string): string[] {
  const full = artistName.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!full) return [];

  // Spotify Recently Played persists collaborations joined by `, `. Query the
  // exact display value first; only if it cannot resolve do we try the first
  // component as the provider's primary artist search hint. Strong matching
  // still validates the returned recording before use.
  const firstJoinedArtist = full.includes(", ") ? full.split(", ")[0]?.trim() : null;
  return [...new Set([full, firstJoinedArtist].filter((value): value is string => Boolean(value)))];
}

function trackMatchesHistoricalArtist(
  evidence: HistoricalSpotifyTrackEvidence,
  track: SpotifyCatalogTrackSummary,
): boolean {
  if (
    evidence.primaryArtistId &&
    track.artists.some((artist) => artist.id === evidence.primaryArtistId)
  ) {
    return true;
  }

  const historicalFull = normalizeIdentityText(evidence.artistName);
  const catalogNames = new Set(
    track.artists.map((artist) => normalizeIdentityText(artist.name)),
  );
  if (catalogNames.has(historicalFull)) return true;

  // Joined collaborators are accepted only when every stored component appears
  // among the catalog artists. This avoids treating a solo edition as the same
  // recording merely because the first collaborator has the same name.
  if (evidence.artistName.includes(", ")) {
    const historicalParts = evidence.artistName
      .split(", ")
      .map((value) => normalizeIdentityText(value))
      .filter(Boolean);
    return (
      historicalParts.length > 1 &&
      historicalParts.every((value) => catalogNames.has(value))
    );
  }

  return false;
}

function preferAlbumMatch(
  evidence: HistoricalSpotifyTrackEvidence,
  tracks: SpotifyCatalogTrackSummary[],
): SpotifyCatalogTrackSummary | null {
  const albumName = evidence.albumName;
  if (!albumName) return null;
  return (
    tracks.find(
      (track) =>
        track.albumName !== null &&
        normalizeIdentityText(track.albumName) === normalizeIdentityText(albumName),
    ) ?? null
  );
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeIsrc(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[^a-z0-9]/gi, "").toUpperCase() ?? "";
  return normalized || null;
}
