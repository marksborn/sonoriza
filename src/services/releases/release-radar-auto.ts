import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { resolveTargetDiscoveryRuntimePolicy } from "@/services/music-discovery/target-discovery-runtime-policy";
import { SpotifyClient } from "@/services/spotify/client";

import { resolveReleasesPlannerMode, type ReleasesPlannerMode } from "./release-planner";
import {
  RELEASE_RADAR_DEFAULTS,
  readReleaseRadar,
  refreshReleaseRadar,
} from "./release-radar";

/**
 * RELEASES-01 (#161): keeps the radar inside the planner's freshness window
 * without a manual click. Runs on the cron tick, only on a tick that generated
 * nothing, so it never stacks on a generation burst. Artists already checked
 * this week cost no reads, so a due refresh is often free.
 *
 * RELEASES_PLANNER_MODE=OFF stops it.
 */

/** A refresh that did not persist waits this long, never the next 5-minute tick. */
export const RELEASE_RADAR_AUTO_RETRY_MS = 6 * 60 * 60_000;

export function releaseRadarAutoRefreshDue(input: {
  mode: ReleasesPlannerMode;
  fetchedAt: Date | null;
  lastAttemptAtMs: number | undefined;
  now: Date;
}): boolean {
  if (input.mode === "OFF") return false;
  const nowMs = input.now.getTime();
  if (
    input.lastAttemptAtMs !== undefined &&
    nowMs - input.lastAttemptAtMs < RELEASE_RADAR_AUTO_RETRY_MS
  ) {
    return false;
  }
  return (
    input.fetchedAt === null ||
    nowMs - input.fetchedAt.getTime() >= RELEASE_RADAR_DEFAULTS.minRefreshIntervalMs
  );
}

export type ReleaseRadarAutoDeps = Readonly<{
  listUserIds: () => Promise<string[]>;
  readFetchedAt: (userId: string) => Promise<Date | null>;
  refresh: (userId: string) => Promise<boolean>;
}>;

const defaultDeps: ReleaseRadarAutoDeps = {
  listUserIds: async () => {
    const users = await prisma.user.findMany({
      where: {
        targetPlaylists: {
          some: {
            enabled: true,
            updatePolicy: { not: "MANUAL" },
            discoveryEnabled: true,
            discoveryReleasesEnabled: true,
          },
        },
      },
      select: { id: true, email: true },
    });
    return users
      .filter(
        (user) =>
          isEmailAllowed(user.email) &&
          // Without the Descobrir rollout the planner never reads the radar.
          resolveTargetDiscoveryRuntimePolicy({
            baseDiscoveryEnabled: true,
            userEmail: user.email,
            masterEnabled: process.env.DISCOVER_DEST_RUNTIME_ENABLED,
            allowlistedEmails: process.env.DISCOVER_DEST_RUNTIME_USER_EMAILS,
          }).enabled,
      )
      .map((user) => user.id);
  },
  readFetchedAt: async (userId) => (await readReleaseRadar(userId))?.fetchedAt ?? null,
  refresh: async (userId) => {
    const client = await SpotifyClient.forUser(userId);
    const { persisted } = await refreshReleaseRadar({
      userId,
      reader: {
        artistReleases: (artistId) => client.getArtistRecentReleases(artistId),
        releaseTracks: (albumId) => client.getReleaseTracks(albumId),
      },
    });
    return persisted;
  },
};

const lastAttemptAtMsByUser = new Map<string, number>();

/** Never throws: the radar must not be able to fail the generation cron. */
export async function refreshDueReleaseRadars(input: {
  now?: Date;
  mode?: ReleasesPlannerMode;
  deps?: ReleaseRadarAutoDeps;
  attempts?: Map<string, number>;
} = {}): Promise<{ refreshed: number; failed: number }> {
  const now = input.now ?? new Date();
  const mode = input.mode ?? resolveReleasesPlannerMode(process.env.RELEASES_PLANNER_MODE);
  const deps = input.deps ?? defaultDeps;
  const attempts = input.attempts ?? lastAttemptAtMsByUser;
  let refreshed = 0;
  let failed = 0;
  if (mode === "OFF") return { refreshed, failed };
  try {
    for (const userId of await deps.listUserIds()) {
      const due = releaseRadarAutoRefreshDue({
        mode,
        fetchedAt: await deps.readFetchedAt(userId),
        lastAttemptAtMs: attempts.get(userId),
        now,
      });
      if (!due) continue;
      attempts.set(userId, now.getTime());
      try {
        if (await deps.refresh(userId)) refreshed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        console.error("RELEASES-01 auto refresh failed", error);
      }
    }
  } catch (error) {
    failed += 1;
    console.error("RELEASES-01 auto refresh skipped", error);
  }
  return { refreshed, failed };
}
