-- AUDIOBOOK-02 D.12 — global user reading and multiple local playlist associations.
-- Additive ONLY: never touch, migrate or delete pre-existing D.7/D.9 records.
-- No Spotify requests, data backfills or permission to write provider playlists.

CREATE TABLE "UserAudiobookLibraryReading" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bookTitle" VARCHAR(120) NOT NULL,
  "spotifyShowId" VARCHAR(22) NOT NULL,
  "chapterLabel" VARCHAR(120) NOT NULL,
  "chapterDurationMs" INTEGER NOT NULL,
  "consumedMs" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "evidenceSource" VARCHAR(40) NOT NULL DEFAULT 'USER_DECLARED_UNVERIFIED',
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserAudiobookLibraryReading_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserAudiobookLibraryReading_evidence_chk"
    CHECK ("evidenceSource" = 'USER_DECLARED_UNVERIFIED'),
  CONSTRAINT "UserAudiobookLibraryReading_chapter_chk"
    CHECK ("chapterDurationMs" > 0 AND "chapterDurationMs" <= 86400000
      AND "consumedMs" >= 0 AND "consumedMs" < "chapterDurationMs"),
  CONSTRAINT "UserAudiobookLibraryReading_revision_chk"
    CHECK ("revision" >= 1 AND "revision" <= 2147483647),
  CONSTRAINT "UserAudiobookLibraryReading_show_chk"
    CHECK ("spotifyShowId" ~ '^[A-Za-z0-9]{22}$')
);
CREATE UNIQUE INDEX "UserAudiobookLibraryReading_userId_id_key"
  ON "UserAudiobookLibraryReading"("userId", "id");
-- PostgreSQL guarantees one active book per user, including concurrent writers.
-- Prisma schema cannot represent partial UNIQUE indexes.
CREATE UNIQUE INDEX "UserAudiobookLibraryReading_one_active_user_key"
  ON "UserAudiobookLibraryReading"("userId") WHERE "completedAt" IS NULL;
CREATE INDEX "UserAudiobookLibraryReading_userId_completedAt_idx"
  ON "UserAudiobookLibraryReading"("userId", "completedAt");
ALTER TABLE "UserAudiobookLibraryReading"
  ADD CONSTRAINT "UserAudiobookLibraryReading_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserAudiobookLibraryEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readingId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "bookTitle" VARCHAR(120) NOT NULL,
  "spotifyShowId" VARCHAR(22) NOT NULL,
  "chapterLabel" VARCHAR(120) NOT NULL,
  "chapterDurationMs" INTEGER NOT NULL,
  "consumedMs" INTEGER NOT NULL,
  "evidenceSource" VARCHAR(40) NOT NULL DEFAULT 'USER_DECLARED_UNVERIFIED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAudiobookLibraryEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserAudiobookLibraryEntry_evidence_chk"
    CHECK ("evidenceSource" = 'USER_DECLARED_UNVERIFIED'),
  CONSTRAINT "UserAudiobookLibraryEntry_chapter_chk"
    CHECK ("chapterDurationMs" > 0 AND "chapterDurationMs" <= 86400000
      AND "consumedMs" >= 0 AND "consumedMs" < "chapterDurationMs"),
  CONSTRAINT "UserAudiobookLibraryEntry_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "UserAudiobookLibraryEntry_show_chk"
    CHECK ("spotifyShowId" ~ '^[A-Za-z0-9]{22}$')
);
CREATE UNIQUE INDEX "UserAudiobookLibraryEntry_readingId_revision_key"
  ON "UserAudiobookLibraryEntry"("readingId", "revision");
CREATE INDEX "UserAudiobookLibraryEntry_userId_createdAt_idx"
  ON "UserAudiobookLibraryEntry"("userId", "createdAt");
ALTER TABLE "UserAudiobookLibraryEntry"
  ADD CONSTRAINT "UserAudiobookLibraryEntry_userId_readingId_fkey"
  FOREIGN KEY ("userId", "readingId")
  REFERENCES "UserAudiobookLibraryReading"("userId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "UserAudiobookLibraryEntry_no_update"
  BEFORE UPDATE ON "UserAudiobookLibraryEntry"
  FOR EACH ROW EXECUTE FUNCTION "prevent_manual_audiobook_entry_change"();

CREATE TABLE "UserAudiobookLibraryTarget" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readingId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "targetName" VARCHAR(120) NOT NULL,
  "spotifyPlaylistId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAudiobookLibraryTarget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserAudiobookLibraryTarget_remote_chk"
    CHECK ("spotifyPlaylistId" ~ '^[A-Za-z0-9]{22}$')
);
CREATE UNIQUE INDEX "UserAudiobookLibraryTarget_readingId_spotifyPlaylistId_key"
  ON "UserAudiobookLibraryTarget"("readingId", "spotifyPlaylistId");
CREATE INDEX "UserAudiobookLibraryTarget_userId_spotifyPlaylistId_idx"
  ON "UserAudiobookLibraryTarget"("userId", "spotifyPlaylistId");
CREATE INDEX "UserAudiobookLibraryTarget_userId_targetPlaylistId_idx"
  ON "UserAudiobookLibraryTarget"("userId", "targetPlaylistId");
ALTER TABLE "UserAudiobookLibraryTarget"
  ADD CONSTRAINT "UserAudiobookLibraryTarget_userId_readingId_fkey"
  FOREIGN KEY ("userId", "readingId")
  REFERENCES "UserAudiobookLibraryReading"("userId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Past associations remain permanent, even after the reading completes.
-- No API can detach the marker without separate verified-removal evidence.
CREATE FUNCTION "prevent_library_audiobook_marker_change"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIOBOOK_LIBRARY_TARGET_MARKER_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "UserAudiobookLibraryTarget_no_update"
  BEFORE UPDATE ON "UserAudiobookLibraryTarget"
  FOR EACH ROW EXECUTE FUNCTION "prevent_library_audiobook_marker_change"();
-- Cascaded deletions for user privacy are allowed; no application delete endpoint.

CREATE FUNCTION "prevent_completed_library_reading_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'AUDIOBOOK_LIBRARY_ARCHIVE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "UserAudiobookLibraryReading_archived_no_update"
  BEFORE UPDATE ON "UserAudiobookLibraryReading"
  FOR EACH ROW EXECUTE FUNCTION "prevent_completed_library_reading_change"();
