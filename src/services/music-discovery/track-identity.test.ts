import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  buildDiscoveryTrackIdentityEvidence,
  getDiscoveryTrackIdentityEvidence,
} from "./track-identity";

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

test("Gate 5A runtime identity loader does not read provider listening history", async () => {
  let rawCalls = 0;
  let groupByCalls = 0;
  const client = {
    trackListeningEvent: {
      groupBy: async () => {
        groupByCalls += 1;
        return [];
      },
    },
    $queryRawUnsafe: async () => {
      rawCalls += 1;
      return [
        {
          spotifyTrackId: "forbidden-provider-history",
          isrc: "BRABC1234567",
          primaryArtistId: "artist-1",
          isrcConflict: false,
          primaryArtistIdConflict: false,
        },
      ];
    },
  } as unknown as PrismaClient;

  const evidence = await getDiscoveryTrackIdentityEvidence("user-1", client);

  assert.deepEqual(evidence, []);
  assert.equal(rawCalls, 0);
  assert.equal(groupByCalls, 0);
});
