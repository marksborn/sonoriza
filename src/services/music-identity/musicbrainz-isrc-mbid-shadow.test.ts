import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGate5CIsrcMbid,
  gate5CNormalizeIsrc,
  type Gate5CMusicBrainzRecording,
  type Gate5CProviderTrack,
} from "./musicbrainz-isrc-mbid-shadow";
import { Gate5CMusicBrainzClient } from "./musicbrainz-isrc-mbid-shadow-client";
import { compareGate5BMbidEvidence } from "./canonical-factual-mbid-linkage-shadow";
import { deriveBaseTitleSignal } from "./shadow-resolver-report";

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

// Recorded operator evidence from #374 Gates 5D.4/5D.6. No live provider
// requests: the historical Flyleaf MBID lookup returned 404, NOT the ISRC
// lookup used by Gate 5C. Neither result establishes recording equivalence.
const ATOMSHIP: Gate5CProviderTrack = {
  title: "Dragon Fly", artistName: "Atomship", durationMs: 261920,
  isrc: "USWU30300079", linkedFromTrackId: null,
};
const ATOMSHIP_RECORDING: Gate5CMusicBrainzRecording = {
  id: "80b3b39e-9ab0-402a-8541-2f3eab6174c3",
  title: "Dragonfly", artistNames: ["Atomship"], durationMs: 261920,
};

function compareAtomship(
  spotify: Partial<Gate5CProviderTrack> = {},
  recording: Partial<Gate5CMusicBrainzRecording> = {},
) {
  return evaluateGate5CIsrcMbid({
    spotify: { ...ATOMSHIP, ...spotify },
    lookup: { kind: "FOUND", recordings: [{ ...ATOMSHIP_RECORDING, ...recording }] },
  });
}

function assertReviewOnly(row: ReturnType<typeof evaluateGate5CIsrcMbid>) {
  assert.equal(row.reviewOnly, true);
  assert.equal(row.recordingIdentityWrites, false);
  assert.equal(row.productiveCooldownEligible, false);
}

test("Gate 5D.7: Atomship spacing alias is symmetric and only REVIEW", () => {
  for (const [providerTitle, recordingTitle] of [
    ["Dragon Fly", "Dragonfly"],
    ["Dragonfly", "Dragon Fly"],
  ]) {
    const row = compareAtomship({ title: providerTitle }, { title: recordingTitle });
    assert.equal(row.decision, "REVIEW_TEXTUAL_ALIAS");
    assert.equal(row.durationDeltaMs, 0);
    assert.deepEqual(row.mbids, [ATOMSHIP_RECORDING.id]);
    assertReviewOnly(row);
  }
  // Other canonical consumers must still see two different title signals.
  assert.notEqual(deriveBaseTitleSignal("Dragon Fly"), deriveBaseTitleSignal("Dragonfly"));
  assert.equal(compareAtomship({ title: "Dragonfly" }).decision, "REVIEW_SINGLE_MBID");
  const remasterAlias = compareAtomship({ title: "Dragon Fly - Remastered" });
  assert.equal(remasterAlias.decision, "REVIEW_TEXTUAL_ALIAS");
  assertReviewOnly(remasterAlias);
});

test("Gate 5D.7: spacing alias cannot bypass artist, title or version conflicts", () => {
  const cases: Array<[Partial<Gate5CProviderTrack>, Partial<Gate5CMusicBrainzRecording>, string]> = [
    [{ artistName: "Cover Artist" }, {}, "ABSTAIN_ARTIST_MISMATCH"],
    [{ artistName: "Atom ship" }, {}, "ABSTAIN_ARTIST_MISMATCH"],
    [{ artistName: "" }, {}, "ABSTAIN_ARTIST_MISMATCH"],
    [{}, { artistNames: [] }, "ABSTAIN_ARTIST_MISMATCH"],
    [{ title: "Dragon Flight" }, {}, "ABSTAIN_TITLE_MISMATCH"],
    [{ title: "Dragon-Fly" }, {}, "ABSTAIN_TITLE_MISMATCH"],
    [{ title: "" }, {}, "ABSTAIN_TITLE_MISMATCH"],
    [{}, { title: "" }, "ABSTAIN_TITLE_MISMATCH"],
    ...["Live", "Acoustic", "Remix", "Demo"].map((version): typeof cases[number] => [
      { title: `Dragon Fly - ${version}` }, {}, "ABSTAIN_VERSION_CONFLICT",
    ]),
  ];
  for (const [spotify, recording, decision] of cases) {
    const row = compareAtomship(spotify, recording);
    assert.equal(row.decision, decision);
    assertReviewOnly(row);
  }
});

