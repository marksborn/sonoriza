import type {
  SpotifyCatalogArtistSummary,
  SpotifyCatalogTrackSummary,
} from "@/services/spotify/catalog-search";

export type SpotifyDiscoveryResolutionStatus = "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";

export type SpotifyDiscoveryResolutionCandidate = {
  candidateKey: string;
  candidateType: "ARTIST" | "TRACK";
  artistName: string;
  trackName: string | null;
  preferredSpotifyArtistId?: string | null;
};

export type SpotifyDiscoveryResolutionProvider = {
  searchArtists(artistName: string, limit?: number): Promise<SpotifyCatalogArtistSummary[]>;
  searchTracks(input: {
    artistName: string;
    trackName?: string | null;
    limit?: number;
  }): Promise<SpotifyCatalogTrackSummary[]>;
};

export type SpotifyDiscoveryResolution = {
  candidateKey: string;
  status: SpotifyDiscoveryResolutionStatus;
  reason:
    | "EXACT_TRACK_ARTIST_MATCH"
    | "EXACT_TRACK_ARTIST_SAME_ISRC_VARIANTS"
    | "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK"
    | "CONTROLLED_ARTIST_ALIAS_WITH_REPRESENTATIVE_TRACK"
    | "PREFERRED_SPOTIFY_ARTIST_ID_MATCH"
    | "ARTIST_NOT_FOUND"
    | "ARTIST_AMBIGUOUS"
    | "ARTIST_ID_CONFLICT"
    | "TRACK_NOT_FOUND"
    | "TRACK_AMBIGUOUS"
    | "REPRESENTATIVE_TRACK_NOT_FOUND";
  spotifyArtist: SpotifyCatalogArtistSummary | null;
  spotifyTrack: SpotifyCatalogTrackSummary | null;
  alternatives: Array<SpotifyCatalogArtistSummary | SpotifyCatalogTrackSummary>;
};

export type SpotifyDiscoveryResolutionBatch = {
  resolutions: SpotifyDiscoveryResolution[];
  failures: Array<{ candidateKey: string; error: string }>;
};

export async function resolveExternalDiscoveryCandidate(
  provider: SpotifyDiscoveryResolutionProvider,
  candidate: SpotifyDiscoveryResolutionCandidate,
): Promise<SpotifyDiscoveryResolution> {
  if (candidate.candidateType === "TRACK") {
    return resolveTrackCandidate(provider, candidate);
  }
  return resolveArtistCandidate(provider, candidate);
}

