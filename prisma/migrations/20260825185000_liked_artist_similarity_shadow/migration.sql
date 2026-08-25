-- LIKED-01 Gate 3 — cached, auditable similar-artist expansion in shadow mode.

CREATE TYPE "ArtistSimilarityProvider" AS ENUM ('LASTFM');

CREATE TABLE "ArtistSimilaritySeedState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ArtistSimilarityProvider" NOT NULL,
    "sourceSpotifyArtistId" TEXT NOT NULL,
    "sourceArtistName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "refreshAfter" TIMESTAMP(3),
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistSimilaritySeedState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtistSimilarityEdge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seedStateId" TEXT NOT NULL,
    "provider" "ArtistSimilarityProvider" NOT NULL,
    "sourceSpotifyArtistId" TEXT NOT NULL,
    "sourceArtistName" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "candidateArtistName" TEXT NOT NULL,
    "candidateArtistMbid" TEXT,
    "candidateArtistUrl" TEXT,
    "similarity" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistSimilarityEdge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtistSimilaritySeedState_userId_provider_sourceSpotifyArtistId_key"
ON "ArtistSimilaritySeedState"("userId", "provider", "sourceSpotifyArtistId");

CREATE INDEX "ArtistSimilaritySeedState_userId_provider_active_refreshAfter_idx"
ON "ArtistSimilaritySeedState"("userId", "provider", "active", "refreshAfter");

CREATE UNIQUE INDEX "ArtistSimilarityEdge_userId_provider_sourceSpotifyArtistId_candidateKey_key"
ON "ArtistSimilarityEdge"("userId", "provider", "sourceSpotifyArtistId", "candidateKey");

CREATE INDEX "ArtistSimilarityEdge_userId_active_similarity_idx"
ON "ArtistSimilarityEdge"("userId", "active", "similarity");

CREATE INDEX "ArtistSimilarityEdge_userId_candidateKey_active_idx"
ON "ArtistSimilarityEdge"("userId", "candidateKey", "active");

CREATE INDEX "ArtistSimilarityEdge_seedStateId_active_idx"
ON "ArtistSimilarityEdge"("seedStateId", "active");

ALTER TABLE "ArtistSimilaritySeedState"
ADD CONSTRAINT "ArtistSimilaritySeedState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtistSimilarityEdge"
ADD CONSTRAINT "ArtistSimilarityEdge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtistSimilarityEdge"
ADD CONSTRAINT "ArtistSimilarityEdge_seedStateId_fkey"
FOREIGN KEY ("seedStateId") REFERENCES "ArtistSimilaritySeedState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
