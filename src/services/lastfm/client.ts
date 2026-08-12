import { createHash } from "node:crypto";

const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const DEFAULT_USER_AGENT = "Sonoriza/0.1 HISTORY-01 (github.com/marksborn/sonoriza)";
export const LASTFM_RECENT_TRACKS_MAX_LIMIT = 200;

export type LastFmImage = {
  size?: string;
  "#text"?: string;
};

export type LastFmNamedEntity = {
  mbid?: string;
  "#text"?: string;
  name?: string;
};

export type LastFmRecentTrack = {
  artist?: LastFmNamedEntity;
  album?: LastFmNamedEntity;
  name?: string;
  mbid?: string;
  url?: string;
  date?: {
    uts?: string;
    "#text"?: string;
  };
  "@attr"?: {
    nowplaying?: string;
  };
  image?: LastFmImage[];
  loved?: string;
};

export type LastFmRecentTracksResponse = {
  recenttracks?: {
    track?: LastFmRecentTrack[] | LastFmRecentTrack;
    "@attr"?: {
      user?: string;
      page?: string;
      perPage?: string;
      totalPages?: string;
      total?: string;
    };
  };
};

export type LastFmUserInfoResponse = {
  user?: {
    name?: string;
    realname?: string;
    url?: string;
    playcount?: string;
    registered?: { unixtime?: string; "#text"?: number | string };
  };
};

export type LastFmTopTrack = {
  name?: string;
  playcount?: string;
  mbid?: string;
  url?: string;
  artist?: {
    name?: string;
    mbid?: string;
    url?: string;
  };
};

export type LastFmTopTracksResponse = {
  toptracks?: {
    track?: LastFmTopTrack[] | LastFmTopTrack;
    "@attr"?: {
      user?: string;
      page?: string;
      perPage?: string;
      totalPages?: string;
      total?: string;
    };
  };
};

export type LastFmListeningEventInput = {
  source: "LASTFM_SCROBBLE";
  sourceEventKey: string;
  playedAt: Date;
  trackName: string;
  artistName: string;
  albumName: string | null;
  trackMbid: string | null;
  artistMbid: string | null;
  albumMbid: string | null;
  lastFmUrl: string | null;
  loved: boolean | null;
};

export type LastFmRecentTracksPage = {
  username: string;
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
  events: LastFmListeningEventInput[];
  nowPlayingCount: number;
  invalidCount: number;
};

export type LastFmUserProfile = {
  username: string;
  realName: string | null;
  profileUrl: string | null;
  playCount: number | null;
  registeredAt: Date | null;
};

export type LastFmTopTrackCount = {
  trackName: string;
  artistName: string;
  playCount: number;
  trackMbid: string | null;
  artistMbid: string | null;
};

export type LastFmClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  userAgent?: string;
};

/**
 * HISTORY-01 read-only Last.fm client.
 *
 * The methods used here do not require a Last.fm authenticated session. The
 * client intentionally supports no write/scrobble endpoint in this phase.
 */
