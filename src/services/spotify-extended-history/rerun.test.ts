import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyExtendedMusicEvent } from "./parser";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import {
  reconcileSpotifyExtendedHistory,
  type ExistingListeningEvent,
} from "./reconcile";

test("HISTORY-02 recognizes an already imported extended event by sourceEventKey", () => {
  const exportEvent = event("same", "2026-08-18T10:00:00Z");
  const existing: ExistingListeningEvent = {
    id: "extended-existing",
    spotifyTrackId: exportEvent.spotifyTrackId,
    trackName: exportEvent.trackName,
    artistName: exportEvent.artistName,
    playedAt: new Date("2026-08-18T09:30:00Z"),
    source: "SPOTIFY_EXTENDED_HISTORY",
    sourceEventKey: exportEvent.sourceEventKey,
    metadata: {
      spotifyExtendedHistory: {
        sourceEventKey: exportEvent.sourceEventKey,
      },
    },
  };

  const reconciliation = reconcileSpotifyExtendedHistory([exportEvent], [existing]);

  assert.equal(reconciliation.entries[0]?.classification, "EXACT_EXISTING_EXTENDED_HISTORY");
  assert.equal(reconciliation.entries[0]?.matchedExistingEventId, existing.id);
  assert.equal(reconciliation.entries[0]?.enrichmentCandidate, false);
  assert.equal(reconciliation.summary.exactExistingExtendedHistory, 1);
  assert.equal(reconciliation.summary.newUncoveredEvents, 0);
  assert.equal(reconciliation.summary.estimatedInserts, 0);

  const plan = buildSpotifyExtendedPersistencePlan("package-sha", reconciliation);
  assert.deepEqual(plan.summary, {
    insertNew: 0,
    enrichExisting: 0,
    quarantineConflict: 0,
    noopAlreadyEnriched: 1,
  });
  assert.equal(plan.actions[0]?.kind, "NOOP_ALREADY_ENRICHED");
});

function event(id: string, startedAt: string): SpotifyExtendedMusicEvent {
  const start = new Date(startedAt);
  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: new Date(start.getTime() + 180_000),
    estimatedStartedAt: start,
    msPlayed: 180_000,
    spotifyTrackUri: `spotify:track:${id}`,
    spotifyTrackId: id,
    trackName: "Track",
    artistName: "Artist",
    albumName: "Album",
    reasonStart: null,
    reasonEnd: null,
    skipped: false,
    offline: false,
    offlineTimestamp: null,
    incognitoMode: false,
    sourceEventKey: `key-${id}`,
  };
}
