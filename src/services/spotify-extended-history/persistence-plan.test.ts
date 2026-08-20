import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyExtendedMusicEvent } from "./parser";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import {
  reconcileSpotifyExtendedHistory,
  type ExistingListeningEvent,
} from "./reconcile";

test("HISTORY-02 persistence plan separates inserts, enrichment and quarantine", () => {
  const exact = event("exact", "Artist A", "Track A", "2026-08-18T10:00:00Z");
  const fresh = event("fresh", "Artist B", "Track B", "2026-08-18T11:00:00Z");
  const near = event("near", "Artist C", "Track C", "2026-08-18T12:00:00Z");

  const existingEvents: ExistingListeningEvent[] = [
    existing("lf-exact", null, "Track A", "Artist A", "2026-08-18T10:00:01Z", "LASTFM_SCROBBLE"),
    existing("lf-near", null, "Track C", "Artist C", "2026-08-18T12:05:00Z", "LASTFM_SCROBBLE"),
  ];

  const reconciliation = reconcileSpotifyExtendedHistory(
    [exact, fresh, near],
    existingEvents,
  );

  const plan = buildSpotifyExtendedPersistencePlan("package-sha", reconciliation);

  assert.deepEqual(plan.summary, {
    insertNew: 1,
    enrichExisting: 1,
    quarantineConflict: 1,
    noopAlreadyEnriched: 0,
  });

  assert.deepEqual(
    plan.actions.map((action) => [action.kind, action.existingEventId]),
    [
      ["ENRICH_EXISTING", "lf-exact"],
      ["INSERT_NEW", null],
      ["QUARANTINE_CONFLICT", null],
    ],
  );
});

test("HISTORY-02 persistence plan quarantines every export event that reuses one enrichment target", () => {
  const first = event("first", "Artist A", "Track A", "2026-08-18T10:00:00Z");
  const second = event("second", "Artist A", "Track A", "2026-08-18T10:01:00Z");

  const reconciliation = reconcileSpotifyExtendedHistory(
    [first, second],
    [
      existing(
        "lf-shared",
        null,
        "Track A",
        "Artist A",
        "2026-08-18T10:00:30Z",
        "LASTFM_SCROBBLE",
      ),
    ],
  );

  assert.deepEqual(
    reconciliation.entries.map((entry) => [entry.classification, entry.matchedExistingEventId]),
    [
      ["EXACT_EXISTING_LASTFM", "lf-shared"],
      ["EXACT_EXISTING_LASTFM", "lf-shared"],
    ],
    "each event is exact in isolation, which is why the global persistence guard is required",
  );

  const plan = buildSpotifyExtendedPersistencePlan("package-sha", reconciliation);

  assert.deepEqual(plan.summary, {
    insertNew: 0,
    enrichExisting: 0,
    quarantineConflict: 2,
    noopAlreadyEnriched: 0,
  });

  assert.deepEqual(
    plan.actions.map((action) => ({
      kind: action.kind,
      existingEventId: action.existingEventId,
      classification: action.classification,
      conflictReason: action.conflictReason,
      candidateCount: action.candidateCount,
    })),
    [
      {
        kind: "QUARANTINE_CONFLICT",
        existingEventId: null,
        classification: "CONFLICT_AMBIGUOUS",
        conflictReason: "REUSED_EXISTING_TARGET",
        candidateCount: 2,
      },
      {
        kind: "QUARANTINE_CONFLICT",
        existingEventId: null,
        classification: "CONFLICT_AMBIGUOUS",
        conflictReason: "REUSED_EXISTING_TARGET",
        candidateCount: 2,
      },
    ],
  );
});

test("HISTORY-02 persistence plan hash is deterministic and binds the package", () => {
  const reconciliation = reconcileSpotifyExtendedHistory(
    [event("fresh", "Artist", "Track", "2026-08-18T10:00:00Z")],
    [],
  );

  const first = buildSpotifyExtendedPersistencePlan("sha-a", reconciliation);
  const second = buildSpotifyExtendedPersistencePlan("sha-a", reconciliation);
  const otherPackage = buildSpotifyExtendedPersistencePlan("sha-b", reconciliation);

  assert.equal(first.planHash, second.planHash);
  assert.notEqual(first.planHash, otherPackage.planHash);
  assert.match(first.planHash, /^[a-f0-9]{64}$/);
});

function event(
  id: string,
  artistName: string,
  trackName: string,
  estimatedStartedAt: string,
): SpotifyExtendedMusicEvent {
  const start = new Date(estimatedStartedAt);
  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: start,
    estimatedStartedAt: start,
    msPlayed: 0,
    spotifyTrackUri: `spotify:track:${id}`,
    spotifyTrackId: id,
    trackName,
    artistName,
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

function existing(
  id: string,
  spotifyTrackId: string | null,
  trackName: string,
  artistName: string,
  playedAt: string,
  source: string,
): ExistingListeningEvent {
  return {
    id,
    spotifyTrackId,
    trackName,
    artistName,
    playedAt: new Date(playedAt),
    source,
    metadata: null,
  };
}