export class LastFmClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly userAgent: string;

  constructor(options: LastFmClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("Last.fm API key is required");
    const userAgent = (options.userAgent ?? DEFAULT_USER_AGENT).trim();
    if (!userAgent) throw new Error("Last.fm User-Agent is required");
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? LASTFM_API;
    this.userAgent = userAgent;
  }

  async getUserInfo(username: string): Promise<LastFmUserProfile> {
    const requestedUser = requiredUsername(username);
    const payload = await this.getJson<LastFmUserInfoResponse>({
      method: "user.getinfo",
      user: requestedUser,
    });
    const user = payload.user;
    if (!user?.name) throw new Error("Last.fm user.getInfo returned no user");

    return {
      username: user.name,
      realName: clean(user.realname),
      profileUrl: clean(user.url),
      playCount: parseNonNegativeInt(user.playcount),
      registeredAt: unixSecondsToDate(user.registered?.unixtime),
    };
  }

  async getRecentTracksPage(input: {
    username: string;
    page?: number;
    limit?: number;
    from?: Date;
    to?: Date;
  }): Promise<LastFmRecentTracksPage> {
    const username = requiredUsername(input.username);
    const page = positiveInt(input.page ?? 1, "page");
    const limit = positiveInt(input.limit ?? LASTFM_RECENT_TRACKS_MAX_LIMIT, "limit");
    if (limit > LASTFM_RECENT_TRACKS_MAX_LIMIT) {
      throw new Error(
        `Last.fm recent tracks limit cannot exceed ${LASTFM_RECENT_TRACKS_MAX_LIMIT}`,
      );
    }
    if (input.from && input.to && input.from >= input.to) {
      throw new Error("Last.fm recent tracks 'from' must be before 'to'");
    }

    const payload = await this.getJson<LastFmRecentTracksResponse>({
      method: "user.getrecenttracks",
      user: username,
      page: String(page),
      limit: String(limit),
      ...(input.from ? { from: dateToUnixSeconds(input.from) } : {}),
      ...(input.to ? { to: dateToUnixSeconds(input.to) } : {}),
      extended: "1",
    });

    const recent = payload.recenttracks;
    const attr = recent?.["@attr"];
    const tracks = asArray(recent?.track);
    const events: LastFmListeningEventInput[] = [];
    let nowPlayingCount = 0;
    let invalidCount = 0;

    for (const track of tracks) {
      if (track["@attr"]?.nowplaying === "true" && !track.date?.uts) {
        nowPlayingCount += 1;
        continue;
      }
      const event = mapRecentTrackToListeningEvent(track);
      if (!event) {
        invalidCount += 1;
        continue;
      }
      events.push(event);
    }

    return {
      username: attr?.user || username,
      page: parsePositiveInt(attr?.page) ?? page,
      perPage: parsePositiveInt(attr?.perPage) ?? limit,
      totalPages: parseNonNegativeInt(attr?.totalPages) ?? 0,
      total: parseNonNegativeInt(attr?.total) ?? events.length,
      events,
      nowPlayingCount,
      invalidCount,
    };
  }

  async getTopTracksPage(input: {
    username: string;
    page?: number;
    limit?: number;
    period?: "overall" | "7day" | "1month" | "3month" | "6month" | "12month";
  }): Promise<{
    username: string;
    page: number;
    totalPages: number;
    total: number;
    tracks: LastFmTopTrackCount[];
  }> {
    const username = requiredUsername(input.username);
    const page = positiveInt(input.page ?? 1, "page");
    const limit = positiveInt(input.limit ?? 200, "limit");
    const payload = await this.getJson<LastFmTopTracksResponse>({
      method: "user.gettoptracks",
      user: username,
      page: String(page),
      limit: String(limit),
      period: input.period ?? "overall",
    });
    const top = payload.toptracks;
    const attr = top?.["@attr"];
    const tracks = asArray(top?.track).flatMap((track) => {
      const trackName = clean(track.name);
      const artistName = clean(track.artist?.name);
      const playCount = parseNonNegativeInt(track.playcount);
      if (!trackName || !artistName || playCount === null) return [];
      return [
        {
          trackName,
          artistName,
          playCount,
          trackMbid: clean(track.mbid),
          artistMbid: clean(track.artist?.mbid),
        },
      ];
    });

    return {
      username: attr?.user || username,
      page: parsePositiveInt(attr?.page) ?? page,
      totalPages: parseNonNegativeInt(attr?.totalPages) ?? 0,
      total: parseNonNegativeInt(attr?.total) ?? tracks.length,
      tracks,
    };
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

export function mapRecentTrackToListeningEvent(
  track: LastFmRecentTrack,
): LastFmListeningEventInput | null {
  const trackName = clean(track.name);
  const artistName = clean(track.artist?.name ?? track.artist?.["#text"]);
  const playedAt = unixSecondsToDate(track.date?.uts);
  if (!trackName || !artistName || !playedAt) return null;

  const albumName = clean(track.album?.["#text"] ?? track.album?.name);
  const trackMbid = clean(track.mbid);
  const artistMbid = clean(track.artist?.mbid);
  const albumMbid = clean(track.album?.mbid);
  const lastFmUrl = clean(track.url);
  const loved = track.loved === "1" ? true : track.loved === "0" ? false : null;

  return {
    source: "LASTFM_SCROBBLE",
    sourceEventKey: lastFmSourceEventKey({
      playedAt,
      trackName,
      artistName,
      albumName,
      trackMbid,
      artistMbid,
    }),
    playedAt,
    trackName,
    artistName,
    albumName,
    trackMbid,
    artistMbid,
    albumMbid,
    lastFmUrl,
    loved,
  };
}

export function lastFmSourceEventKey(input: {
  playedAt: Date;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  trackMbid?: string | null;
  artistMbid?: string | null;
}): string {
  const identity = [
    input.playedAt.toISOString(),
    normalize(input.artistMbid || input.artistName),
    normalize(input.trackMbid || input.trackName),
    normalize(input.albumName ?? ""),
  ].join("\0");
  return `lastfm:${createHash("sha256").update(identity).digest("hex")}`;
}

function requiredUsername(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error("Last.fm username is required");
  return cleaned;
}

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = parseNonNegativeInt(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function unixSecondsToDate(value: string | undefined): Date | null {
  const seconds = parseNonNegativeInt(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateToUnixSeconds(date: Date): string {
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Invalid Last.fm range date");
  return String(Math.floor(timestamp / 1000));
}

function asArray<T>(value: T[] | T | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value: string | undefined | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").normalize("NFKC");
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
