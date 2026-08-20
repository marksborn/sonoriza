import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readZipEntries } from "./zip";

const AUDIO_FILE_RE = /(?:^|\/)Streaming_History_Audio_\d{4}\.json$/;
const VIDEO_FILE_RE = /(?:^|\/)Streaming_History_Video_\d{4}\.json$/;
const TRACK_URI_RE = /^spotify:track:([A-Za-z0-9]+)$/;

type RawRecord = Record<string, unknown>;

export type SpotifyExtendedMusicEvent = {
  sourceFile: string;
  sourceIndex: number;
  endedAt: Date;
  estimatedStartedAt: Date;
  msPlayed: number;
  spotifyTrackUri: string | null;
  spotifyTrackId: string | null;
  trackName: string;
  artistName: string;
  albumName: string;
  reasonStart: string | null;
  reasonEnd: string | null;
  skipped: boolean | null;
  offline: boolean | null;
  offlineTimestamp: number | null;
  incognitoMode: boolean | null;
  sourceEventKey: string;
};

export type InvalidSpotifyExtendedRecord = {
  sourceFile: string;
  sourceIndex: number;
  reason: string;
};

export type SpotifyExtendedHistoryPackage = {
  archiveSha256: string;
  archiveBytes: number;
  audioFileCount: number;
  videoFileCount: number;
  audioRecordCount: number;
  videoRecordCount: number;
  musicRecordCount: number;
  uniqueMusicEventCount: number;
  duplicateMusicOccurrenceCount: number;
  duplicateMusicGroupCount: number;
  podcastRecordCount: number;
  audiobookRecordCount: number;
  otherAudioRecordCount: number;
  invalidMusicRecords: InvalidSpotifyExtendedRecord[];
  earliestEndedAt: Date | null;
  latestEndedAt: Date | null;
  musicEvents: SpotifyExtendedMusicEvent[];
};

