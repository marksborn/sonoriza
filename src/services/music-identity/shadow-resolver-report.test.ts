import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMusicIdentityShadowResolverReport,
  classifyShadowResolverVersion,
  deriveBaseAlbumTitleSignal,
  deriveBaseTitleSignal,
  type ShadowResolverTrackRow,
} from "./shadow-resolver-report";

function row(overrides: Partial<ShadowResolverTrackRow> = {}): ShadowResolverTrackRow {
  return {
    provider: "spotify",
    providerScope: "global",
    providerTrackId: "track-a",
    recordingIdentityId: "recording-a",
    songIdentityId: "song-a",
    primaryArtistIdentityId: "artist-identity-a",
    primaryArtistProviderId: "artist-a",
    primaryArtistName: "Artist A",
    trackName: "Song",
    albumProviderId: "album-a",
    albumName: "Album",
    durationMs: 180_000,
    isrc: null,
    trackMbid: null,
    sourcePlaylistIds: ["source-a"],
    ...overrides,
  };
}

test("base-title signal strips explicit version qualifiers but preserves lexical titles", () => {
  assert.equal(deriveBaseTitleSignal("Song - Live at Wembley"), "song");
  assert.equal(deriveBaseTitleSignal("Song (2011 Remaster)"), "song");
  assert.equal(deriveBaseTitleSignal("Song [Acoustic Version]"), "song");
  assert.equal(deriveBaseTitleSignal("Live Forever"), "live forever");
  assert.equal(deriveBaseTitleSignal("Live Through This"), "live through this");
});

test("version traits reuse conservative live classification and only use explicit qualifiers", () => {
  assert.equal(
    classifyShadowResolverVersion({ trackName: "Live Forever", albumName: "Definitely Maybe" }),
    "STANDARD",
  );
  assert.equal(
    classifyShadowResolverVersion({ trackName: "Song - Live at Wembley", albumName: "Album" }),
    "LIVE",
  );
  assert.equal(
    classifyShadowResolverVersion({ trackName: "Song (Acoustic Version)", albumName: "Album" }),
    "ACOUSTIC",
  );
  assert.equal(
    classifyShadowResolverVersion({ trackName: "Song - Club Remix", albumName: "Album" }),
    "REMIX",
  );
  assert.equal(
    classifyShadowResolverVersion({ trackName: "Song", albumName: "Album - 2011 Remastered" }),
    "REMASTER",
  );
});

test("same canonical recording is reported as an exact provider alias without mutation", () => {
  const report = buildMusicIdentityShadowResolverReport(
    [
      row(),
      row({
        providerTrackId: "track-b",
        recordingIdentityId: "recording-a",
        sourcePlaylistIds: [],
      }),
    ],
    { userId: "user-a" },
  );

  assert.equal(report.evidence.exactAliasGroups, 1);
  assert.equal(report.resolution.exactProviderAliasPairs, 1);
  assert.deepEqual(report.resolution.pairs[0]?.resolution, {
    status: "MATCH",
    reason: "EXACT_PROVIDER_ALIAS",
    level: "RECORDING",
    action: "ALREADY_LINKED",
    confidenceBasisPoints: 10_000,
  });
  assert.equal(report.safety.identityMutation, false);
});

test("same ISRC + same artist/base title is a high-confidence recording candidate", () => {
  const report = buildMusicIdentityShadowResolverReport(
    [
      row({ isrc: "BR-ABC-26-00001" }),
      row({
        providerTrackId: "track-b",
        recordingIdentityId: "recording-b",
        songIdentityId: "song-b",
        trackName: "Song (2011 Remaster)",
        albumName: "Album (2011 Remaster)",
        durationMs: 181_000,
        isrc: "BRABC2600001",
      }),
    ],
    { userId: "user-a" },
  );

  assert.equal(report.evidence.sameIsrcGroups, 1);
  assert.equal(report.resolution.sameRecordingHighConfidencePairs, 1);
  const pair = report.resolution.pairs[0]!;
  assert.equal(pair.resolution.status, "MATCH");
  assert.equal(pair.resolution.reason, "SAME_ISRC");
  assert.equal(pair.resolution.level, "RECORDING");
  assert.equal(pair.resolution.action, "REVIEW_RECORDING_MERGE");
  assert.equal(pair.evidence.rightVersionTrait, "REMASTER");
});

test("strong identifier conflicts fail closed instead of forcing a merge", () => {
  const report = buildMusicIdentityShadowResolverReport(
    [
      row({ isrc: "BRABC2600001" }),
      row({
        providerTrackId: "track-b",
        recordingIdentityId: "recording-b",
        songIdentityId: "song-b",
        primaryArtistIdentityId: "artist-identity-b",
        primaryArtistProviderId: "artist-b",
        primaryArtistName: "Artist B",
        trackName: "Different Song",
        isrc: "BRABC2600001",
      }),
    ],
    { userId: "user-a" },
  );

  const pair = report.resolution.pairs[0]!;
  assert.equal(pair.resolution.status, "AMBIGUOUS");
  assert.equal(pair.resolution.reason, "AMBIGUOUS");
  assert.equal(pair.resolution.action, "REVIEW_ONLY");
});