test("Gate 5D.7: spacing alias still requires duration, valid IDs and no relinking", () => {
  for (const durationMs of [null, 0, NaN, Infinity]) {
    const row = compareAtomship({}, { durationMs });
    assert.equal(row.decision, "ABSTAIN_DURATION_MISSING");
    assertReviewOnly(row);
  }
  for (const durationMs of [0, NaN, Infinity]) {
    assert.equal(compareAtomship({ durationMs }).decision, "ABSTAIN_DURATION_MISSING");
  }
  assert.equal(compareAtomship({}, { durationMs: 266920 }).decision, "REVIEW_TEXTUAL_ALIAS");
  const durationMismatch = compareAtomship({}, { durationMs: 266921 });
  assert.equal(durationMismatch.decision, "ABSTAIN_DURATION_MISMATCH");
  assert.equal(durationMismatch.durationDeltaMs, 5001);
  assertReviewOnly(durationMismatch);
  assert.equal(compareAtomship({ isrc: null }).decision, "ABSTAIN_INVALID_ISRC");
  assert.equal(compareAtomship({ linkedFromTrackId: "original" }).decision, "ABSTAIN_RELINKED_TRACK");
  assert.equal(compareAtomship({}, { id: "invalid" }).decision, "ABSTAIN_INVALID_MUSICBRAINZ_MBID");
  const multiple = evaluateGate5CIsrcMbid({
    spotify: ATOMSHIP,
    lookup: { kind: "FOUND", recordings: [ATOMSHIP_RECORDING, { ...ATOMSHIP_RECORDING, id: MBID2 }] },
  });
  assert.equal(multiple.decision, "ABSTAIN_MULTIPLE_MBIDS");
  assertReviewOnly(multiple);
});

test("Gate 5D.7: Flyleaf curly apostrophe remains REVIEW; historical Last.fm MBID is not linked", () => {
  const candidateMbid = "93c8180f-f4f4-4a73-b73c-5d028ed9b80b";
  const historicalMbid = "06ead44b-a0d6-4db0-8fc5-54ffa31f45c2";
  const row = evaluateGate5CIsrcMbid({
    spotify: {
      title: "I'm So Sick", artistName: "Flyleaf", durationMs: 176160,
      isrc: "USOCT0500070", linkedFromTrackId: null,
    },
    lookup: { kind: "FOUND", recordings: [{
      id: candidateMbid, title: "I’m So Sick", artistNames: ["Flyleaf"], durationMs: 176160,
    }] },
  });
  assert.equal(row.decision, "REVIEW_SINGLE_MBID");
  assertReviewOnly(row);
  const linkage = compareGate5BMbidEvidence({
    candidate: {
      providerTrackId: "flyleaf-fixture", recordingIdentityId: "flyleaf-recording",
      title: "I'm So Sick", artistName: "Flyleaf", providerTrackMbid: candidateMbid,
    },
    scrobbles: [{ trackName: "I'm So Sick", artistName: "Flyleaf", trackMbid: historicalMbid }],
    mbidOwners: [{ recordingIdentityId: "flyleaf-recording", trackMbid: candidateMbid }],
  });
  assert.equal(linkage.decision, "ABSTAIN_NO_SCROBBLE_MBID_MATCH");
  assert.equal(linkage.matchedScrobbleCount, 0);
  assert.equal(linkage.inferredRecordingEquivalence, false);
  assert.equal(linkage.eligibleForProductiveCooldown, false);
});

test("Gate 5D.7: Metallica original/remaster retains its separate REVIEW category", () => {
  // Gate 5D.4 recorded the 774 ms delta, not the absolute durations.
  // Absolute durations below are synthetic; do not present them as provider evidence.
  const row = evaluateGate5CIsrcMbid({
    spotify: {
      title: "Ride The Lightning - Remastered", artistName: "Metallica", durationMs: 400000,
      isrc: "QMKHM1600095", linkedFromTrackId: null,
    },
    lookup: { kind: "FOUND", recordings: [{
      id: "19bc7363-eb0a-450d-ab1d-1f3082072e0a",
      title: "Ride the Lightning", artistNames: ["Metallica"], durationMs: 400774,
    }] },
  });
  assert.equal(row.decision, "REVIEW_STANDARD_REMASTER");
  assert.equal(row.durationDeltaMs, 774);
  assertReviewOnly(row);
});
