import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyApiError } from "@/services/spotify/errors";
import type { ArtistReleaseResponse, ReleaseTrackResponse } from "@/services/spotify/client";

import {
  FOLLOWED_CATALOG_POLICY,
  collectFollowedCatalog,
  isAmbiguousVersion,
  lastFmTrackKey,
  mergeFollowedCandidates,
  normalizeTitle,
  selectFollowedArtistsToCheck,
  shouldPersistFollowedCatalog,
  type FollowedCatalogCandidate,
  type FollowedCatalogKnowledge,
  type FollowedCatalogReader,
} from "./followed-catalog";
import {
  followedCatalogRefreshDue,
  grantHasFollowScope,
  isFollowedCatalogRefreshRunning,
  lastFollowedCatalogRefreshOutcome,
  refreshDueFollowedCatalogs,
  resolveFollowedCatalogMode,
  startFollowedCatalogRefresh,
  waitForFollowedCatalogRefresh,
} from "./followed-catalog-auto";

const NOW = new Date("2026-11-19T12:00:00Z");
const DAY = 86_400_000;

function knowledge(partial: Partial<FollowedCatalogKnowledge> = {}): FollowedCatalogKnowledge {
  return {
    likedTrackIds: new Set(),
    heardTrackIds: new Set(),
    lastFmTrackKeys: new Set(),
    lastFmArtistCounts: new Map(),
    ...partial,
  };
}

function album(id: string, artistId: string, extra: Partial<ArtistReleaseResponse> = {}): ArtistReleaseResponse {
  return { id, name: `Album ${id}`, album_type: "album", artists: [{ id: artistId }], ...extra };
}

function track(id: string, artistId: string, extra: Partial<ReleaseTrackResponse> = {}): ReleaseTrackResponse {
  return {
    id,
    uri: `spotify:track:${id}`,
    name: `Song ${id}`,
    duration_ms: 200_000,
    artists: [{ id: artistId }],
    ...extra,
  };
}

test("#564 titles: version suffixes are stripped for matching and flagged as ambiguous", () => {
  assert.equal(normalizeTitle("Ride the Lightning - Remastered 2016"), "ride the lightning");
  assert.equal(normalizeTitle("Canção (Ao Vivo)"), "cancao");
  assert.equal(isAmbiguousVersion("Song - Live at Wembley"), true);
  assert.equal(isAmbiguousVersion("Song (Acústico)"), true);
  assert.equal(isAmbiguousVersion("Song (2011 Remaster)"), true);
  assert.equal(isAmbiguousVersion("Fade to Black"), false);
  assert.equal(
    lastFmTrackKey("Metallica", "Fade To Black - Remastered"),
    lastFmTrackKey("metallica", "Fade to Black"),
  );
});

test("#564 rotation: never checked first, then oldest; Last.fm plays break ties; recent skipped", () => {
  const artists = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
    { id: "c", name: "Gamma" },
    { id: "d", name: "Delta" },
  ];
  const checks = {
    a: { checkedAt: new Date(NOW.getTime() - 20 * DAY).toISOString(), nextOffset: 0, sampledAlbumIds: [] },
    d: { checkedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(), nextOffset: 0, sampledAlbumIds: [] },
  };
  const selected = selectFollowedArtistsToCheck({
    artists,
    checks,
    lastFmArtistCounts: new Map([["gamma", 50], ["beta", 10]]),
    now: NOW,
  });
  assert.deepEqual(selected.map((artist) => artist.id), ["c", "b", "a"]);
});

