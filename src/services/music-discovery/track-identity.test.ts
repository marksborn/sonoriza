import assert from "node:assert/strict";
import test from "node:test";

import { buildDiscoveryTrackIdentityEvidence } from "./track-identity";

test("identity evidence is unchanged by duplicate listening rows", () => {
  const evidence = buildDiscoveryTrackIdentityEvidence([
    {
      spotifyTrackId: "track-1",
      isrc: "BR-ABC-12-34567",
      primaryArtistId: "artist-1",
    },
    {
      spotifyTrackId: "track-1",
      isrc: "BRABC1234567",
      primaryArtistId: "artist-1",
    },
    {
      spotifyTrackId: "track-1",
      isrc: "BR-ABC-12-34567",
      primaryArtistId: "artist-1",
    },
  ]);

  assert.deepEqual(evidence, [
    {
      spotifyTrackId: "track-1",
      isrc: "BRABC1234567",
      primaryArtistId: "artist-1",
      isrcConflict: false,
      primaryArtistIdConflict: false,
    },
  ]);
});

test("identity evidence still reports distinct ISRC and artist conflicts", () => {
  const evidence = buildDiscoveryTrackIdentityEvidence([
    {
      spotifyTrackId: "track-1",
      isrc: "BRABC1234567",
      primaryArtistId: "artist-1",
    },
    {
      spotifyTrackId: "track-1",
      isrc: "USXYZ7654321",
      primaryArtistId: "artist-2",
    },
  ]);

  assert.deepEqual(evidence, [
    {
      spotifyTrackId: "track-1",
      isrc: null,
      primaryArtistId: null,
      isrcConflict: true,
      primaryArtistIdConflict: true,
    },
  ]);
});
