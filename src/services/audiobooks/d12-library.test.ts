import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { prismaAudiobookWriteFenceStore } from "./write-admission-store";
import {
  audiobookMultiTargetEnabled,
  LIBRARY_START_CONFIRMATION, LIBRARY_ATTACH_CONFIRMATION,
  LIBRARY_UPDATE_CONFIRMATION, LIBRARY_COMPLETE_CONFIRMATION,
  parseLibraryCommand, projectLibraryChapterBudget,
} from "./d12-library-contract";
import { mutateMultiPlaylistLibrary, readMultiPlaylistLibrary } from "./d12-library-store";

const flags = {
  AUDIOBOOK02_BIND_UI_MODE: "PREVIEW",
  AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE: "PREVIEW",
  AUDIOBOOK02_MANUAL_NOTEBOOK_MODE: "ACTIVE",
  AUDIOBOOK02_WRITE_FENCE_MODE: "ACTIVE",
  AUDIOBOOK02_SINGLE_READING_MODE: "ACTIVE",
  AUDIOBOOK02_MULTI_TARGET_MODE: "ACTIVE",
};
const valid = {
  action: "START" as const,
  bookTitle: "1984",
  spotifyShowUrl: "https://open.spotify.com/show/5E76EUAq7or1ncd4QNyHjI",
  chapterLabel: "Apresentação",
  chapterDurationMs: 20039, consumedMs: 0,
  confirmation: LIBRARY_START_CONFIRMATION,
};
const attach = (targetPlaylistId: string, expectedRevision = 1) => ({
  action: "ATTACH" as const,
  targetPlaylistId, expectedRevision,
  confirmation: LIBRARY_ATTACH_CONFIRMATION,
});
const parse = (raw: unknown) => {
  const result = parseLibraryCommand(raw);
  if (!result.ok) throw Error("INVALID_TEST_COMMAND: " + JSON.stringify(result));
  return result.value;
};

test("#489 D.12: multi-target flag requires D.7/D.9 and durable fence", () => {
  assert.equal(audiobookMultiTargetEnabled(flags), true);
  for (const key of Object.keys(flags)) {
    assert.equal(audiobookMultiTargetEnabled({ ...flags, [key]: "OFF" }), false, key);
  }
});

test("#489 D.12: strict command parser is manual-only, no raw Spotify identities", () => {
  assert.equal(parse(valid).action, "START");
  assert.equal(parseLibraryCommand({ ...valid, spotifyAudiobookId: "a".repeat(22) }).ok, false);
  assert.equal(parseLibraryCommand({ ...valid, chapterDurationMs: -1 }).ok, false);
  assert.equal(parseLibraryCommand({ ...valid, consumedMs: 20_039 }).ok, false);
  assert.equal(parseLibraryCommand({ ...valid, confirmation: "YES" }).ok, false);
  assert.equal(parseLibraryCommand({ ...valid, spotifyShowUrl:
    "https://open.spotify.com/audiobook/5E76EUAq7or1ncd4QNyHjI" }).ok, false);
  assert.equal(LIBRARY_ATTACH_CONFIRMATION,
    "CONFIRMO_PROTEGER_PLAYLIST_ANTES_DA_INCLUSAO");
  assert.equal(parseLibraryCommand({
    ...attach("target-01", 1),
    confirmation: "CONFIRMO_LIVRO_INTEIRO_NA_PLAYLIST_SPOTIFY",
  }).ok, false);
  const ui = readFileSync("src/components/AudiobookMultiPlaylistLibrary.tsx", "utf8");
  assert.match(ui, /ANTES de eu adicionar o livro inteiro no Spotify/);
  assert.equal(parseLibraryCommand(attach("target-01", 1)).ok, true);
  assert.equal(parseLibraryCommand({ ...attach("target-01"), expectedRevision: 0 }).ok, false);
  assert.equal(parseLibraryCommand({ action: "COMPLETE", expectedRevision: 2,
    confirmation: LIBRARY_COMPLETE_CONFIRMATION }).ok, true);
});