test("#564 collect: candidates are own, unknown tracks; every exclusion is counted", async () => {
  const reads: string[] = [];
  const reader: FollowedCatalogReader = {
    followedArtists: async () => {
      reads.push("followed");
      return { artists: [{ id: "art", name: "Artist" }] };
    },
    artistAlbums: async (artistId, offset) => {
      reads.push(`albums:${offset}`);
      return {
        total: 25,
        items: [
          album("comp", "other"),
          album("live", artistId, { name: "Live in Rio" }),
          album("al1", artistId),
          album("al2", artistId, { album_type: "single" }),
          album("al3", artistId),
        ],
      };
    },
    albumTracks: async (albumId) => {
      reads.push(`tracks:${albumId}`);
      return albumId === "al1"
        ? [
            track("liked", "art"),
            track("heard", "art"),
            track("lastfm", "art", { name: "Known Song" }),
            track("feat", "guest"),
            track("short", "art", { duration_ms: 60_000 }),
            track("remix", "art", { name: "Song - Remix" }),
            track("ok1", "art"),
            track("ok2", "art"),
            track("ok3", "art"),
          ]
        : [track("ok4", "art"), track("blocked", "art", { is_playable: false })];
    },
  };

  const { state, evidence } = await collectFollowedCatalog({
    previous: null,
    reader,
    now: NOW,
    knowledge: knowledge({
      likedTrackIds: new Set(["liked"]),
      heardTrackIds: new Set(["heard"]),
      lastFmTrackKeys: new Set([lastFmTrackKey("Artist", "Known Song")]),
      lastFmArtistCounts: new Map([["artist", 12]]),
    }),
  });

  assert.deepEqual(reads, ["followed", "albums:0", "tracks:al1", "tracks:al2"], "2 albums per artist");
  assert.deepEqual(
    state.candidates.map((candidate) => candidate.spotifyTrackId),
    ["ok1", "ok2", "ok4"],
    "max 2 per album; within 3 per artist",
  );
  assert.equal(state.candidates[0]!.lastFmRank, 1);
  assert.deepEqual(state.candidates[0]!.reasons, ["FOLLOWED_ARTIST", "NOT_LIKED", "NO_KNOWN_PLAY", "LASTFM_RANK"]);
  assert.deepEqual(evidence.excluded, {
    NOT_OWN_RELEASE: 1,
    VERSION_AMBIGUOUS: 2,
    LIKED: 1,
    HEARD_SPOTIFY_STATE: 1,
    HEARD_LASTFM_NAME: 1,
    NOT_PRIMARY_ARTIST: 1,
    DURATION: 1,
    CAP: 1,
    UNPLAYABLE: 1,
  });
  assert.deepEqual(state.artistChecks.art, {
    checkedAt: NOW.toISOString(),
    nextOffset: FOLLOWED_CATALOG_POLICY.albumPageSize,
    sampledAlbumIds: ["al1", "al2"],
  });
  assert.equal(shouldPersistFollowedCatalog(evidence), true);
});

test("#564 collect: quota stops further reads and is never persisted", async () => {
  let albumReads = 0;
  const quota = new SpotifyApiError({
    kind: "QUOTA_EXCEEDED", status: 429, method: "GET", operation: "artist-albums",
    reason: "QUOTA_EXCEEDED", retryable: false, message: "quota",
  });
  const { evidence } = await collectFollowedCatalog({
    previous: null,
    now: NOW,
    knowledge: knowledge(),
    reader: {
      followedArtists: async () => ({ artists: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }),
      artistAlbums: async () => {
        albumReads += 1;
        throw quota;
      },
      albumTracks: async () => [],
    },
  });
  assert.equal(albumReads, 1);
  assert.equal(evidence.providerBlocked, true);
  assert.equal(shouldPersistFollowedCatalog(evidence), false);
});

test("#564 collect: follow list synced weekly; unfollowed artists drop with their candidates", async () => {
  let followedReads = 0;
  const previousCandidate: FollowedCatalogCandidate = {
    spotifyTrackId: "old", uri: "spotify:track:old", name: "Old", durationMs: 200_000,
    artistId: "gone", artistName: "Gone", albumId: "x", albumName: "X", albumType: "album",
    releaseDate: null, imageUrl: null, reasons: [], lastFmRank: null,
    addedAt: new Date(NOW.getTime() - DAY).toISOString(),
  };
  const reader: FollowedCatalogReader = {
    followedArtists: async () => {
      followedReads += 1;
      return { artists: [{ id: "keep", name: "Keep" }] };
    },
    artistAlbums: async () => ({ items: [], total: 0 }),
    albumTracks: async () => [],
  };
  const fresh = await collectFollowedCatalog({
    previous: {
      followedArtists: [{ id: "keep", name: "Keep" }, { id: "gone", name: "Gone" }],
      followedSyncedAt: new Date(NOW.getTime() - 2 * DAY),
      artistChecks: {},
      candidates: [previousCandidate],
    },
    reader,
    knowledge: knowledge(),
    now: NOW,
  });
  assert.equal(followedReads, 0, "synced 2 days ago: no follow read");
  assert.equal(fresh.state.candidates.length, 1);

  const stale = await collectFollowedCatalog({
    previous: { ...fresh.state, followedSyncedAt: new Date(NOW.getTime() - 8 * DAY) },
    reader,
    knowledge: knowledge(),
    now: NOW,
  });
  assert.equal(followedReads, 1);
  assert.equal(stale.state.candidates.length, 0, "artist no longer followed");
});

