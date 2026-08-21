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

test("runtime identity loader receives one final SQL-reduced row per track", async () => {
  const expected = [
    {
      spotifyTrackId: "track-1",
      isrc: "BRABC1234567",
      primaryArtistId: "artist-1",
      isrcConflict: false,
      primaryArtistIdConflict: false,
    },
    {
      spotifyTrackId: "track-2",
      isrc: null,
      primaryArtistId: null,
      isrcConflict: true,
      primaryArtistIdConflict: true,
    },
  ];

  let rawCalls = 0;
  let groupByCalls = 0;
  const client = {
    trackListeningEvent: {
      groupBy: async () => {
        groupByCalls += 1;
        throw new Error("runtime identity path must not materialize distinct triples");
      },
    },
    $queryRawUnsafe: async (query: string, userId: string) => {
      rawCalls += 1;
      assert.equal(userId, "user-1");
      assert.match(query, /regexp_replace/);
      assert.match(query, /\[\^A-Za-z0-9\]/);
      assert.match(query, /COUNT\(DISTINCT "normalizedIsrc"\)/);
      assert.match(query, /COUNT\(DISTINCT "normalizedPrimaryArtistId"\)/);
      assert.match(query, /"isrcCount" > 1/);
      assert.match(query, /"primaryArtistIdCount" > 1/);
      assert.match(query, /ORDER BY "spotifyTrackId" ASC/);
      return expected;
    },
  } as unknown as PrismaClient;

  const evidence = await getDiscoveryTrackIdentityEvidence("user-1", client);

  assert.equal(rawCalls, 1);
  assert.equal(groupByCalls, 0);
  assert.deepEqual(evidence, expected);
});