test("studio and live variants with same artist/base title remain separate recordings", () => {
  const report = buildMusicIdentityShadowResolverReport(
    [
      row({ trackName: "Song" }),
      row({
        providerTrackId: "track-live",
        recordingIdentityId: "recording-live",
        songIdentityId: "song-live",
        trackName: "Song - Live at Wembley",
        albumProviderId: "album-live",
        albumName: "Live at Wembley",
        durationMs: 240_000,
      }),
    ],
    { userId: "user-a" },
  );

  const pair = report.resolution.pairs[0]!;
  assert.equal(pair.resolution.status, "MATCH");
  assert.equal(pair.resolution.reason, "SAME_SONG_DIFFERENT_RECORDING");
  assert.equal(pair.resolution.level, "SONG_ONLY");
  assert.equal(pair.resolution.action, "KEEP_RECORDINGS_SEPARATE");
  assert.equal(report.resolution.liveVsStudioPairs, 1);
});

test("remaster without strong identifier remains a textual review candidate", () => {
  const report = buildMusicIdentityShadowResolverReport(
    [
      row({ trackName: "Song" }),
      row({
        providerTrackId: "track-remaster",
        recordingIdentityId: "recording-remaster",
        songIdentityId: "song-remaster",
        trackName: "Song - 2011 Remaster",
        albumProviderId: "album-remaster",
        albumName: "Album - 2011 Remaster",
        durationMs: 181_000,
      }),
    ],
    { userId: "user-a" },
  );

  const pair = report.resolution.pairs[0]!;
  assert.equal(pair.resolution.status, "AMBIGUOUS");
  assert.equal(pair.resolution.reason, "TEXTUAL_POSSIBLE_MATCH");
  assert.equal(pair.resolution.confidenceBasisPoints, 7_500);
  assert.equal(report.resolution.remasterPairs, 1);
});

test("same title across different artists is a cover/text collision guard, never a textual merge pair", () => {
  const report = buildMusicIdentityShadowResolverReport(
    [
      row({ providerTrackId: "artist-a-track", trackName: "Hallelujah" }),
      row({
        providerTrackId: "artist-b-track",
        recordingIdentityId: "recording-b",
        songIdentityId: "song-b",
        primaryArtistIdentityId: "artist-identity-b",
        primaryArtistProviderId: "artist-b",
        primaryArtistName: "Artist B",
        trackName: "Hallelujah",
      }),
    ],
    { userId: "user-a" },
  );

  assert.equal(report.evidence.crossArtistTitleCollisionGroups, 1);
  assert.equal(report.resolution.pairCount, 0);
  assert.equal(report.guards.crossArtistTitleCollisions[0]?.distinctArtistProviderIds, 2);
});

test("album edition signal groups distinct releases without declaring equivalence", () => {
  assert.equal(deriveBaseAlbumTitleSignal("Album (Deluxe Edition)"), "album");
  assert.equal(deriveBaseAlbumTitleSignal("Album - 2011 Remastered"), "album");

  const report = buildMusicIdentityShadowResolverReport(
    [
      row({ albumProviderId: "album-standard", albumName: "Album" }),
      row({
        providerTrackId: "track-deluxe",
        recordingIdentityId: "recording-deluxe",
        songIdentityId: "song-deluxe",
        trackName: "Other Song",
        albumProviderId: "album-deluxe",
        albumName: "Album (Deluxe Edition)",
      }),
    ],
    { userId: "user-a" },
  );

  assert.equal(report.evidence.albumEditionGroups, 1);
  assert.equal(report.guards.albumEditionCandidates[0]?.albumCount, 2);
  assert.deepEqual(
    new Set(report.guards.albumEditionCandidates[0]?.albums.map((album) => album.editionTrait)),
    new Set(["STANDARD_OR_OTHER_RELEASE", "DELUXE"]),
  );
});

test("incomplete cache authority is explicitly reported as a lower bound", () => {
  const report = buildMusicIdentityShadowResolverReport([row()], {
    userId: "user-a",
    fullValidSources: 1,
    partialValidSources: 1,
  });
  assert.equal(report.authority.interpretation, "LOWER_BOUND_PERSISTED_SNAPSHOT");
  assert.equal(report.authority.liveProviderSnapshotVerified, false);
  assert.equal(report.authority.providerCalls, false);
  assert.equal(report.authority.writes, false);
});
