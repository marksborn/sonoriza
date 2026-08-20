import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyExtendedMusicEvent } from "./parser";
import {
  buildSpotifyExtendedPersistenceManifest,
  parseSpotifyExtendedPersistenceManifest,
} from "./persistence-manifest";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import { reconcileSpotifyExtendedHistory } from "./reconcile";

const PACKAGE_SHA = "a".repeat(64);

test("HISTORY-02 manifest binds user, package and frozen plan", () => {
  const reconciliation = reconcileSpotifyExtendedHistory(
    [event("one")],
    [],
  );
  const plan = buildSpotifyExtendedPersistencePlan(PACKAGE_SHA, reconciliation);
  const manifest = buildSpotifyExtendedPersistenceManifest("user-1", plan);

  const parsed = parseSpotifyExtendedPersistenceManifest(
    JSON.parse(JSON.stringify(manifest)),
  );

  assert.equal(parsed.userId, "user-1");
  assert.equal(parsed.packageSha256, PACKAGE_SHA);
  assert.equal(parsed.planHash, plan.planHash);
  assert.match(parsed.manifestHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsed.summary, plan.summary);
  assert.deepEqual(parsed.actions, plan.actions);
});

test("HISTORY-02 manifest rejects action tampering", () => {
  const plan = buildSpotifyExtendedPersistencePlan(
    PACKAGE_SHA,
    reconcileSpotifyExtendedHistory([event("one")], []),
  );
  const manifest = buildSpotifyExtendedPersistenceManifest("user-1", plan);
  const tampered = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const actions = tampered.actions as Array<Record<string, unknown>>;
  actions[0]!.kind = "QUARANTINE_CONFLICT";

  assert.throws(
    () => parseSpotifyExtendedPersistenceManifest(tampered),
    /plan hash does not match/i,
  );
});

test("HISTORY-02 manifest hash changes when user changes", () => {
  const plan = buildSpotifyExtendedPersistencePlan(
    PACKAGE_SHA,
    reconcileSpotifyExtendedHistory([event("one")], []),
  );

  const first = buildSpotifyExtendedPersistenceManifest("user-1", plan);
  const second = buildSpotifyExtendedPersistenceManifest("user-2", plan);
  assert.notEqual(first.manifestHash, second.manifestHash);
  assert.equal(first.planHash, second.planHash, "plan hash remains the Gate 2.2 content hash");
});

function event(id: string): SpotifyExtendedMusicEvent {
  const startedAt = new Date("2026-08-18T10:00:00Z");
  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: new Date(startedAt.getTime() + 180_000),
    estimatedStartedAt: startedAt,
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
