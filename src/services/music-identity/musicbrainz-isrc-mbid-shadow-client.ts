import {
  gate5CNormalizeIsrc,
  type Gate5CMusicBrainzRecording,
} from "./musicbrainz-isrc-mbid-shadow";

const ENDPOINT = "https://musicbrainz.org/ws/2/isrc/";
const USER_AGENT = "Sonoriza/0.1 (https://github.com/marksborn/sonoriza)";
const MIN_INTERVAL_MS = 1_500;
const TIMEOUT_MS = 12_000;

export type Gate5CMusicBrainzLookup =
  | { kind: "NOT_FOUND" }
  | { kind: "FOUND"; recordings: Gate5CMusicBrainzRecording[] };

type FetchLike = typeof fetch;

/**
 * Explicit manually invoked diagnostic client. One sequential request every
 * >=1.5s *within this process*, no retries. Operators must not run multiple
 * processes in parallel against the public MusicBrainz endpoint.
 */
export class Gate5CMusicBrainzClient {
  private lastStartAt = 0;
  private requestCount = 0;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly pause: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly clock: () => number = Date.now,
  ) {}

  getMetrics() {
    return { requests: this.requestCount, minIntervalMs: MIN_INTERVAL_MS };
  }

  async lookup(rawIsrc: string): Promise<Gate5CMusicBrainzLookup> {
    const isrc = gate5CNormalizeIsrc(rawIsrc);
    if (!isrc) throw new Error("Gate 5C: invalid ISRC; refusing MusicBrainz request");

    if (this.requestCount > 0) {
      const remaining = MIN_INTERVAL_MS - (this.clock() - this.lastStartAt);
      if (remaining > 0) await this.pause(remaining);
    }
    this.lastStartAt = this.clock();
    this.requestCount += 1;

    const url = ENDPOINT + encodeURIComponent(isrc) + "?fmt=json&inc=artist-credits";
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 404) return { kind: "NOT_FOUND" };
    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      // 503 is the documented MusicBrainz rate-limiting response.
      throw new Error(`Gate 5C: MusicBrainz HTTP ${response.status}; abort batch; no retry`);
    }
    if (!response.ok) {
      throw new Error(`Gate 5C: MusicBrainz HTTP ${response.status}; abort batch`);
    }

    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null ||
        !("recordings" in data) || !Array.isArray(data.recordings)) {
      throw new Error("Gate 5C: invalid MusicBrainz payload (no recordings array)");
    }

    const recordings: Gate5CMusicBrainzRecording[] = [];
    if (data.recordings.length > 100) {
      throw new Error("Gate 5C: oversized MusicBrainz recording candidate set");
    }

    for (const row of data.recordings) {
      if (!row || typeof row !== "object") {
        throw new Error("Gate 5C: invalid MusicBrainz recording row");
      }
      const candidate = row as {
        id?: unknown; title?: unknown; length?: unknown;
        "artist-credit"?: unknown;
      };
      if (typeof candidate.id !== "string" || typeof candidate.title !== "string") {
        throw new Error("Gate 5C: MusicBrainz recording is missing id or title");
      }
      const credit = Array.isArray(candidate["artist-credit"])
        ? candidate["artist-credit"]
        : [];
      const artistNames = credit
        .filter((value): value is { name?: string; artist?: { name?: string } } =>
          Boolean(value && typeof value === "object"))
        .map((value) => value.name ?? value.artist?.name ?? "")
        .filter((name) => Boolean(name.trim()));

      const length = candidate.length;
      recordings.push({
        id: candidate.id,
        title: candidate.title,
        durationMs:
          typeof length === "number" && Number.isFinite(length) ? length : null,
        artistNames,
      });
    }
    return { kind: "FOUND", recordings };
  }
}
