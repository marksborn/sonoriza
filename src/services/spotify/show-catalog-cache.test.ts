import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeShowCatalogCache,
  encodeShowCatalogCache,
  isShowCatalogCacheFresh,
  SHOW_CATALOG_CACHE_TTL_MS,
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
