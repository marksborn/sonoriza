import assert from "node:assert/strict";
import test from "node:test";

import {
  LIKED_TRACK_SOURCE_COMPLIANCE_REASON,
  isLikedTrackSourcePlannerUseAllowed,
} from "./native-source-preference";

test("Spotify Saved Tracks cannot drive productive planner under current capability matrix", () => {
  assert.equal(isLikedTrackSourcePlannerUseAllowed(), false);
  assert.equal(
    LIKED_TRACK_SOURCE_COMPLIANCE_REASON,
    "COMPLIANCE_SPOTIFY_SAVED_TRACKS_NOT_AUTHORIZED_FOR_PLANNER",
  );
});
