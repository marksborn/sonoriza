import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTrackVersionShadowReport,
  classifyTrackVersion,
} from "./track-version-preference";

test("Live Forever is not classified as a live recording by lexical title alone", () => {
  assert.deepEqual(
    classifyTrackVersion({
      trackName: "Live Forever",
      albumName: "Definitely Maybe",
    }),
    {
      classification: "STUDIO_OR_STANDARD",
      reason: "NO_LIVE_MARKER",
      source: null,
      matchedText: null,
    },
  );
});

test("classifies explicit live suffixes in track names", () => {
  const result = classifyTrackVersion({
    trackName: "Suicide Snowman - Live: Tampa Bay, FL 26 Apr '92",
    albumName: "The Spooky Kids Sessions",
  });

  assert.equal(result.classification, "LIVE");
  assert.equal(result.reason, "TRACK_LIVE_SUFFIX");
  assert.equal(result.source, "TRACK_NAME");
});

test("classifies parenthesized live-at qualifiers", () => {
  const result = classifyTrackVersion({
    trackName: "Song (Live at Wembley)",
    albumName: "Song",
  });

  assert.equal(result.classification, "LIVE");
  assert.equal(result.source, "TRACK_NAME");
});

test("classifies Portuguese and Spanish live qualifiers", () => {
  assert.equal(
    classifyTrackVersion({ trackName: "Canção - Ao Vivo" }).classification,
    "LIVE",
  );
  assert.equal(
    classifyTrackVersion({ trackName: "Canción [En Vivo]" }).classification,
    "LIVE",
  );
});

test("uses album metadata as secondary live evidence", () => {
  const liveAt = classifyTrackVersion({
    trackName: "Song",
    albumName: "Live at Wembley",
  });
  assert.equal(liveAt.classification, "LIVE");
  assert.equal(liveAt.reason, "ALBUM_LIVE_CONTEXT");
  assert.equal(liveAt.source, "ALBUM_NAME");

  const concert = classifyTrackVersion({
    trackName: "Song",
    albumName: "In Concert",
  });
  assert.equal(concert.classification, "LIVE");
  assert.equal(concert.reason, "ALBUM_IN_CONCERT_CONTEXT");
});

test("does not treat studio album titles beginning with Live as live without context", () => {
  const result = classifyTrackVersion({
    trackName: "Violet",
    albumName: "Live Through This",
  });
  assert.equal(result.classification, "STUDIO_OR_STANDARD");
});

test("returns unknown only when version metadata is absent", () => {
  assert.equal(
    classifyTrackVersion({ trackName: "", albumName: null }).classification,
    "UNKNOWN",
  );
});

test("shadow report measures live prevalence without planner or write influence", () => {
  const report = buildTrackVersionShadowReport([
    {
      spotifyTrackId: "studio-1",
      artistName: "Oasis",
      trackName: "Live Forever",
      albumName: "Definitely Maybe",
      rawScore: 98,
    },
    {
      spotifyTrackId: "live-1",
      artistName: "Example",
      trackName: "Song - Live",
      albumName: "Concert",
      rawScore: 95,
    },
  ]);

  assert.equal(report.totals.candidates, 2);
  assert.equal(report.totals.live, 1);
  assert.equal(report.totals.studioOrStandard, 1);
  assert.equal(report.totals.unknown, 0);
  assert.equal(report.totals.liveShare, 0.5);
  assert.deepEqual(report.safety, {
    shadowOnly: true,
    plannerInfluence: false,
    databaseWrites: false,
    spotifyWrites: false,
  });
});