export async function resolveExternalDiscoveryCandidates(
  provider: SpotifyDiscoveryResolutionProvider,
  candidates: SpotifyDiscoveryResolutionCandidate[],
): Promise<SpotifyDiscoveryResolutionBatch> {
  const resolutions: SpotifyDiscoveryResolution[] = [];
  const failures: Array<{ candidateKey: string; error: string }> = [];

  for (const candidate of candidates) {
    try {
      resolutions.push(await resolveExternalDiscoveryCandidate(provider, candidate));
    } catch (error) {
      failures.push({
        candidateKey: candidate.candidateKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { resolutions, failures };
}

async function resolveTrackCandidate(
  provider: SpotifyDiscoveryResolutionProvider,
  candidate: SpotifyDiscoveryResolutionCandidate,
): Promise<SpotifyDiscoveryResolution> {
  if (!candidate.trackName) {
    return empty(candidate, "NOT_FOUND", "TRACK_NOT_FOUND");
  }

  const rows = await provider.searchTracks({
    artistName: candidate.artistName,
    trackName: candidate.trackName,
    limit: 10,
  });
  const exact = rows.filter(
    (row) =>
      normalized(row.name) === normalized(candidate.trackName!) &&
      row.artists.some((artist) => normalized(artist.name) === normalized(candidate.artistName)),
  );

  if (exact.length === 0) return empty(candidate, "NOT_FOUND", "TRACK_NOT_FOUND");

  const recordingGroups = groupTracksByRecording(exact);
  if (recordingGroups.length > 1) {
    return {
      candidateKey: candidate.candidateKey,
      status: "AMBIGUOUS",
      reason: "TRACK_AMBIGUOUS",
      spotifyArtist: null,
      spotifyTrack: null,
      alternatives: exact.slice(0, 10),
    };
  }

  const group = recordingGroups[0]!;
  const track = group[0]!;
  const artist =
    track.artists.find((row) => normalized(row.name) === normalized(candidate.artistName)) ?? null;
  return {
    candidateKey: candidate.candidateKey,
    status: "RESOLVED",
    reason:
      group.length > 1 && Boolean(track.isrc)
        ? "EXACT_TRACK_ARTIST_SAME_ISRC_VARIANTS"
        : "EXACT_TRACK_ARTIST_MATCH",
    spotifyArtist: artist,
    spotifyTrack: track,
    alternatives: group.length > 1 ? group.slice(1, 10) : [],
  };
}

async function resolveArtistCandidate(
  provider: SpotifyDiscoveryResolutionProvider,
  candidate: SpotifyDiscoveryResolutionCandidate,
): Promise<SpotifyDiscoveryResolution> {
  const artistRows = await provider.searchArtists(candidate.artistName, 10);
  let exactArtists = uniqueArtists(
    artistRows.filter((row) => normalized(row.name) === normalized(candidate.artistName)),
  );
  let usedControlledAlias = false;

  if (exactArtists.length === 0) {
    const alias = controlledLeadingArticleAlias(candidate.artistName);
    if (alias) {
      const aliasRows = await provider.searchArtists(alias, 10);
      exactArtists = uniqueArtists(
        aliasRows.filter((row) => normalized(row.name) === normalized(alias)),
      );
      usedControlledAlias = exactArtists.length > 0;
    }
  }

  if (exactArtists.length === 0) return empty(candidate, "NOT_FOUND", "ARTIST_NOT_FOUND");

  const preferredSpotifyArtistId = candidate.preferredSpotifyArtistId?.trim() || null;
  if (exactArtists.length > 1) {
    if (preferredSpotifyArtistId) {
      const preferred = exactArtists.find((row) => row.id === preferredSpotifyArtistId);
      if (preferred) {
        return resolvedArtistWithRepresentativeTrack(
          provider,
          candidate,
          preferred,
          "PREFERRED_SPOTIFY_ARTIST_ID_MATCH",
          exactArtists.filter((row) => row.id !== preferred.id).slice(0, 9),
        );
      }

      return {
        candidateKey: candidate.candidateKey,
        status: "AMBIGUOUS",
        reason: "ARTIST_ID_CONFLICT",
        spotifyArtist: null,
        spotifyTrack: null,
        alternatives: exactArtists.slice(0, 10),
      };
    }

    return {
      candidateKey: candidate.candidateKey,
      status: "AMBIGUOUS",
      reason: "ARTIST_AMBIGUOUS",
      spotifyArtist: null,
      spotifyTrack: null,
      alternatives: exactArtists.slice(0, 10),
    };
  }

  const artist = exactArtists[0]!;
  if (preferredSpotifyArtistId && artist.id !== preferredSpotifyArtistId) {
    return {
      candidateKey: candidate.candidateKey,
      status: "AMBIGUOUS",
      reason: "ARTIST_ID_CONFLICT",
      spotifyArtist: null,
      spotifyTrack: null,
      alternatives: [artist],
    };
  }

  return resolvedArtistWithRepresentativeTrack(
    provider,
    candidate,
    artist,
    usedControlledAlias
      ? "CONTROLLED_ARTIST_ALIAS_WITH_REPRESENTATIVE_TRACK"
      : "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK",
    [],
  );
}

async function resolvedArtistWithRepresentativeTrack(
  provider: SpotifyDiscoveryResolutionProvider,
  candidate: SpotifyDiscoveryResolutionCandidate,
  artist: SpotifyCatalogArtistSummary,
  reason:
    | "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK"
    | "CONTROLLED_ARTIST_ALIAS_WITH_REPRESENTATIVE_TRACK"
    | "PREFERRED_SPOTIFY_ARTIST_ID_MATCH",
  alternatives: SpotifyCatalogArtistSummary[],
): Promise<SpotifyDiscoveryResolution> {
  const tracks = await provider.searchTracks({ artistName: artist.name, limit: 10 });
  const representative = tracks.find((track) =>
    track.artists.some((row) => row.id === artist.id),
  );
  if (!representative) {
    return {
      candidateKey: candidate.candidateKey,
      status: "NOT_FOUND",
      reason: "REPRESENTATIVE_TRACK_NOT_FOUND",
      spotifyArtist: artist,
      spotifyTrack: null,
      alternatives,
    };
  }

  return {
    candidateKey: candidate.candidateKey,
    status: "RESOLVED",
    reason,
    spotifyArtist: artist,
    spotifyTrack: representative,
    alternatives,
  };
}

function empty(
  candidate: SpotifyDiscoveryResolutionCandidate,
  status: "NOT_FOUND",
  reason: "ARTIST_NOT_FOUND" | "TRACK_NOT_FOUND",
): SpotifyDiscoveryResolution {
  return {
    candidateKey: candidate.candidateKey,
    status,
    reason,
    spotifyArtist: null,
    spotifyTrack: null,
    alternatives: [],
  };
}

function groupTracksByRecording(
  rows: SpotifyCatalogTrackSummary[],
): SpotifyCatalogTrackSummary[][] {
  const groups = new Map<string, SpotifyCatalogTrackSummary[]>();
  for (const row of rows) {
    const key = row.isrc ? `isrc:${normalized(row.isrc)}` : `track:${row.id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function uniqueArtists(rows: SpotifyCatalogArtistSummary[]): SpotifyCatalogArtistSummary[] {
  const byId = new Map<string, SpotifyCatalogArtistSummary>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

function controlledLeadingArticleAlias(value: string): string | null {
  const clean = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!/^the\s+/i.test(clean)) return null;
  const alias = clean.replace(/^the\s+/i, "").trim();
  return alias.length >= 2 ? alias : null;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}
