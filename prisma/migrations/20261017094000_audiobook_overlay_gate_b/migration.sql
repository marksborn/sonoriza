-- AUDIOBOOK-02 Gate B (#489): local-only manual audiobook overlay.
-- Does not modify or remove any Spotify content or existing target rows.
CREATE TYPE "AudiobookPlanningMode" AS ENUM ('FULL_CHAPTER', 'MANUAL_REMAINDER');

CREATE TABLE "TargetAudiobookOverlay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetPlaylistId" TEXT NOT NULL,
    "spotifyPlaylistId" TEXT NOT NULL,
    "spotifyAudiobookId" TEXT NOT NULL,
    "selectedChapterId" TEXT NOT NULL,
    "chapterDurationMs" INTEGER NOT NULL,
    "providerDurationMs" INTEGER,
    "manualConsumedMs" INTEGER NOT NULL DEFAULT 0,
    "selectionMode" "AudiobookPlanningMode" NOT NULL DEFAULT 'FULL_CHAPTER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TargetAudiobookOverlay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TargetAudiobookOverlay_targetPlaylistId_key"
    ON "TargetAudiobookOverlay"("targetPlaylistId");
CREATE UNIQUE INDEX "TargetAudiobookOverlay_userId_spotifyPlaylistId_key"
    ON "TargetAudiobookOverlay"("userId", "spotifyPlaylistId");
CREATE UNIQUE INDEX "TargetAudiobookOverlay_userId_targetPlaylistId_key"
    ON "TargetAudiobookOverlay"("userId", "targetPlaylistId");
CREATE INDEX "TargetAudiobookOverlay_userId_spotifyAudiobookId_idx"
    ON "TargetAudiobookOverlay"("userId", "spotifyAudiobookId");

ALTER TABLE "TargetAudiobookOverlay"
    ADD CONSTRAINT "TargetAudiobookOverlay_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetAudiobookOverlay"
    ADD CONSTRAINT "TargetAudiobookOverlay_userId_targetPlaylistId_fkey"
    FOREIGN KEY ("userId", "targetPlaylistId")
    REFERENCES "TargetPlaylist"("userId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