test("#564 merge: drops expired, now liked or heard; fresh wins; per-artist cap", () => {
  const candidate = (id: string, artistId: string, ageDays: number): FollowedCatalogCandidate => ({
    spotifyTrackId: id, uri: `spotify:track:${id}`, name: id, durationMs: 200_000,
    artistId, artistName: artistId, albumId: "al", albumName: "Al", albumType: "album",
    releaseDate: null, imageUrl: null, reasons: [], lastFmRank: null,
    addedAt: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
  });
  const merged = mergeFollowedCandidates({
    previous: [
      candidate("expired", "a", 61),
      candidate("liked", "a", 1),
      candidate("p1", "a", 1),
      candidate("p2", "a", 1),
      candidate("p3", "a", 1),
    ],
    fresh: [candidate("f1", "a", 0)],
    followedIds: new Set(["a"]),
    knowledge: { likedTrackIds: new Set(["liked"]), heardTrackIds: new Set() },
    now: NOW,
  });
  assert.deepEqual(merged.map((entry) => entry.spotifyTrackId), ["f1", "p1", "p2"]);
});

test("#564 auto refresh: OFF by default, scope and daily interval respected, never throws", async () => {
  assert.equal(resolveFollowedCatalogMode(undefined), "OFF");
  assert.equal(resolveFollowedCatalogMode(" active "), "ACTIVE");
  assert.equal(grantHasFollowScope("user-library-read user-follow-read"), true);
  assert.equal(grantHasFollowScope("user-library-read"), false);
  assert.equal(followedCatalogRefreshDue({ fetchedAt: null, lastAttemptAtMs: undefined, now: NOW }), true);
  assert.equal(
    followedCatalogRefreshDue({ fetchedAt: new Date(NOW.getTime() - 3_600_000), lastAttemptAtMs: undefined, now: NOW }),
    false,
  );

  let refreshCalls = 0;
  const deps = {
    listUserIds: async () => ["u1", "u2"],
    readFetchedAt: async () => null,
    providerBlocked: async () => false,
    refresh: async (userId: string) => {
      refreshCalls += 1;
      if (userId === "u2") throw new Error("boom");
      return true;
    },
  };
  assert.deepEqual(await refreshDueFollowedCatalogs({ mode: "OFF", deps, attempts: new Map() }), { refreshed: 0, failed: 0 });
  assert.equal(refreshCalls, 0);
  const attempts = new Map<string, number>();
  assert.deepEqual(await refreshDueFollowedCatalogs({ mode: "ACTIVE", deps, attempts, now: NOW }), { refreshed: 1, failed: 1 });
  assert.deepEqual(await refreshDueFollowedCatalogs({ mode: "ACTIVE", deps, attempts, now: NOW }), { refreshed: 0, failed: 0 }, "retry waits");
  assert.deepEqual(
    await refreshDueFollowedCatalogs({ mode: "ACTIVE", deps: { ...deps, providerBlocked: async () => true }, attempts: new Map(), now: NOW }),
    { refreshed: 0, failed: 0 },
  );
});

test("#564 manual refresh runs in background, one at a time per user, and records the outcome", async () => {
  let release: (value: boolean) => void = () => undefined;
  let runs = 0;
  const run = () => {
    runs += 1;
    return new Promise<boolean>((resolve) => {
      release = resolve;
    });
  };
  assert.equal(startFollowedCatalogRefresh("bg", run), "started");
  assert.equal(isFollowedCatalogRefreshRunning("bg"), true);
  assert.equal(startFollowedCatalogRefresh("bg", run), "running", "no second concurrent read");
  assert.equal(runs, 1);

  let cronRefreshes = 0;
  await refreshDueFollowedCatalogs({
    mode: "ACTIVE",
    now: NOW,
    attempts: new Map(),
    deps: {
      listUserIds: async () => ["bg"],
      readFetchedAt: async () => null,
      providerBlocked: async () => false,
      refresh: async () => {
        cronRefreshes += 1;
        return true;
      },
    },
  });
  assert.equal(cronRefreshes, 0, "cron skips a user whose manual read is running");

  release(true);
  await waitForFollowedCatalogRefresh("bg");
  assert.equal(isFollowedCatalogRefreshRunning("bg"), false);
  assert.equal(lastFollowedCatalogRefreshOutcome("bg"), "updated");

  assert.equal(startFollowedCatalogRefresh("bg", async () => { throw new Error("boom"); }), "started");
  await waitForFollowedCatalogRefresh("bg");
  assert.equal(lastFollowedCatalogRefreshOutcome("bg"), "failed");
});
