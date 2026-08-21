const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const DEFAULT_USER_AGENT = "Sonoriza/0.1 DISCOVERY-01 (github.com/marksborn/sonoriza)";

export type LastFmSimilarArtist = {
  name: string;
  mbid: string | null;
  match: number;
  url: string | null;
};

export type LastFmSimilarTrack = {
  name: string;
  artistName: string;
  trackMbid: string | null;
  artistMbid: string | null;
  match: number;
  url: string | null;
};

export type LastFmSimilarityClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  userAgent?: string;
};

type LastFmSimilarArtistPayload = {
  name?: string;
  mbid?: string;
  match?: string | number;
  url?: string;
};

type LastFmSimilarArtistsResponse = {
  similarartists?: {
    artist?: LastFmSimilarArtistPayload[] | LastFmSimilarArtistPayload;
  };
};

type LastFmSimilarTrackPayload = {
  name?: string;
  mbid?: string;
  match?: string | number;
  url?: string;
  artist?: {
    name?: string;
    mbid?: string;
  };
};

type LastFmSimilarTracksResponse = {
  similartracks?: {
    track?: LastFmSimilarTrackPayload[] | LastFmSimilarTrackPayload;
  };
};

/**
 * DISCOVERY-01 read-only Last.fm similarity client.
 *
 * These endpoints require only an API key (no authenticated Last.fm session)
 * and never write/scrobble/love anything. Keep this client separate from the
 * HISTORY-01 importer so discovery failures can abstain without affecting the
 * canonical listening-history pipeline.
 */
export class LastFmSimilarityClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly userAgent: string;

  constructor(options: LastFmSimilarityClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("Last.fm API key is required");
    const userAgent = (options.userAgent ?? DEFAULT_USER_AGENT).trim();
    if (!userAgent) throw new Error("Last.fm User-Agent is required");
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? LASTFM_API;
    this.userAgent = userAgent;
  }

  async getSimilarArtists(input: {
    artistName: string;
    artistMbid?: string | null;
    limit?: number;
  }): Promise<LastFmSimilarArtist[]> {
    const artistName = requiredText(input.artistName, "artistName");
    const limit = boundedLimit(input.limit ?? 20);
    const artistMbid = clean(input.artistMbid);
    const payload = await this.getJson<LastFmSimilarArtistsResponse>({
      method: "artist.getsimilar",
      artist: artistName,
      ...(artistMbid ? { mbid: artistMbid } : {}),
      autocorrect: "1",
      limit: String(limit),
    });

    return asArray(payload.similarartists?.artist).flatMap((artist) => {
      const name = clean(artist.name);
      const match = normalizeSimilarity(artist.match);
      if (!name || match === null) return [];
      return [
        {
          name,
          mbid: clean(artist.mbid),
          match,
          url: clean(artist.url),
        },
      ];
    });
  }

  async getSimilarTracks(input: {
    artistName: string;
    trackName: string;
    trackMbid?: string | null;
    limit?: number;
  }): Promise<LastFmSimilarTrack[]> {
    const artistName = requiredText(input.artistName, "artistName");
    const trackName = requiredText(input.trackName, "trackName");
    const limit = boundedLimit(input.limit ?? 20);
    const trackMbid = clean(input.trackMbid);
    const payload = await this.getJson<LastFmSimilarTracksResponse>({
      method: "track.getsimilar",
      artist: artistName,
      track: trackName,
      ...(trackMbid ? { mbid: trackMbid } : {}),
      autocorrect: "1",
      limit: String(limit),
    });

    return asArray(payload.similartracks?.track).flatMap((track) => {
      const name = clean(track.name);
      const candidateArtistName = clean(track.artist?.name);
      const match = normalizeSimilarity(track.match);
      if (!name || !candidateArtistName || match === null) return [];
      return [
        {
          name,
          artistName: candidateArtistName,
          trackMbid: clean(track.mbid),
          artistMbid: clean(track.artist?.mbid),
          match,
          url: clean(track.url),
        },
      ];
    });
  }

  private async getJson<T>(params: Record<string, string>): Promise<T> {
    const url = new URL(this.apiUrl);
    for (const [key, value] of Object.entries({
      ...params,
      api_key: this.apiKey,
      format: "json",
    })) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Last.fm returned invalid JSON (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(lastFmErrorMessage(payload, response.status));
    }
    if (isLastFmError(payload)) {
      throw new Error(`Last.fm API error ${payload.error}: ${payload.message}`);
    }
    return payload as T;
  }
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Last.fm similarity limit must be an integer between 1 and 100");
  }
  return value;
}

function requiredText(value: string, name: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${name} is required`);
  return cleaned;
}

function normalizeSimilarity(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  // Current JSON responses use 0..1. Some legacy Last.fm examples expose
  // track similarity as a percentage-like value (for example 10.95). Keep
  // scoring conservative if such a response is encountered.
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

function asArray<T>(value: T[] | T | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value: string | undefined | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function isLastFmError(value: unknown): value is { error: number; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.error === "number" && typeof record.message === "string";
}

function lastFmErrorMessage(payload: unknown, status: number): string {
  if (isLastFmError(payload)) {
    return `Last.fm API error ${payload.error}: ${payload.message}`;
  }
  return `Last.fm request failed with HTTP ${status}`;
}