test("#489 D.12: one chapter has per-target FIXED/CALENDAR budgets, no writes", () => {
  const fixed = projectLibraryChapterBudget({
    chapterDurationMs: 20039, consumedMs: 0,
    durationMode: "FIXED", fixedDurationSeconds: 600,
  });
  assert.equal(fixed.status, "READY_LOCAL_PREVIEW");
  if (fixed.status === "READY_LOCAL_PREVIEW") {
    assert.equal(fixed.virtualChapterDurationMs, 20_039);
    assert.equal(fixed.remainingBudgetMs, 579_961);
    assert.equal(fixed.spotifyWrites, false);
    assert.equal(fixed.approvalEligible, false);
  }
  const calendar = projectLibraryChapterBudget({
    chapterDurationMs: 20_039, consumedMs: 0,
    durationMode: "CALENDAR", fixedDurationSeconds: null,
  });
  assert.equal(calendar.status, "NEEDS_CALENDAR_DURATION");
  const calendarResolved = projectLibraryChapterBudget({
    chapterDurationMs: 20_039, consumedMs: 0, durationMode: "CALENDAR",
    fixedDurationSeconds: null, calendarDurationMs: 120_000,
  });
  assert.equal(calendarResolved.status, "READY_LOCAL_PREVIEW");
  if (calendarResolved.status === "READY_LOCAL_PREVIEW") {
    assert.equal(calendarResolved.remainingBudgetMs, 99_961);
  }
  assert.equal(projectLibraryChapterBudget({
    chapterDurationMs: 20_039, consumedMs: 0,
    durationMode: "FIXED", fixedDurationSeconds: 15,
  }).status, "ABSTAIN");
});

test("#489 D.12: immutable remote markers block provider writes in all layers", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const writer = read("src/services/audiobooks/write-admission-store.ts");
  const spotify = read("src/services/spotify/client.ts");
  const planner = read("src/jobs/generate-playlists-incremental.ts");
  const repo = read("src/services/audiobooks/d12-library-store.ts");
  const route = read("src/app/api/audiobooks/library/route.ts");
  const migration = read("prisma/migrations/20261018013000_audiobook_d12_global_multi_target/migration.sql");
  const page = read("src/app/dashboard/configuracao/audiolivros/page.tsx");
  assert.match(writer, /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_LIBRARY_TARGET/);
  assert.match(writer, /AUDIOBOOK_BIND_BLOCKED_LIBRARY_TARGET/);
  assert.match(writer, /AUDIOBOOK_TARGET_CONFIG_BLOCKED_LIBRARY_TARGET/);
  assert.match(spotify, /userAudiobookLibraryTarget.findFirst/);
  assert.match(planner, /libraryProtectedTargets.length > 0/);
  assert.match(migration, /WHERE "completedAt" IS NULL/);
  assert.match(migration, /UserAudiobookLibraryTarget_no_update/);
  assert.match(route, /audiobookMultiTargetEnabled\(process.env\)/);
  assert.match(route, /manualAudiobookOriginAllowed/);
  assert.match(page, /AudiobookMultiPlaylistLibrary/);
  assert.doesNotMatch(repo, /SpotifyClient|spotifyRequestAttempt|replacePlaylistItems|appendPlaylistItems/);
});

