import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGate5CIsrcMbid,
  gate5CNormalizeIsrc,
  type Gate5CMusicBrainzRecording,
  type Gate5CProviderTrack,
} from "./musicbrainz-isrc-mbid-shadow";
import { Gate5CMusicBrainzClient } from "./musicbrainz-isrc-mbid-shadow-client";

const MBID1 = "13319e84-d6d6-4a15-ad68-94c1b674f97e";
const MBID2 = "47afceb7-47fb-4987-b738-8a8c7e275957";
const SPOTIFY: Gate5CProviderTrack = {
  title: "Becoming the Bull",
  artistName: "Atreyu",
  durationMs: 220600,
  isrc: "USHR10723245",
  linkedFromTrackId: null,
};
const RECORDING: Gate5CMusicBrainzRecording = {
  id: MBID1,
  title: "Becoming the Bull",
  durationMs: 220600,
  artistNames: ["Atreyu"],
};

function compare(options: {
  spotify?: Partial<Gate5CProviderTrack>;
  recordings?: Gate5CMusicBrainzRecording[];
  notFound?: boolean;
} = {}) {
  return evaluateGate5CIsrcMbid({
    spotify: { ...SPOTIFY, ...options.spotify },
    lookup: options.notFound
      ? { kind: "NOT_FOUND" }
      : { kind: "FOUND", recordings: options.recordings ?? [RECORDING] },
  });
}

test("Gate 5C: unique aligned ISRC MBID is always review-only", () => {
  const row = compare();
  assert.equal(row.decision, "REVIEW_SINGLE_MBID");
  assert.deepEqual(row.mbids, [MBID1]);
  assert.equal(row.productiveCooldownEligible, false);
  assert.equal(row.recordingIdentityWrites, false);
});

test("Gate 5C: even identical duration+artist cannot resolve two different MBIDs", () => {
  const row = compare({
    recordings: [RECORDING, { ...RECORDING, id: MBID2, durationMs: 220613 }],
  });
  assert.equal(row.decision, "ABSTAIN_MULTIPLE_MBIDS");
  assert.equal(row.recordingCount, 2);
  assert.deepEqual(row.mbids, [MBID1, MBID2].sort());
});

test("Gate 5C: MusicBrainz HTTP 404 is abstention, not negative listening evidence", () => {
  assert.equal(compare({ notFound: true }).decision, "ABSTAIN_ISRC_NOT_FOUND_404");
});

test("Gate 5C: empty recording list abstains", () => {
  assert.equal(compare({ recordings: [] }).decision, "ABSTAIN_ZERO_RECORDINGS");
});

test("Gate 5C: original/remaster with matching recording metadata is review-only", () => {
  const row = compare({ spotify: { title: "Becoming the Bull - Remastered" } });
  assert.equal(row.decision, "REVIEW_STANDARD_REMASTER");
  assert.equal(row.productiveCooldownEligible, false);
});

test("Gate 5C: live/studio, remix and acoustic cannot be silently merged", () => {
  for (const label of ["Live", "Remix", "Acoustic", "Demo"]) {
    assert.equal(
      compare({ spotify: { title: `Becoming the Bull - ${label}` } }).decision,
      "ABSTAIN_VERSION_CONFLICT",
    );
  }
});

test("Gate 5C: same song by a cover artist abstains", () => {
  assert.equal(compare({ spotify: { artistName: "Cover Artist" } }).decision,
    "ABSTAIN_ARTIST_MISMATCH");
});

test("Gate 5C: mismatched title abstains", () => {
  assert.equal(compare({ spotify: { title: "Another Song" } }).decision,
    "ABSTAIN_TITLE_MISMATCH");
});

test("Gate 5C: duration gap over 5 seconds abstains", () => {
  const row = compare({ recordings: [{ ...RECORDING, durationMs: 231000 }] });
  assert.equal(row.decision, "ABSTAIN_DURATION_MISMATCH");
  assert.equal(row.durationDeltaMs, 10400);
});

test("Gate 5C: missing durations abstain", () => {
  assert.equal(compare({ recordings: [{ ...RECORDING, durationMs: null }] }).decision,
    "ABSTAIN_DURATION_MISSING");
});

test("Gate 5C: relinking and missing ISRC abstain", () => {
  assert.equal(compare({ spotify: { linkedFromTrackId: "original-id" } }).decision,
    "ABSTAIN_RELINKED_TRACK");
  assert.equal(compare({ spotify: { isrc: null } }).decision,
    "ABSTAIN_INVALID_ISRC");
});

test("Gate 5C: mixed-case ISRC normalized before MusicBrainz lookup", () => {
  assert.equal(gate5CNormalizeIsrc("ushm91360981"), "USHM91360981");
  assert.equal(gate5CNormalizeIsrc("not-an-isrc"), null);
});

test("Gate 5C: malformed MBID cannot create a canonical association", () => {
  assert.equal(compare({ recordings: [{ ...RECORDING, id: "random-string" }] }).decision,
    "ABSTAIN_INVALID_MUSICBRAINZ_MBID");
});

test("Gate 5C: 404 and 200 map to distinct client outcomes", async () => {
  const requests: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return requests.length === 1
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify({
          recordings: [{
            id: MBID1,
            title: "Becoming the Bull",
            length: 220600,
            "artist-credit": [{ name: "Atreyu" }],
          }],
        }), { status: 200 });
  }) as typeof fetch;
  let now = 10000;
  const delays: number[] = [];
  const client = new Gate5CMusicBrainzClient(
    fake,
    async (ms) => { delays.push(ms); now += ms; },
    () => now,
  );
  assert.deepEqual(await client.lookup("USHR10723245"), { kind: "NOT_FOUND" });
  const result = await client.lookup("USHR10723245");
  assert.equal(result.kind, "FOUND");
  if (result.kind === "FOUND") {
    assert.deepEqual(result.recordings.at(0)?.artistNames, ["Atreyu"]);
    assert.equal(result.recordings.at(0)?.id, MBID1);
  }
  assert.deepEqual(delays, [1500]);
  assert.equal(client.getMetrics().requests, 2);
});

test("Gate 5C: 503/429 stop the batch; no retry", async () => {
  for (const status of [429, 503]) {
    let attempts = 0;
    const fake = (async () => {
      attempts += 1;
      return new Response("rate limited", { status });
    }) as typeof fetch;
    const client = new Gate5CMusicBrainzClient(fake);
    await assert.rejects(() => client.lookup("USHR10723245"), new RegExp(String(status)));
    assert.equal(attempts, 1);
  }
});

test("Gate 5C: invalid ISRC never sends a provider request", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const client = new Gate5CMusicBrainzClient(fake);
  await assert.rejects(() => client.lookup("bad!"), /invalid ISRC/i);
  assert.equal(calls, 0);
});

test("Gate 5C: invalid payload fails closed", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ unexpected: [] }), { status: 200 })
  ) as typeof fetch;
  const client = new Gate5CMusicBrainzClient(fake);
  await assert.rejects(() => client.lookup("USHR10723245"), /invalid MusicBrainz payload/);
});
