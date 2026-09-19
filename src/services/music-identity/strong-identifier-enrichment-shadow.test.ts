import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePair } from "./strong-identifier-enrichment-shadow";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";

function track(input: {
  id: string;
  title: string;
  trait:
    | "STANDARD"
    | "LIVE"
    | "ACOUSTIC"
    | "REMIX"
    | "DEMO"
    | "REMASTER"
    | "UNKNOWN";
  durationMs?: number;
}) {
  return {
    providerTrackId: input.id,
    recordingIdentityId: `recording-${input.id}`,
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist",
    trackName: input.title,
    albumName: null,
    durationMs: input.durationMs ?? 180_000,
    versionTrait: input.trait,
  } as const;
}

function lookup(id: string, isrc: string | null): SpotifyCatalogTrackLookup {
  return {
    requestedTrackId: id,
    track: {
      id,
      name: id,
      uri: `spotify:track:${id}`,
      spotifyUrl: null,
      isrc,
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
      durationMs: 180_000,
      linkedFromTrackId: null,
      isPlayable: true,
      restrictionReason: null,
    },
  };
}

test("same ISRC promotes a textual standard/remaster pair to recording review only", () => {
  const result = evaluatePair(
    {
      left: track({ id: "a", title: "Song", trait: "STANDARD" }),
      right: track({ id: "b", title: "Song - 2021 Remaster", trait: "REMASTER" }),
    },
    lookup("a", "BRABC2600001"),
    lookup("b", "br-abc-26-00001"),
  );

  assert.equal(result.baselineKind, "TEXTUAL_POSSIBLE_MATCH");
  assert.equal(result.sameIsrc, true);
  assert.equal(result.outcome, "REVIEW_RECORDING_MERGE");
});

test("same ISRC never collapses live and studio when version evidence conflicts", () => {
  const result = evaluatePair(
    {
      left: track({ id: "a", title: "Song", trait: "STANDARD" }),
      right: track({ id: "b", title: "Song - Live", trait: "LIVE" }),
    },
    lookup("a", "USABC2600001"),
    lookup("b", "USABC2600001"),
  );

  assert.equal(result.baselineKind, "SAME_SONG_DIFFERENT_RECORDING");
  assert.equal(result.sameIsrc, true);
  assert.equal(result.outcome, "STRONG_ID_CONFLICT_REVIEW_ONLY");
});

test("different ISRCs keep a textual pair review-only", () => {
  const result = evaluatePair(
    {
      left: track({ id: "a", title: "Song", trait: "STANDARD" }),
      right: track({ id: "b", title: "Song", trait: "STANDARD" }),
    },
    lookup("a", "USAAA2600001"),
    lookup("b", "USAAA2600002"),
  );

  assert.equal(result.sameIsrc, false);
  assert.equal(result.outcome, "DIFFERENT_ISRC_REVIEW_ONLY");
});

test("missing ISRC does not promote a textual pair", () => {
  const result = evaluatePair(
    {
      left: track({ id: "a", title: "Song", trait: "STANDARD" }),
      right: track({ id: "b", title: "Song", trait: "STANDARD" }),
    },
    lookup("a", "USAAA2600001"),
    lookup("b", null),
  );

  assert.equal(result.outcome, "INSUFFICIENT_STRONG_ID");
});

test("live/studio stays separated when ISRCs differ", () => {
  const result = evaluatePair(
    {
      left: track({ id: "a", title: "Song", trait: "STANDARD" }),
      right: track({ id: "b", title: "Song - Live", trait: "LIVE" }),
    },
    lookup("a", "USAAA2600001"),
    lookup("b", "USAAA2600002"),
  );

  assert.equal(result.outcome, "KEEP_RECORDINGS_SEPARATE");
});
