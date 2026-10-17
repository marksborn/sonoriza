-- AUDIOBOOK-02 Gate D.9.2 — historical archive independent from live D.7 notes.
-- No pre-existing notebook is moved, renamed or deleted by this migration.
-- A complete action copies all revisions and removes only its source notebook
-- atomically after owner/revision/fence checks.
CREATE TABLE "UserAudiobookCompletedReading" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "originalNotebookId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "spotifyPlaylistId" TEXT NOT NULL,
  "bookTitle" VARCHAR(120) NOT NULL,
  "finalRevision" INTEGER NOT NULL,
  "evidenceSource" VARCHAR(40) NOT NULL DEFAULT 'USER_DECLARED_UNVERIFIED',
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAudiobookCompletedReading_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserAudiobookCompletedReading_evidence_chk"
    CHECK ("evidenceSource" = 'USER_DECLARED_UNVERIFIED'),
  CONSTRAINT "UserAudiobookCompletedReading_revision_chk"
    CHECK ("finalRevision" >= 1)
);
CREATE UNIQUE INDEX "UserAudiobookCompletedReading_originalNotebookId_key"
  ON "UserAudiobookCompletedReading"("originalNotebookId");
CREATE INDEX "UserAudiobookCompletedReading_userId_completedAt_idx"
  ON "UserAudiobookCompletedReading"("userId", "completedAt");
CREATE INDEX "UserAudiobookCompletedReading_userId_spotifyPlaylistId_idx"
  ON "UserAudiobookCompletedReading"("userId", "spotifyPlaylistId");

ALTER TABLE "UserAudiobookCompletedReading"
  ADD CONSTRAINT "UserAudiobookCompletedReading_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserAudiobookCompletedChapter" (
  "id" TEXT NOT NULL,
  "readingId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "bookTitle" VARCHAR(120) NOT NULL,
  "chapterLabel" VARCHAR(120) NOT NULL,
  "chapterDurationMs" INTEGER NOT NULL,
  "consumedMs" INTEGER NOT NULL,
  "targetDurationMs" INTEGER NOT NULL,
  "evidenceSource" VARCHAR(40) NOT NULL DEFAULT 'USER_DECLARED_UNVERIFIED',
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserAudiobookCompletedChapter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserAudiobookCompletedChapter_evidence_chk"
    CHECK ("evidenceSource" = 'USER_DECLARED_UNVERIFIED'),
  CONSTRAINT "UserAudiobookCompletedChapter_revision_chk"
    CHECK ("revision" >= 1),
  CONSTRAINT "UserAudiobookCompletedChapter_budget_chk"
    CHECK ("chapterDurationMs" > 0 AND "chapterDurationMs" <= 86400000
      AND "consumedMs" >= 0 AND "consumedMs" < "chapterDurationMs"
      AND "targetDurationMs" > 0 AND "targetDurationMs" <= 86400000
      AND ("chapterDurationMs" - "consumedMs") <= "targetDurationMs")
);
CREATE UNIQUE INDEX "UserAudiobookCompletedChapter_readingId_revision_key"
  ON "UserAudiobookCompletedChapter"("readingId", "revision");
ALTER TABLE "UserAudiobookCompletedChapter"
  ADD CONSTRAINT "UserAudiobookCompletedChapter_readingId_fkey"
  FOREIGN KEY ("readingId") REFERENCES "UserAudiobookCompletedReading"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Archived chapters are append-only. API does not expose mutation/deletion.
CREATE TRIGGER "UserAudiobookCompletedChapter_no_update"
  BEFORE UPDATE ON "UserAudiobookCompletedChapter"
  FOR EACH ROW EXECUTE FUNCTION "prevent_manual_audiobook_entry_change"();
CREATE TRIGGER "UserAudiobookCompletedReading_no_update"
  BEFORE UPDATE ON "UserAudiobookCompletedReading"
  FOR EACH ROW EXECUTE FUNCTION "prevent_manual_audiobook_entry_change"();
