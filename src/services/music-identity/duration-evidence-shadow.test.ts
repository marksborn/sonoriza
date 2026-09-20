import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import {
  durationAvailability,
  durationStronglyConflicts,
  evaluateDurationEvidence,
} from "./duration-evidence-shadow";

function track(input: {
  id: string;
  persistedDurationMs: number;
  trait?: "STANDARD" | "LIVE" | "REMASTER";
}) {
  return {
    providerTrackId: input.id,
    recordingIdentityId: `recording-${input.id}`,
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist",
    trackName:
      input.trait === "LIVE"
        ? "Song - Live"
        : input.trait === "REMASTER"
          ? "Song - 2021 Remaster"
          : "Song",
    albumName: null,
    persistedDurationMs: input.persistedDurationMs,
    versionTrait: input.trait ?? "STANDARD",
  } as const;
}

function lookup(input: {
  id: string;
  isrc: string | null;
  durationMs: number;
}): SpotifyCatalogTrackLookup {
  return {
    requestedTrackId: input.id,
    track: {
      id: input.id,
      name: input.id,
      uri: `spotify:track:${input.id}`,
      spotifyUrl: null,
      isrc: input.isrc,
      artists: [
        {
          id: "artist-1",
          name: "Artist",
          uri: "spotify:artist:artist-1",
          spotifyUrl: null,
        },
      ],
      albumId: null,
      albumName: null,
      durationMs: input.durationMs,
      linkedFromTrackId: null,
      isPlayable: true,
      restrictionReason: null,
    },
  };
}

test("missing persisted duration is separated from compatible live provider duration", () => {
  const result = evaluateDurationEvidence(
    {
      left: track({ id: "a", persistedDurationMs: 0 }),
      right: track({ id: "b", persistedDurationMs: 176_160 }),
    },
    lookup({ id: "a", isrc: "USABC2600001", durationMs: 176_100 }),
    lookup({ id: "b", isrc: "USABC2600001", durationMs: 176_160 }),
  );

  assert.ok(result);
  assert.equal(result.persistedDurationAvailability, "LEFT_MISSING");
  assert.equal(result.persistedDurationDeltaMs, null);
  assert.equal(result.providerDurationAvailability, "COMPLETE");
  assert.equal(result.providerDurationDeltaMs, 60);
  assert.equal(result.providerStrongConflict, false);
});

test("same ISRC with a real provider duration conflict is surfaced but not merged", () => {
  const result = evaluateDurationEvidence(
    {
      left: track({ id: "a", persistedDurationMs: 180_000 }),
      right: track({ id: "b", persistedDurationMs: 181_000, trait: "REMASTER" }),
    },
    lookup({ id: "a", isrc: "USABC2600001", durationMs: 180_000 }),
    lookup({ id: "b", isrc: "USABC2600001", durationMs: 220_000 }),
  );

  assert.ok(result);
  assert.equal(result.persistedDurationAvailability, "COMPLETE");
  assert.equal(result.providerDurationAvailability, "COMPLETE");
  assert.equal(result.providerDurationDeltaMs, 40_000);
  assert.equal(result.providerStrongConflict, true);
});

test("different ISRC pairs are outside the Gate 3C same-ISRC duration diagnostic", () => {
  const result = evaluateDurationEvidence(
    {
      left: track({ id: "a", persistedDurationMs: 180_000 }),
      right: track({ id: "b", persistedDurationMs: 180_000 }),
    },
    lookup({ id: "a", isrc: "USABC2600001", durationMs: 180_000 }),
    lookup({ id: "b", isrc: "USABC2600002", durationMs: 180_000 }),
  );

  assert.equal(result, null);
});

test("duration availability distinguishes incomplete evidence", () => {
  assert.equal(durationAvailability(180_000, 180_000), "COMPLETE");
  assert.equal(durationAvailability(0, 180_000), "LEFT_MISSING");
  assert.equal(durationAvailability(180_000, 0), "RIGHT_MISSING");
  assert.equal(durationAvailability(0, 0), "BOTH_MISSING");
});

test("strong duration conflict keeps the existing max(10s, 5%) threshold", () => {
  assert.equal(durationStronglyConflicts(180_000, 190_000), false);
  assert.equal(durationStronglyConflicts(180_000, 190_001), true);
  assert.equal(durationStronglyConflicts(0, 220_000), false);
});
