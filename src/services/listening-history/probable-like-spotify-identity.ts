import { prisma } from "@/lib/prisma";
import {
  SpotifyCatalogSearchClient,
  type SpotifyCatalogTrackSummary,
} from "@/services/spotify/catalog-search";

export type HistoricalSpotifyTrackEvidence = {
  historicalSpotifyTrackId: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  isrc: string | null;
};

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
  input: { userId: string; historicalSpotifyTrackId: string },
  dependencies: { searchTracks?: SearchTracks } = {},
): Promise<ResolvedProbableLikeSpotifyIdentity> {
  const evidence = await loadHistoricalSpotifyTrackEvidence(input);
  const searchTracks = dependencies.searchTracks ?? searchSpotifyTracks;
  const matches = await searchTracks({
    userId: input.userId,
    trackName: evidence.trackName,
    artistName: evidence.artistName,
  });
  const selected = selectStrongSpotifyTrackMatch(evidence, matches);
  if (!selected) {
    throw new ProbableLikeSpotifyIdentityNotResolvedError(evidence);
  }

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

export async function loadHistoricalSpotifyTrackEvidence(input: {
  userId: string;
  historicalSpotifyTrackId: string;
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
      albumName: true,
      isrc: true,
    },
  });
  if (!event) {
    throw new ProbableLikeSpotifyIdentityNotResolvedError({
      historicalSpotifyTrackId: input.historicalSpotifyTrackId,
      trackName: "Faixa histórica",
      artistName: "Artista desconhecido",
      albumName: null,
      isrc: null,
    });
  }

  return {
    historicalSpotifyTrackId: input.historicalSpotifyTrackId,
    trackName: event.trackName,
    artistName: event.artistName,
    albumName: event.albumName,
    isrc: event.isrc,
  };
}

export function selectStrongSpotifyTrackMatch(
  evidence: HistoricalSpotifyTrackEvidence,
  tracks: SpotifyCatalogTrackSummary[],
): {
  track: SpotifyCatalogTrackSummary;
  resolution: ResolvedProbableLikeSpotifyIdentity["resolution"];
} | null {
  const exactTrackArtist = tracks.filter(
    (track) =>
      normalizeIdentityText(track.name) === normalizeIdentityText(evidence.trackName) &&
      track.artists.some(
        (artist) =>
          normalizeIdentityText(artist.name) === normalizeIdentityText(evidence.artistName),
      ),
  );
  if (exactTrackArtist.length === 0) return null;

  const sameHistoricalId = exactTrackArtist.find(
    (track) => track.id === evidence.historicalSpotifyTrackId,
  );
  if (sameHistoricalId) {
    return {
      track: sameHistoricalId,
      resolution: "HISTORICAL_ID_STILL_CURRENT",
    };
  }

  if (evidence.isrc) {
    const sameIsrc = exactTrackArtist.filter(
      (track) => normalizeIsrc(track.isrc) === normalizeIsrc(evidence.isrc),
    );
    if (sameIsrc.length > 0) {
      return {
        track: preferAlbumMatch(evidence, sameIsrc) ?? sameIsrc[0]!,
        resolution: "ISRC_MATCH",
      };
    }
  }

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
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeIsrc(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[^a-z0-9]/gi, "").toUpperCase() ?? "";
  return normalized || null;
}
