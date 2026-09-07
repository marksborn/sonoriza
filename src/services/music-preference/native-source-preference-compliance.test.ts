import assert from "node:assert/strict";
import test from "node:test";

import {
  LIKED_TRACK_SOURCE_COMPLIANCE_REASON,
  isLikedTrackSourcePlannerUseAllowed,
} from "./native-source-preference";

test("Spotify Saved Tracks direct planner use is authorized by the completed #278/#186 feature review", () => {
  assert.equal(isLikedTrackSourcePlannerUseAllowed(), true);
  assert.equal(
    LIKED_TRACK_SOURCE_COMPLIANCE_REASON,
    "COMPLIANCE_SPOTIFY_SAVED_TRACKS_NOT_AUTHORIZED_FOR_PLANNER",
  );
});
