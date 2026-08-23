import assert from "node:assert/strict";
import test from "node:test";

import {
  measureDiscoveryConversion,
  type DiscoveryExposure,
  type DiscoveryListeningEventLike,
} from "./conversion";

const EXPOSED = new Date("2026-06-01T12:00:00.000Z");
const AS_OF = new Date("2026-08-01T12:00:00.000Z");

function exposure(input: {
  trackId: string;
  title: string;
  artist: string;
  pathLabel: string | null;
  historyClass: string | null;
}): DiscoveryExposure {
  return {
    runId: `run-${input.trackId}`,
    exposedAt: EXPOSED,
    targetPlaylistId: "target-1",
    targetName: "Trabalho",
    discoveryUri: `spotify:track:${input.trackId}`,
    spotifyTrackId: input.trackId,
    discoveryTitle: input.title,
    discoveryArtist: input.artist,
    candidateKey: `candidate-${input.trackId}`,
    historyClass: input.historyClass,
    pathLabel: input.pathLabel,
    resolutionReason: "EXACT",
    isrc: null,
    adjustedScore: 70,
  };
}

function played(trackId: string, title: string, artist: string): DiscoveryListeningEventLike {
  return {
    spotifyTrackId: trackId,
    spotifyUri: `spotify:track:${trackId}`,
    trackName: title,
    artistName: artist,
    isrc: null,
    playedAt: new Date("2026-06-02T12:00:00.000Z"),
    source: "SPOTIFY_RECENTLY_PLAYED",
  };
}

test("reports non-exclusive conversion breakdown by persisted discovery provenance", () => {
  const exposures = [
    exposure({
      trackId: "track-a",
      title: "A",
      artist: "Artist A",
      pathLabel: "LASTFM_SIMILAR_TRACK",
      historyClass: "NEW_TRACK_KNOWN_ARTIST",
    }),
    exposure({
      trackId: "track-b",
      title: "B",
      artist: "Artist B",
      pathLabel: "LASTFM_SIMILAR_ARTIST",
      historyClass: "NEW_ARTIST",
    }),
    exposure({
      trackId: "track-c",
      title: "C",
      artist: "Artist C",
      pathLabel: null,
      historyClass: null,
    }),
  ];

  const report = measureDiscoveryConversion({
    exposures,
    listeningEvents: [played("track-a", "A", "Artist A")],
    asOf: AS_OF,
  });

  assert.equal(report.provenanceCoverageCount, 2);
  assert.equal(report.provenanceCoverageRate, 0.6667);

  const similarTrack = report.byPathLabel.find(
    (row) => row.key === "LASTFM_SIMILAR_TRACK",
  );
  assert.equal(similarTrack?.candidateCount, 1);
  assert.equal(similarTrack?.playedCount, 1);
  assert.equal(similarTrack?.playedRate, 1);

  const similarArtist = report.byPathLabel.find(
    (row) => row.key === "LASTFM_SIMILAR_ARTIST",
  );
  assert.equal(similarArtist?.candidateCount, 1);
  assert.equal(similarArtist?.playedCount, 0);

  const legacyUnknown = report.byPathLabel.find(
    (row) => row.key === "UNKNOWN_PROVENANCE",
  );
  assert.equal(legacyUnknown?.candidateCount, 1);

  const newArtist = report.byHistoryClass.find((row) => row.key === "NEW_ARTIST");
  assert.equal(newArtist?.candidateCount, 1);
  assert.equal(newArtist?.neverPlayedCount, 1);
});