const dbTest = process.env.DATABASE_URL ? test : test.skip;
dbTest("#489 D.12: two playlists share one reading, global CAS, archive persists fences",
  { concurrency: false }, async t => {
    const suffix = randomUUID().replaceAll("-", "");
    const owner = await prisma.user.create({
      data: { email: "d12-owner-" + suffix + "@example.test" },
    });
    const other = await prisma.user.create({
      data: { email: "d12-other-" + suffix + "@example.test" },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.user.delete({ where: { id: other.id } });
    });
    const fixed = await prisma.targetPlaylist.create({
      data: {
        userId: owner.id, name: "Playlist 10 horas",
        spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
        durationMode: "FIXED", fixedDurationSeconds: 36000,
        sequencePattern: ["MUSIC"], updatePolicy: "KEEP_FILLED",
      },
    });
    const calendar = await prisma.targetPlaylist.create({
      data: {
        userId: owner.id, name: "Playlist calendário",
        spotifyPlaylistId: "1tsFauBmlMXWJLNKTCQFQE",
        durationMode: "CALENDAR", fixedDurationSeconds: null,
        sequencePattern: ["MUSIC","PODCAST"], updatePolicy: "REBUILD_DAILY",
      },
    });
    const foreign = await prisma.targetPlaylist.create({
      data: {
        userId: other.id, name: "Other user's playlist",
        spotifyPlaylistId: "1tsFauBmlMXWJLNKTCQFQF",
        durationMode: "FIXED", fixedDurationSeconds: 180,
        sequencePattern: ["MUSIC"],
      },
    });
    await mutateMultiPlaylistLibrary(owner.id, parse(valid));
    assert.equal((await readMultiPlaylistLibrary(owner.id)).current?.bookTitle, "1984");
    await assert.rejects(() => mutateMultiPlaylistLibrary(other.id, parse(attach(fixed.id))),
      /ACTIVE_READING_OR_REVISION_CONFLICT/);
    await assert.rejects(() => mutateMultiPlaylistLibrary(owner.id, parse(attach(foreign.id))),
      /TARGET_NOT_OWNED/);
    await mutateMultiPlaylistLibrary(owner.id, parse(attach(fixed.id)));
    await mutateMultiPlaylistLibrary(owner.id, parse(attach(calendar.id)));
    const state = await readMultiPlaylistLibrary(owner.id);
    assert.equal(state.current?.targets.length, 2);
    assert.equal(state.current?.revision, 1);
    assert.deepEqual(state.current?.targets.map(x => x.targetName).sort(),
      ["Playlist 10 horas", "Playlist calendário"].sort());
    assert.equal((await readMultiPlaylistLibrary(other.id)).current, null);
    for (const spotifyPlaylistId of [fixed.spotifyPlaylistId!,calendar.spotifyPlaylistId!]) {
      await assert.rejects(() => prismaAudiobookWriteFenceStore.begin({
        userId: owner.id, spotifyPlaylistId,
      }), /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_LIBRARY_TARGET/);
    }
    await assert.rejects(() => mutateMultiPlaylistLibrary(owner.id, parse(attach(fixed.id))),
      /ALREADY_ASSOCIATED/);
    await assert.rejects(() => mutateMultiPlaylistLibrary(owner.id, parse(valid)),
      /COMPLETE_CURRENT_BOOK_FIRST/);
    await mutateMultiPlaylistLibrary(owner.id, parse({
      action: "UPDATE", expectedRevision: 1, chapterLabel: "Capítulo 2",
      chapterDurationMs: 30_000, consumedMs: 10_000,
      confirmation: LIBRARY_UPDATE_CONFIRMATION,
    }));
    await assert.rejects(() => mutateMultiPlaylistLibrary(owner.id, parse({
      action: "UPDATE", expectedRevision: 1, chapterLabel: "Capítulo 3",
      chapterDurationMs: 40_000, consumedMs: 0,
      confirmation: LIBRARY_UPDATE_CONFIRMATION,
    })), /REVISION_CONFLICT/);
    const revised = await readMultiPlaylistLibrary(owner.id);
    assert.equal(revised.current?.revision, 2);
    assert.equal(revised.current?.chapterLabel, "Capítulo 2");
    assert.deepEqual(revised.current?.history.map(e => e.revision), [2,1]);
    await mutateMultiPlaylistLibrary(owner.id, parse({
      action: "COMPLETE", expectedRevision: 2,
      confirmation: LIBRARY_COMPLETE_CONFIRMATION,
    }));
    const after = await readMultiPlaylistLibrary(owner.id);
    assert.equal(after.current, null);
    assert.equal(after.completed[0]?.targetNames.length, 2);
    for (const spotifyPlaylistId of [fixed.spotifyPlaylistId!,calendar.spotifyPlaylistId!]) {
      await assert.rejects(() => prismaAudiobookWriteFenceStore.begin({
        userId: owner.id, spotifyPlaylistId,
      }), /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_LIBRARY_TARGET/);
    }
    await mutateMultiPlaylistLibrary(owner.id, parse(valid));
    await assert.rejects(() => mutateMultiPlaylistLibrary(owner.id, parse(attach(fixed.id))),
      /PREVIOUS_BOOK_PRESENCE_NOT_VERIFIED_REMOVED/);
  });
