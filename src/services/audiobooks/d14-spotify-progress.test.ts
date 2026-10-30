import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AudiobookChapterResponse } from "@/services/spotify/client";

import { audiobookProgressSyncEnabled, inferCurrentChapter } from "./d14-spotify-progress";

const chapter = (
  name: string,
  duration_ms: number,
  fully_played: boolean,
  resume_position_ms = 0,
): AudiobookChapterResponse => ({ name, duration_ms, resume_point: { fully_played, resume_position_ms } });

// Shape observed for 1984 on 30/10/2026 (first chapters).
const BOOK_1984 = [
  chapter("Apresentação", 20_039, true),
  chapter("Parte I", 5_757, true),
  chapter("Capítulo 1", 2_810_255, false, 164_748),
  chapter("Capítulo 2", 1_318_494, false),
];

test("current chapter = first not fully played, labeled by book position", () => {
  assert.deepEqual(inferCurrentChapter(BOOK_1984), {
    chapterLabel: "3. Capítulo 1",
    chapterDurationMs: 2_810_255,
    consumedMs: 164_748,
  });
});

test("not inferable without resume_point or when the whole book was played", () => {
  assert.equal(inferCurrentChapter([{ name: "Capítulo 1", duration_ms: 1000 }]), null);
  assert.equal(inferCurrentChapter([chapter("A", 1000, true), chapter("B", 1000, true)]), null);
  assert.equal(inferCurrentChapter([]), null);
});

test("progress is clamped below the chapter duration (DB constraint)", () => {
  const inferred = inferCurrentChapter([chapter("A", 60_000, false, 90_000)]);
  assert.equal(inferred?.consumedMs, 59_999);
});

test("sync is opt-in and runs before the budget is read in generation", () => {
  assert.equal(audiobookProgressSyncEnabled({}), false);
  assert.equal(audiobookProgressSyncEnabled({ AUDIOBOOK02_SPOTIFY_PROGRESS_SYNC: "ACTIVE" }), true);
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const sync = source.indexOf("syncActiveReadingFromSpotify({");
  const read = source.indexOf("prisma.userAudiobookLibraryTarget.findMany({");
  assert.ok(sync > 0 && read > sync);
});

test("migration accepts only the two provenances", () => {
  const sql = readFileSync(
    "prisma/migrations/20261030140000_audiobook_d14_spotify_progress/migration.sql",
    "utf8",
  );
  assert.equal(sql.match(/IN \('USER_DECLARED_UNVERIFIED', 'SPOTIFY_RESUME_POINT'\)/g)?.length, 2);
});

const dbTest = process.env.DATABASE_URL ? test : test.skip;
dbTest("#489 D.14: Spotify progress is a CAS revision; manual edit and COMPLETE still work",
  { concurrency: false }, async (t) => {
    const { randomUUID } = await import("node:crypto");
    const { prisma } = await import("@/lib/prisma");
    const {
      LIBRARY_ATTACH_CONFIRMATION, LIBRARY_COMPLETE_CONFIRMATION,
      LIBRARY_START_CONFIRMATION, LIBRARY_UPDATE_CONFIRMATION, parseLibraryCommand,
    } = await import("./d12-library-contract");
    const { mutateMultiPlaylistLibrary, readMultiPlaylistLibrary } = await import("./d12-library-store");
    const { syncActiveReadingFromSpotify } = await import("./d14-spotify-progress");
    const parse = (raw: unknown) => {
      const result = parseLibraryCommand(raw);
      if (!result.ok) throw new Error("invalid fixture command");
      return result.value;
    };

    const suffix = randomUUID().replaceAll("-", "");
    const owner = await prisma.user.create({ data: { email: `d14-${suffix}@example.test` } });
    t.after(async () => {
      await prisma.user.delete({ where: { id: owner.id } });
    });
    const target = await prisma.targetPlaylist.create({
      data: {
        userId: owner.id, name: "Trabalho",
        spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
        durationMode: "FIXED", fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC", "PODCAST"], updatePolicy: "REBUILD_DAILY",
      },
    });
    await mutateMultiPlaylistLibrary(owner.id, parse({
      action: "START", bookTitle: "1984",
      spotifyShowUrl: "https://open.spotify.com/show/5E76EUAq7or1ncd4QNyHjI",
      chapterLabel: "Apresentação", chapterDurationMs: 20039, consumedMs: 0,
      confirmation: LIBRARY_START_CONFIRMATION,
    }));
    await mutateMultiPlaylistLibrary(owner.id, parse({
      action: "ATTACH", targetPlaylistId: target.id, expectedRevision: 1,
      confirmation: LIBRARY_ATTACH_CONFIRMATION,
    }));

    const unrelated = await syncActiveReadingFromSpotify({
      userId: owner.id, spotifyPlaylistIds: ["1tsFauBmlMXWJLNKTCQFQE"],
      readChapters: async () => BOOK_1984,
    });
    assert.equal(unrelated.status, "NO_ACTIVE_READING");

    const synced = await syncActiveReadingFromSpotify({
      userId: owner.id, spotifyPlaylistIds: ["4kYizEAtQhFsrrwD3tFphP"],
      readChapters: async () => BOOK_1984,
    });
    assert.equal(synced.status, "UPDATED");
    let state = await readMultiPlaylistLibrary(owner.id);
    assert.equal(state.current?.chapterLabel, "3. Capítulo 1");
    assert.equal(state.current?.consumedMs, 164_748);
    assert.equal(state.current?.evidenceSource, "SPOTIFY_RESUME_POINT");
    assert.equal(state.current?.revision, 2);

    const again = await syncActiveReadingFromSpotify({
      userId: owner.id, spotifyPlaylistIds: ["4kYizEAtQhFsrrwD3tFphP"],
      readChapters: async () => BOOK_1984,
    });
    assert.equal(again.status, "UNCHANGED");

    const failing = await syncActiveReadingFromSpotify({
      userId: owner.id, spotifyPlaylistIds: ["4kYizEAtQhFsrrwD3tFphP"],
      readChapters: async () => { throw new Error("Spotify API GET failed (502)"); },
    });
    assert.equal(failing.status, "FAILED");

    await mutateMultiPlaylistLibrary(owner.id, parse({
      action: "UPDATE", expectedRevision: 2, chapterLabel: "Capítulo 2",
      chapterDurationMs: 1_318_494, consumedMs: 0, confirmation: LIBRARY_UPDATE_CONFIRMATION,
    }));
    state = await readMultiPlaylistLibrary(owner.id);
    assert.equal(state.current?.evidenceSource, "USER_DECLARED_UNVERIFIED");

    await mutateMultiPlaylistLibrary(owner.id, parse({
      action: "COMPLETE", expectedRevision: 3, confirmation: LIBRARY_COMPLETE_CONFIRMATION,
    }));
    assert.equal((await readMultiPlaylistLibrary(owner.id)).current, null);
  });
