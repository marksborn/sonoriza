import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { getActiveSpotifyBackoff } from "@/services/spotify/backoff";
import { SpotifyClient } from "@/services/spotify/client";

import {
  FOLLOWED_CATALOG_POLICY,
  readFollowedCatalog,
  refreshFollowedCatalog,
} from "./followed-catalog";

/**
 * DISCOVERY-FOLLOWED-01 (#564) Gate C: daily sampled refresh on an idle cron
 * tick, like the release radar. Operator switch
 * FOLLOWED_ARTISTS_CATALOG_MODE=ACTIVE (default OFF); only users whose Spotify
 * grant includes user-follow-read. Never throws, never affects playlists.
 */

export const FOLLOWED_FOLLOW_SCOPE = "user-follow-read";
export const FOLLOWED_CATALOG_AUTO_RETRY_MS = 6 * 60 * 60_000;

export type FollowedCatalogMode = "OFF" | "ACTIVE";

export function resolveFollowedCatalogMode(value: string | null | undefined): FollowedCatalogMode {
  return value?.trim().toUpperCase() === "ACTIVE" ? "ACTIVE" : "OFF";
}

export function grantHasFollowScope(scope: string | null | undefined): boolean {
  return new Set((scope ?? "").split(/\s+/).filter(Boolean)).has(FOLLOWED_FOLLOW_SCOPE);
}

export function followedCatalogRefreshDue(input: {
  fetchedAt: Date | null;
  lastAttemptAtMs: number | undefined;
  now: Date;
}): boolean {
  const nowMs = input.now.getTime();
  if (
    input.lastAttemptAtMs !== undefined &&
    nowMs - input.lastAttemptAtMs < FOLLOWED_CATALOG_AUTO_RETRY_MS
  ) {
    return false;
  }
  return (
    input.fetchedAt === null ||
    nowMs - input.fetchedAt.getTime() >= FOLLOWED_CATALOG_POLICY.minRefreshIntervalMs
  );
}

export type FollowedCatalogAutoDeps = Readonly<{
  listUserIds: () => Promise<string[]>;
  readFetchedAt: (userId: string) => Promise<Date | null>;
  providerBlocked: () => Promise<boolean>;
  refresh: (userId: string) => Promise<boolean>;
}>;

export function followedCatalogReaderFor(client: SpotifyClient) {
  return {
    followedArtists: () => client.listFollowedArtists(),
    artistAlbums: (artistId: string, offset: number) => client.getArtistAlbumsPage(artistId, offset),
    albumTracks: (albumId: string) => client.getReleaseTracks(albumId),
  };
}

const defaultDeps: FollowedCatalogAutoDeps = {
  listUserIds: async () => {
    const accounts = await prisma.account.findMany({
      where: { provider: "spotify" },
      select: { userId: true, scope: true, user: { select: { email: true } } },
    });
    return accounts
      .filter((account) => grantHasFollowScope(account.scope) && isEmailAllowed(account.user.email))
      .map((account) => account.userId);
  },
  readFetchedAt: async (userId) => (await readFollowedCatalog(userId))?.fetchedAt ?? null,
  providerBlocked: async () => Boolean(await getActiveSpotifyBackoff()),
  refresh: async (userId) => {
    const client = await SpotifyClient.forUser(userId);
    const { persisted } = await refreshFollowedCatalog({
      userId,
      reader: followedCatalogReaderFor(client),
    });
    return persisted;
  },
};

const lastAttemptAtMsByUser = new Map<string, number>();

/**
 * A first read takes ~75 sequential Spotify calls (often over a minute), longer
 * than a browser will wait on a form post. Manual refreshes therefore run in
 * the background; this per-user lock (shared with the cron refresh) prevents
 * two concurrent reads for the same user in this process.
 */
const runningRefreshes = new Map<string, Promise<void>>();

export function isFollowedCatalogRefreshRunning(userId: string): boolean {
  return runningRefreshes.has(userId);
}

export type FollowedCatalogRefreshOutcome = "updated" | "failed";

const lastOutcomeByUser = new Map<string, FollowedCatalogRefreshOutcome>();

/** Result of the last background refresh in this process, if any. */
export function lastFollowedCatalogRefreshOutcome(
  userId: string,
): FollowedCatalogRefreshOutcome | null {
  return lastOutcomeByUser.get(userId) ?? null;
}

export function startFollowedCatalogRefresh(
  userId: string,
  run: () => Promise<boolean>,
): "started" | "running" {
  if (runningRefreshes.has(userId)) return "running";
  lastOutcomeByUser.delete(userId);
  const task = (async () => {
    try {
      lastOutcomeByUser.set(userId, (await run()) ? "updated" : "failed");
    } catch (error) {
      lastOutcomeByUser.set(userId, "failed");
      console.error("DISCOVERY-FOLLOWED-01 background refresh failed", error);
    } finally {
      runningRefreshes.delete(userId);
    }
  })();
  runningRefreshes.set(userId, task);
  return "started";
}

/** Test helper: waits for a background refresh to settle. */
export async function waitForFollowedCatalogRefresh(userId: string): Promise<void> {
  await runningRefreshes.get(userId);
}

export async function runFollowedCatalogRefresh(userId: string): Promise<boolean> {
  return defaultDeps.refresh(userId);
}

export async function refreshDueFollowedCatalogs(input: {
  now?: Date;
  mode?: FollowedCatalogMode;
  deps?: FollowedCatalogAutoDeps;
  attempts?: Map<string, number>;
} = {}): Promise<{ refreshed: number; failed: number }> {
  const now = input.now ?? new Date();
  const mode = input.mode ?? resolveFollowedCatalogMode(process.env.FOLLOWED_ARTISTS_CATALOG_MODE);
  const deps = input.deps ?? defaultDeps;
  const attempts = input.attempts ?? lastAttemptAtMsByUser;
  let refreshed = 0;
  let failed = 0;
  if (mode === "OFF") return { refreshed, failed };
  try {
    if (await deps.providerBlocked()) return { refreshed, failed };
    for (const userId of await deps.listUserIds()) {
      const due = followedCatalogRefreshDue({
        fetchedAt: await deps.readFetchedAt(userId),
        lastAttemptAtMs: attempts.get(userId),
        now,
      });
      if (!due || isFollowedCatalogRefreshRunning(userId)) continue;
      attempts.set(userId, now.getTime());
      const task = deps.refresh(userId);
      runningRefreshes.set(userId, task.then(() => undefined, () => undefined));
      try {
        if (await task) refreshed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        console.error("DISCOVERY-FOLLOWED-01 auto refresh failed", error);
      } finally {
        runningRefreshes.delete(userId);
      }
    }
  } catch (error) {
    failed += 1;
    console.error("DISCOVERY-FOLLOWED-01 auto refresh skipped", error);
  }
  return { refreshed, failed };
}
