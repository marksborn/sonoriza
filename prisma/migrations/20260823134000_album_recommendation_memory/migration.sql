-- ALBUM-01 Gate 5 — persistent album recommendation lifecycle memory.
-- Exact Spotify album edition identity remains spotifyAlbumId.

CREATE TYPE "AlbumRecommendationState" AS ENUM (
  'DISCOVERED',
  'RECOMMENDED',
  'QUEUED',
  'LISTENING',
  'COMPLETED',
  'DISMISSED'
);

CREATE TABLE "AlbumRecommendationMemory" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spotifyAlbumId" TEXT NOT NULL,
  "state" "AlbumRecommendationState" NOT NULL,
  "artistName" TEXT NOT NULL,
  "albumName" TEXT NOT NULL,
  "queuedAt" TIMESTAMP(3),
  "queuedPlaylistId" TEXT,
  "queuedPlaylistName" TEXT,
  "queuedWriterSnapshot" TEXT,
  "queuedContentFingerprint" TEXT,
  "source" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AlbumRecommendationMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlbumRecommendationMemory_userId_spotifyAlbumId_key"
  ON "AlbumRecommendationMemory"("userId", "spotifyAlbumId");

CREATE INDEX "AlbumRecommendationMemory_userId_state_queuedAt_idx"
  ON "AlbumRecommendationMemory"("userId", "state", "queuedAt");

ALTER TABLE "AlbumRecommendationMemory"
  ADD CONSTRAINT "AlbumRecommendationMemory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
