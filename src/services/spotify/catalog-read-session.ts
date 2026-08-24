import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CACHE_VERSION = 1;
const DAY_MS = 86_400_000;
const DEFAULT_REQUEST_BUDGET = 8;
const MAX_REQUEST_BUDGET = 100;

export const SPOTIFY_CATALOG_CACHE_TTL = {
  search: 7 * DAY_MS,
  artistAlbums: 24 * 60 * 60 * 1000,
  albumTracks: 30 * DAY_MS,
} as const;

export type SpotifyCatalogReadSessionMetrics = {
  requestBudget: number;
  networkRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheWrites: number;
  cacheWriteFailures: number;
};

export class SpotifyCatalogRequestBudgetExceededError extends Error {
  readonly code = "SPOTIFY_CATALOG_REQUEST_BUDGET_EXHAUSTED";

  constructor(
    readonly requestBudget: number,
    readonly networkRequests: number,
  ) {
    super(
      `Spotify catalog request budget exhausted after ${networkRequests}/${requestBudget} network request(s); partial catalog progress remains cached for the next refresh.`,
    );
    this.name = "SpotifyCatalogRequestBudgetExceededError";
  }
}

export function isSpotifyCatalogRequestBudgetExceededError(
  error: unknown,
): error is SpotifyCatalogRequestBudgetExceededError {
  return error instanceof SpotifyCatalogRequestBudgetExceededError;
}

type CacheEnvelope<T> = {
  version: typeof CACHE_VERSION;
  storedAt: string;
  value: T;
};

export class SpotifyCatalogReadSession {
  private networkRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheWrites = 0;
  private cacheWriteFailures = 0;
  private readonly requestBudget: number;
  private readonly cacheDir: string;
  private readonly now: () => Date;

  constructor(
    private readonly userId: string,
    options: {
      requestBudget?: number;
      cacheDir?: string;
      now?: () => Date;
    } = {},
  ) {
    this.requestBudget = normalizeRequestBudget(
      options.requestBudget ?? requestBudgetFromEnv(),
    );
    this.cacheDir =
      options.cacheDir ??
      process.env.SPOTIFY_CATALOG_CACHE_DIR?.trim() ??
      join(homedir(), ".sonoriza-cache", "spotify-catalog");
    this.now = options.now ?? (() => new Date());
  }

  getMetrics(): SpotifyCatalogReadSessionMetrics {
    return {
      requestBudget: this.requestBudget,
      networkRequests: this.networkRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheWrites: this.cacheWrites,
      cacheWriteFailures: this.cacheWriteFailures,
    };
  }

  async readCache<T>(path: string, ttlMs: number): Promise<T | null> {
    const filePath = this.cacheFilePath(path);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      if (parsed.version !== CACHE_VERSION) {
        this.cacheMisses += 1;
        return null;
      }
      const storedAtMs = Date.parse(parsed.storedAt);
      if (!Number.isFinite(storedAtMs) || storedAtMs + ttlMs <= this.now().getTime()) {
        this.cacheMisses += 1;
        return null;
      }
      this.cacheHits += 1;
      return parsed.value;
    } catch {
      this.cacheMisses += 1;
      return null;
    }
  }

  reserveNetworkRequest(): void {
    if (this.networkRequests >= this.requestBudget) {
      throw new SpotifyCatalogRequestBudgetExceededError(
        this.requestBudget,
        this.networkRequests,
      );
    }
    this.networkRequests += 1;
  }

  async writeCache<T>(path: string, value: T): Promise<void> {
    const filePath = this.cacheFilePath(path);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      storedAt: this.now().toISOString(),
      value,
    };

    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(tempPath, JSON.stringify(envelope), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempPath, filePath);
      this.cacheWrites += 1;
    } catch {
      this.cacheWriteFailures += 1;
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private cacheFilePath(path: string): string {
    const key = createHash("sha256")
      .update(`${this.userId}\0${path}`)
      .digest("hex");
    return join(this.cacheDir, key.slice(0, 2), `${key}.json`);
  }
}

export function normalizeRequestBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REQUEST_BUDGET;
  return Math.min(
    MAX_REQUEST_BUDGET,
    Math.max(1, Math.trunc(value)),
  );
}

function requestBudgetFromEnv(): number {
  const raw = process.env.ALBUM_OPPORTUNITY_SPOTIFY_REQUEST_BUDGET?.trim();
  if (!raw) return DEFAULT_REQUEST_BUDGET;
  return Number(raw);
}
