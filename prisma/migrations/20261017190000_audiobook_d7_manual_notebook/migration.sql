-- AUDIOBOOK-02 Gate D.7 — intentionally isolated manual notebook.
-- ZERO foreign keys to Spotify verified overlay, GenerationRun or write fences.
CREATE TABLE "TargetAudiobookManualNotebook" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "bookTitle" VARCHAR(120) NOT NULL,
  "chapterLabel" VARCHAR(120) NOT NULL,
  "chapterDurationMs" INTEGER NOT NULL,
  "consumedMs" INTEGER NOT NULL DEFAULT 0,
  "targetDurationMs" INTEGER NOT NULL,
  "evidenceSource" VARCHAR(40) NOT NULL DEFAULT 'USER_DECLARED_UNVERIFIED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TargetAudiobookManualNotebook_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TargetAudiobookManualNotebook_manual_evidence_chk"
    CHECK ("evidenceSource" = 'USER_DECLARED_UNVERIFIED'),
  CONSTRAINT "TargetAudiobookManualNotebook_budget_chk"
    CHECK ("chapterDurationMs" > 0 AND "chapterDurationMs" <= 86400000
      AND "consumedMs" >= 0 AND "consumedMs" < "chapterDurationMs"
      AND "targetDurationMs" > 0 AND "targetDurationMs" <= 86400000
      AND ("chapterDurationMs" - "consumedMs") <= "targetDurationMs"),
  CONSTRAINT "TargetAudiobookManualNotebook_revision_chk"
    CHECK ("revision" >= 1 AND "revision" <= 2147483647)
);

CREATE UNIQUE INDEX "TargetAudiobookManualNotebook_targetPlaylistId_key"
  ON "TargetAudiobookManualNotebook"("targetPlaylistId");
CREATE UNIQUE INDEX "TargetAudiobookManualNotebook_userId_targetPlaylistId_key"
  ON "TargetAudiobookManualNotebook"("userId", "targetPlaylistId");
CREATE INDEX "TargetAudiobookManualNotebook_userId_updatedAt_idx"
  ON "TargetAudiobookManualNotebook"("userId", "updatedAt");

ALTER TABLE "TargetAudiobookManualNotebook"
  ADD CONSTRAINT "TargetAudiobookManualNotebook_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetAudiobookManualNotebook"
  ADD CONSTRAINT "TargetAudiobookManualNotebook_userId_targetPlaylistId_fkey"
    FOREIGN KEY ("userId", "targetPlaylistId")
    REFERENCES "TargetPlaylist"("userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TargetAudiobookManualEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "notebookId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "bookTitle" VARCHAR(120) NOT NULL,
  "chapterLabel" VARCHAR(120) NOT NULL,
  "chapterDurationMs" INTEGER NOT NULL,
  "consumedMs" INTEGER NOT NULL,
  "targetDurationMs" INTEGER NOT NULL,
  "evidenceSource" VARCHAR(40) NOT NULL DEFAULT 'USER_DECLARED_UNVERIFIED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TargetAudiobookManualEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TargetAudiobookManualEntry_manual_evidence_chk"
    CHECK ("evidenceSource" = 'USER_DECLARED_UNVERIFIED'),
  CONSTRAINT "TargetAudiobookManualEntry_budget_chk"
    CHECK ("chapterDurationMs" > 0 AND "chapterDurationMs" <= 86400000
      AND "consumedMs" >= 0 AND "consumedMs" < "chapterDurationMs"
      AND "targetDurationMs" > 0 AND "targetDurationMs" <= 86400000
      AND ("chapterDurationMs" - "consumedMs") <= "targetDurationMs"),
  CONSTRAINT "TargetAudiobookManualEntry_revision_chk"
    CHECK ("revision" >= 1 AND "revision" <= 2147483647)
);

CREATE UNIQUE INDEX "TargetAudiobookManualEntry_notebookId_revision_key"
  ON "TargetAudiobookManualEntry"("notebookId", "revision");
CREATE INDEX "TargetAudiobookManualEntry_userId_createdAt_idx"
  ON "TargetAudiobookManualEntry"("userId", "createdAt");

ALTER TABLE "TargetAudiobookManualEntry"
  ADD CONSTRAINT "TargetAudiobookManualEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TargetAudiobookManualEntry"
  ADD CONSTRAINT "TargetAudiobookManualEntry_notebookId_fkey"
    FOREIGN KEY ("notebookId") REFERENCES "TargetAudiobookManualNotebook"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The audit rows must be immutable, including during Prisma/raw SQL updates.
-- Cascading target/notebook deletion is allowed and deletes the entire notebook.
CREATE FUNCTION "prevent_manual_audiobook_entry_change"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIOBOOK_MANUAL_HISTORY_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TargetAudiobookManualEntry_no_update_delete"
  BEFORE UPDATE OR DELETE ON "TargetAudiobookManualEntry"
  FOR EACH ROW EXECUTE FUNCTION "prevent_manual_audiobook_entry_change"();