export async function readSpotifyExtendedHistoryPackage(
  filePath: string,
): Promise<SpotifyExtendedHistoryPackage> {
  const archive = await readFile(filePath);
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const entries = await readZipEntries(filePath);

  const audioEntries = entries
    .filter((entry) => AUDIO_FILE_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const videoEntries = entries
    .filter((entry) => VIDEO_FILE_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (audioEntries.length === 0) {
    throw new Error("No Streaming_History_Audio_YYYY.json files found in Spotify package");
  }

  const musicEvents: SpotifyExtendedMusicEvent[] = [];
  const invalidMusicRecords: InvalidSpotifyExtendedRecord[] = [];
  const occurrenceCounts = new Map<string, number>();

  let audioRecordCount = 0;
  let videoRecordCount = 0;
  let musicRecordCount = 0;
  let podcastRecordCount = 0;
  let audiobookRecordCount = 0;
  let otherAudioRecordCount = 0;
  let earliestEndedAtMs: number | null = null;
  let latestEndedAtMs: number | null = null;

  for (const entry of audioEntries) {
    const rows = parseJsonArray(entry.name, entry.data);
    audioRecordCount += rows.length;

    for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex += 1) {
      const row = rows[sourceIndex];
      if (!isRecord(row)) {
        otherAudioRecordCount += 1;
        continue;
      }

      const trackUri = nullableString(row.spotify_track_uri);
      const episodeUri = nullableString(row.spotify_episode_uri);
      const audiobookUri = nullableString(row.audiobook_uri) ?? nullableString(row.audiobook_chapter_uri);
      const hasTrackMetadata =
        nullableString(row.master_metadata_track_name) !== null
        || nullableString(row.master_metadata_album_artist_name) !== null
        || nullableString(row.master_metadata_album_album_name) !== null;

      if (trackUri) {
        musicRecordCount += 1;
        const parsed = parseMusicRecord(entry.name, sourceIndex, row);
        if ("reason" in parsed) {
          invalidMusicRecords.push(parsed);
          continue;
        }

        const endedAtMs = parsed.endedAt.getTime();
        if (earliestEndedAtMs === null || endedAtMs < earliestEndedAtMs) {
          earliestEndedAtMs = endedAtMs;
        }
        if (latestEndedAtMs === null || endedAtMs > latestEndedAtMs) {
          latestEndedAtMs = endedAtMs;
        }

        const seen = occurrenceCounts.get(parsed.sourceEventKey) ?? 0;
        occurrenceCounts.set(parsed.sourceEventKey, seen + 1);
        if (seen === 0) musicEvents.push(parsed);
        continue;
      }

      // Explicit podcast/audiobook identity wins when spotify_track_uri is absent.
      // This avoids treating episode metadata as music even if an export row also
      // contains stale master_metadata_* fields.
      if (episodeUri) {
        podcastRecordCount += 1;
        continue;
      }
      if (audiobookUri) {
        audiobookRecordCount += 1;
        continue;
      }

      // Spotify can emit music rows without spotify_track_uri (for example when
      // catalog identity is unavailable). Keep those rows only when music
      // metadata is present; parseMusicRecord will reject incomplete metadata.
      if (hasTrackMetadata) {
        musicRecordCount += 1;
        const parsed = parseMusicRecord(entry.name, sourceIndex, row);
        if ("reason" in parsed) {
          invalidMusicRecords.push(parsed);
          continue;
        }

        const endedAtMs = parsed.endedAt.getTime();
        if (earliestEndedAtMs === null || endedAtMs < earliestEndedAtMs) {
          earliestEndedAtMs = endedAtMs;
        }
        if (latestEndedAtMs === null || endedAtMs > latestEndedAtMs) {
          latestEndedAtMs = endedAtMs;
        }

        const seen = occurrenceCounts.get(parsed.sourceEventKey) ?? 0;
        occurrenceCounts.set(parsed.sourceEventKey, seen + 1);
        if (seen === 0) musicEvents.push(parsed);
        continue;
      }

      otherAudioRecordCount += 1;
    }
  }

  for (const entry of videoEntries) {
    videoRecordCount += parseJsonArray(entry.name, entry.data).length;
  }

  let duplicateMusicGroupCount = 0;
  let duplicateMusicOccurrenceCount = 0;
  for (const count of occurrenceCounts.values()) {
    if (count > 1) {
      duplicateMusicGroupCount += 1;
      duplicateMusicOccurrenceCount += count - 1;
    }
  }

  return {
    archiveSha256,
    archiveBytes: archive.length,
    audioFileCount: audioEntries.length,
    videoFileCount: videoEntries.length,
    audioRecordCount,
    videoRecordCount,
    musicRecordCount,
    uniqueMusicEventCount: musicEvents.length,
    duplicateMusicOccurrenceCount,
    duplicateMusicGroupCount,
    podcastRecordCount,
    audiobookRecordCount,
    otherAudioRecordCount,
    invalidMusicRecords,
    earliestEndedAt: earliestEndedAtMs === null ? null : new Date(earliestEndedAtMs),
    latestEndedAt: latestEndedAtMs === null ? null : new Date(latestEndedAtMs),
    musicEvents,
  };
}

function parseMusicRecord(
  sourceFile: string,
  sourceIndex: number,
  row: RawRecord,
): SpotifyExtendedMusicEvent | InvalidSpotifyExtendedRecord {
  const ts = nullableString(row.ts);
  const spotifyTrackUri = nullableString(row.spotify_track_uri);
  const trackName = nullableString(row.master_metadata_track_name);
  const artistName = nullableString(row.master_metadata_album_artist_name);
  const albumName = nullableString(row.master_metadata_album_album_name);
  const msPlayed = integerNumber(row.ms_played);

  if (!ts) return invalid(sourceFile, sourceIndex, "missing ts");
  const endedAt = new Date(ts);
  if (Number.isNaN(endedAt.getTime())) return invalid(sourceFile, sourceIndex, "invalid ts");

  let spotifyTrackId: string | null = null;
  if (spotifyTrackUri) {
    const uriMatch = TRACK_URI_RE.exec(spotifyTrackUri);
    if (!uriMatch?.[1]) return invalid(sourceFile, sourceIndex, "invalid spotify_track_uri");
    spotifyTrackId = uriMatch[1];
  }

  if (!trackName) return invalid(sourceFile, sourceIndex, "missing track name");
  if (!artistName) return invalid(sourceFile, sourceIndex, "missing artist name");
  if (!albumName) return invalid(sourceFile, sourceIndex, "missing album name");
  if (msPlayed === null || msPlayed < 0) return invalid(sourceFile, sourceIndex, "invalid ms_played");

  const skipped = nullableBoolean(row.skipped);
  const offline = nullableBoolean(row.offline);
  const incognitoMode = nullableBoolean(row.incognito_mode);
  const offlineTimestamp = integerNumber(row.offline_timestamp);
  const reasonStart = nullableString(row.reason_start);
  const reasonEnd = nullableString(row.reason_end);
  const estimatedStartedAt = new Date(endedAt.getTime() - msPlayed);
  const sourceEventKey = spotifyExtendedSourceEventKey({
    ts,
    spotifyTrackUri,
    trackName,
    artistName,
    albumName,
    msPlayed,
    reasonStart,
    reasonEnd,
    skipped,
    offline,
    offlineTimestamp,
    incognitoMode,
  });

  return {
    sourceFile,
    sourceIndex,
    endedAt,
    estimatedStartedAt,
    msPlayed,
    spotifyTrackUri,
    spotifyTrackId,
    trackName,
    artistName,
    albumName,
    reasonStart,
    reasonEnd,
    skipped,
    offline,
    offlineTimestamp,
    incognitoMode,
    sourceEventKey,
  };
}

export function spotifyExtendedSourceEventKey(input: {
  ts: string;
  spotifyTrackUri: string | null;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  msPlayed: number;
  reasonStart: string | null;
  reasonEnd: string | null;
  skipped: boolean | null;
  offline: boolean | null;
  offlineTimestamp: number | null;
  incognitoMode: boolean | null;
}): string {
  // Keep the historical v1 identity byte-for-byte compatible for rows that
  // have a Spotify URI. Existing imported sourceEventKey values must never be
  // invalidated by adding support for URI-less rows.
  if (input.spotifyTrackUri !== null) {
    const canonical = [
      "spotify-extended-history-v1",
      input.ts,
      input.spotifyTrackUri,
      String(input.msPlayed),
      input.reasonStart ?? "",
      input.reasonEnd ?? "",
      serializeNullableBoolean(input.skipped),
      serializeNullableBoolean(input.offline),
      input.offlineTimestamp === null ? "" : String(input.offlineTimestamp),
      serializeNullableBoolean(input.incognitoMode),
    ].join("\u0000");

    return createHash("sha256").update(canonical).digest("hex");
  }

  if (!input.trackName || !input.artistName || !input.albumName) {
    throw new Error("URI-less Spotify Extended music identity requires track, artist and album");
  }

  // URI-less rows need a separate identity namespace. Exact textual metadata is
  // part of the key so two different tracks at the same timestamp/msPlayed do
  // not collapse merely because Spotify omitted catalog identity.
  const canonical = [
    "spotify-extended-history-no-uri-v1",
    input.ts,
    input.artistName,
    input.trackName,
    input.albumName,
    String(input.msPlayed),
    input.reasonStart ?? "",
    input.reasonEnd ?? "",
    serializeNullableBoolean(input.skipped),
    serializeNullableBoolean(input.offline),
    input.offlineTimestamp === null ? "" : String(input.offlineTimestamp),
    serializeNullableBoolean(input.incognitoMode),
  ].join("\u0000");

  return createHash("sha256").update(canonical).digest("hex");
}

function parseJsonArray(name: string, data: Buffer): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array in ${name}`);
  return parsed;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function integerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function invalid(sourceFile: string, sourceIndex: number, reason: string): InvalidSpotifyExtendedRecord {
  return { sourceFile, sourceIndex, reason };
}

function serializeNullableBoolean(value: boolean | null): string {
  return value === null ? "" : value ? "1" : "0";
}
