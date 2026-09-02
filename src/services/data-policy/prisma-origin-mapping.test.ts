import assert from "node:assert/strict";
import test from "node:test";

import {
  originForLikedTrackPreferenceProvenance,
  originForListeningEventSource,
} from "./prisma-origin-mapping";

test("current listening event source values map to the expected origin", () => {
  assert.equal(originForListeningEventSource("SPOTIFY_RECENTLY_PLAYED"), "SPOTIFY");
  assert.equal(originForListeningEventSource("SPOTIFY_EXTENDED_HISTORY"), "SPOTIFY");
  assert.equal(originForListeningEventSource("LASTFM_SCROBBLE"), "LASTFM");
  assert.equal(originForListeningEventSource("IMPORT"), "USER_IMPORT");
});

test("legacy liked-track provenance is conservatively treated as Spotify", () => {
  assert.equal(originForLikedTrackPreferenceProvenance("LIKED_TRACK_BACKFILL"), "SPOTIFY");
  assert.equal(originForLikedTrackPreferenceProvenance("LIKED_TRACK_SYNC"), "SPOTIFY");
});
