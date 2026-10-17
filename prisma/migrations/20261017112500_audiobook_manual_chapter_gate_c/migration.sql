-- AUDIOBOOK-02 Gate C (#489): local chapter revision and audit, additive ONLY.
-- CI applies exclusively to disposable PostgreSQL. Never production without approval.
ALTER TABLE "TargetAudiobookOverlay"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TargetAudiobookChapterChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "overlayId" TEXT NOT NULL,
    "targetPlaylistId" TEXT NOT NULL,
    "previousChapterId" TEXT NOT NULL,
    "selectedChapterId" TEXT NOT NULL,
    "previousRevision" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "manualConsumedMs" INTEGER NOT NULL,
    "chapterDurationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetAudiobookChapterChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TargetAudiobookChapterChange_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TargetAudiobookChapterChange_overlayId_fkey"
      FOREIGN KEY ("overlayId") REFERENCES "TargetAudiobookOverlay"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TargetAudiobookChapterChange_overlayId_revision_key"
    ON "TargetAudiobookChapterChange" ("overlayId", "revision");
CREATE INDEX "TargetAudiobookChapterChange_userId_createdAt_idx"
    ON "TargetAudiobookChapterChange" ("userId", "createdAt");
