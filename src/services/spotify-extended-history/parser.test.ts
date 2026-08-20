import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSpotifyExtendedHistoryPackage } from "./parser";

test("HISTORY-02 parses Spotify ZIP, separates domains and deduplicates music", async () => {
  const music = {
    ts: "2026-08-18T20:00:26Z",
    ms_played: 180000,
    master_metadata_track_name: "Song",
    master_metadata_album_artist_name: "Artist",
    master_metadata_album_album_name: "Album",
    spotify_track_uri: "spotify:track:abc123",
    episode_name: null,
    episode_show_name: null,
    spotify_episode_uri: null,
    reason_start: "trackdone",
    reason_end: "endplay",
    skipped: false,
    offline: false,
    offline_timestamp: null,
    incognito_mode: false,
  };
  const skippedMusic = {
    ...music,
    ts: "2026-08-18T20:04:00Z",
    ms_played: 32000,
    spotify_track_uri: "spotify:track:def456",
    master_metadata_track_name: "Skipped Song",
    reason_end: "fwdbtn",
    skipped: true,
  };
  const invalidMusic = { ...music, ts: "not-a-date", spotify_track_uri: "spotify:track:bad" };
  const podcast = {
    ts: "2026-08-18T21:00:00Z",
    ms_played: 60000,
    spotify_track_uri: null,
    spotify_episode_uri: "spotify:episode:pod123",
    episode_name: "Episode",
    episode_show_name: "Show",
  };

  const archive = makeStoredZip([
    {
      name: "Spotify Extended Streaming History/Streaming_History_Audio_2026.json",
      content: JSON.stringify([music, music, skippedMusic, invalidMusic, podcast]),
    },
    {
      name: "Spotify Extended Streaming History/Streaming_History_Video_2026.json",
      content: JSON.stringify([{ ts: "2026-08-18T22:00:00Z" }]),
    },
  ]);

  const path = join(tmpdir(), `spotify-history-${process.pid}-${Date.now()}.zip`);
  await writeFile(path, archive);
  try {
    const parsed = await readSpotifyExtendedHistoryPackage(path);
    assert.equal(parsed.audioFileCount, 1);
    assert.equal(parsed.videoFileCount, 1);
    assert.equal(parsed.audioRecordCount, 5);
    assert.equal(parsed.videoRecordCount, 1);
    assert.equal(parsed.musicRecordCount, 4);
    assert.equal(parsed.uniqueMusicEventCount, 2);
    assert.equal(parsed.duplicateMusicGroupCount, 1);
    assert.equal(parsed.duplicateMusicOccurrenceCount, 1);
    assert.equal(parsed.podcastRecordCount, 1);
    assert.equal(parsed.invalidMusicRecords.length, 1);
    assert.equal(parsed.musicEvents[0]?.spotifyTrackId, "abc123");
    assert.equal(parsed.musicEvents[0]?.estimatedStartedAt.toISOString(), "2026-08-18T19:57:26.000Z");
    assert.equal(parsed.musicEvents[1]?.skipped, true);
    assert.equal(
      parsed.musicEvents[0]?.sourceEventKey,
      "4e29d7946052d7aaf3708ff8c769054a147cb66e5689edc0a6b7a24afd44751e",
      "URI-backed sourceEventKey must remain byte-for-byte compatible with HISTORY-02 v1",
    );
  } finally {
    await rm(path, { force: true });
  }
});

test("HISTORY-02 keeps metadata-complete music without URI and gives it stable distinct identity", async () => {
  const noUriMusic = {
    ts: "2026-08-18T20:00:26Z",
    ms_played: 180000,
    master_metadata_track_name: "URI-less Song",
    master_metadata_album_artist_name: "URI-less Artist",
    master_metadata_album_album_name: "URI-less Album",
    spotify_track_uri: null,
    spotify_episode_uri: null,
    audiobook_uri: null,
    reason_start: "trackdone",
    reason_end: "endplay",
    skipped: false,
    offline: false,
    offline_timestamp: null,
    incognito_mode: false,
  };
  const differentTrackSamePlaybackShape = {
    ...noUriMusic,
    master_metadata_track_name: "Different URI-less Song",
  };
  const malformedUri = {
    ...noUriMusic,
    spotify_track_uri: "spotify:album:not-a-track",
  };
  const incompleteMusicMetadata = {
    ...noUriMusic,
    master_metadata_album_album_name: null,
  };
  const podcastWithStaleMasterMetadata = {
    ...noUriMusic,
    spotify_episode_uri: "spotify:episode:episode123",
    episode_name: "Episode",
    episode_show_name: "Show",
  };

  const archive = makeStoredZip([
    {
      name: "Spotify Extended Streaming History/Streaming_History_Audio_2026.json",
      content: JSON.stringify([
        noUriMusic,
        noUriMusic,
        differentTrackSamePlaybackShape,
        malformedUri,
        incompleteMusicMetadata,
        podcastWithStaleMasterMetadata,
      ]),
    },
  ]);

  const path = join(tmpdir(), `spotify-history-no-uri-${process.pid}-${Date.now()}.zip`);
  await writeFile(path, archive);
  try {
    const parsed = await readSpotifyExtendedHistoryPackage(path);

    assert.equal(parsed.audioRecordCount, 6);
    assert.equal(parsed.musicRecordCount, 5);
    assert.equal(parsed.podcastRecordCount, 1);
    assert.equal(parsed.otherAudioRecordCount, 0);
    assert.equal(parsed.invalidMusicRecords.length, 2);
    assert.deepEqual(
      parsed.invalidMusicRecords.map((row) => row.reason).sort(),
      ["invalid spotify_track_uri", "missing album name"],
    );

    assert.equal(parsed.uniqueMusicEventCount, 2);
    assert.equal(parsed.duplicateMusicGroupCount, 1);
    assert.equal(parsed.duplicateMusicOccurrenceCount, 1);

    const first = parsed.musicEvents[0];
    const second = parsed.musicEvents[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.spotifyTrackUri, null);
    assert.equal(first.spotifyTrackId, null);
    assert.equal(first.sourceEventKey.length, 64);
    assert.equal(second.sourceEventKey.length, 64);
    assert.notEqual(
      first.sourceEventKey,
      second.sourceEventKey,
      "different URI-less track metadata must not collapse into one source event",
    );
  } finally {
    await rm(path, { force: true });
  }
});

function makeStoredZip(entries: { name: string; content: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localFiles = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localFiles.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localFiles, centralDirectory, eocd]);
}
