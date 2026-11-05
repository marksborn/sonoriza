import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeShowCatalogCache,
  encodeShowCatalogCache,
  isShowCatalogCacheFresh,
  SHOW_CATALOG_CACHE_TTL_MS,
  showCatalogFirstPageDelta,
} from "./show-catalog-cache";

test("SHOW catalog cache keeps catalog metadata but excludes playback state", () => {
  const payload = encodeShowCatalogCache(
    [
      {
        id: "episode-1",
        uri: "spotify:episode:episode-1",
        name: "Episode 1",
        duration_ms: 120_000,
        type: "episode",
        is_local: false,
        is_playable: true,
        show: { id: "show-1", name: "Show 1" },
        release_date: "2026-09-25",
        release_date_precision: "day",
      },
    ],
    7,
  );

  const decoded = decodeShowCatalogCache(payload);
  assert.ok(decoded);
  assert.equal(decoded.pageCount, 7);
  assert.equal(decoded.episodes.length, 1);
  assert.equal(decoded.episodes[0]?.id, "episode-1");
  assert.equal(decoded.episodes[0]?.show?.id, "show-1");
  assert.equal("resume_point" in (decoded.episodes[0] ?? {}), false);
});

test("SHOW catalog cache rejects incompatible or corrupted payloads", () => {
  assert.equal(decodeShowCatalogCache(null), null);
  assert.equal(
    decodeShowCatalogCache({
      kind: "PODCAST_SHOW_CATALOG",
      version: 999,
      pageCount: 1,
      episodes: [],
    }),
    null,
  );
  assert.equal(
    decodeShowCatalogCache({
      kind: "PODCAST_SHOW_CATALOG",
      version: 1,
      pageCount: 1,
      episodes: [{ uri: "spotify:episode:broken" }],
    }),
    null,
  );
});

test("SHOW catalog cache is fresh only inside the 24h TTL", () => {
  const now = new Date("2026-09-25T20:00:00.000Z");
  assert.equal(
    isShowCatalogCacheFresh(
      new Date(now.getTime() - SHOW_CATALOG_CACHE_TTL_MS + 1),
      now,
    ),
    true,
  );
  assert.equal(
    isShowCatalogCacheFresh(
      new Date(now.getTime() - SHOW_CATALOG_CACHE_TTL_MS),
      now,
    ),
    false,
  );
  assert.equal(
    isShowCatalogCacheFresh(new Date(now.getTime() + 1), now),
    false,
  );
  assert.equal(isShowCatalogCacheFresh(null, now), false);
});

const NOW = new Date("2026-11-05T12:00:00Z");
const catalog = (...ids: string[]) => ({
  episodes: ids.map((id) => ({ uri: `spotify:episode:${id}`, name: id, duration_ms: 1, type: "episode" as const })),
  providerTotal: ids.length,
  fullReadAt: "2026-11-01T12:00:00Z",
});
const page = (...ids: string[]) => ids.map((id) => ({ uri: `spotify:episode:${id}` }));

test("first-page delta returns only the episodes newer than the cache", () => {
  const delta = showCatalogFirstPageDelta({
    cache: catalog("c", "b", "a"),
    firstPageItems: page("e", "d", "c", "b"),
    providerTotal: 5,
    now: NOW,
  });
  assert.deepEqual(delta?.newItems.map((item) => item.uri), ["spotify:episode:e", "spotify:episode:d"]);
  assert.equal(delta?.providerTotal, 5);
  const unchanged = showCatalogFirstPageDelta({
    cache: catalog("b", "a"), firstPageItems: page("b", "a"), providerTotal: 2, now: NOW,
  });
  assert.deepEqual(unchanged?.newItems, []);
});

test("first-page delta requires a full read whenever it cannot prove the catalog", () => {
  const base = { cache: catalog("c", "b", "a"), now: NOW };
  assert.equal(showCatalogFirstPageDelta({ ...base, firstPageItems: page("c", "b"), providerTotal: 2 }), null, "removed episode");
  assert.equal(showCatalogFirstPageDelta({ ...base, firstPageItems: page("x", "y"), providerTotal: 5 }), null, "no overlap");
  assert.equal(showCatalogFirstPageDelta({ ...base, firstPageItems: page("c"), providerTotal: undefined }), null, "no total");
  const { providerTotal: _ignored, ...legacy } = catalog("c");
  assert.equal(showCatalogFirstPageDelta({ cache: legacy, firstPageItems: page("c"), providerTotal: 1, now: NOW }), null, "legacy cache");
  assert.equal(
    showCatalogFirstPageDelta({
      cache: { ...catalog("c"), fullReadAt: "2026-10-01T12:00:00Z" },
      firstPageItems: page("c"), providerTotal: 1, now: NOW,
    }),
    null,
    "periodic full read",
  );
});

test("refresh metadata survives the cache round trip", () => {
  const payload = encodeShowCatalogCache([], 41, { providerTotal: 2031, fullReadAt: "2026-11-01T12:00:00Z" });
  const decoded = decodeShowCatalogCache(JSON.parse(JSON.stringify(payload)));
  assert.equal(decoded?.providerTotal, 2031);
  assert.equal(decoded?.fullReadAt, "2026-11-01T12:00:00Z");
});
