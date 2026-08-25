-- LIKED-01 Gate 2
-- Canonical Saved/Liked Track state plus explicit artist-affinity evidence.
-- Shadow only: these tables are not consumed by planner/discovery in this gate.

CREATE TYPE "LikedTrackPreferenceProvenance" AS ENUM (
  'LIKED_TRACK_BACKFILL',
  'LIKED_TRACK_SYNC'
);

CREATE TYPE "LikedTrackAvailability" AS ENUM (
  'AVAILABLE',
  'UNAVAILABLE',
  'INVALID'
);

CREATE TYPE "ArtistAffinityEvidenceType" AS ENUM (
  'LIKED_TRACK'
);

CREATE TABLE "LikedTrackPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spotifyTrackId" TEXT NOT NULL,
  "spotifyUri" TEXT,
  "trackName" TEXT,
  "primaryArtistId" TEXT,
  "primaryArtistName" TEXT,
  "albumId" TEXT,
  "albumName" TEXT,
  "addedAt" TIMESTAMP(3),
  "isLiked" BOOLEAN NOT NULL DEFAULT true,
  "availability" "LikedTrackAvailability" NOT NULL,
  "firstProvenance" "LikedTrackPreferenceProvenance" NOT NULL,
  "lastProvenance" "LikedTrackPreferenceProvenance" NOT NULL,
  "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMP(3) NOT NULL,
  "unlikedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LikedTrackPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LikedTrackPreference_userId_spotifyTrackId_key"
ON "LikedTrackPreference"("userId", "spotifyTrackId");

CREATE INDEX "LikedTrackPreference_userId_isLiked_idx"
ON "LikedTrackPreference"("userId", "isLiked");

CREATE INDEX "LikedTrackPreference_userId_primaryArtistId_isLiked_idx"
ON "LikedTrackPreference"("userId", "primaryArtistId", "isLiked");

CREATE TABLE "ArtistAffinityEvidence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spotifyTrackId" TEXT NOT NULL,
  "spotifyArtistId" TEXT NOT NULL,
  "artistName" TEXT,
  "type" "ArtistAffinityEvidenceType" NOT NULL DEFAULT 'LIKED_TRACK',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "firstProvenance" "LikedTrackPreferenceProvenance" NOT NULL,
  "lastProvenance" "LikedTrackPreferenceProvenance" NOT NULL,
  "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastChangedAt" TIMESTAMP(3) NOT NULL,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtistAffinityEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtistAffinityEvidence_userId_type_spotifyTrackId_spotifyArtistId_key"
ON "ArtistAffinityEvidence"("userId", "type", "spotifyTrackId", "spotifyArtistId");

CREATE INDEX "ArtistAffinityEvidence_userId_spotifyArtistId_active_idx"
ON "ArtistAffinityEvidence"("userId", "spotifyArtistId", "active");

CREATE INDEX "ArtistAffinityEvidence_userId_spotifyTrackId_active_idx"
ON "ArtistAffinityEvidence"("userId", "spotifyTrackId", "active");

CREATE TABLE "ArtistAffinityState" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spotifyArtistId" TEXT NOT NULL,
  "artistName" TEXT,
  "likedTrackCount" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastChangedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtistAffinityState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtistAffinityState_userId_spotifyArtistId_key"
ON "ArtistAffinityState"("userId", "spotifyArtistId");

CREATE INDEX "ArtistAffinityState_userId_active_likedTrackCount_idx"
ON "ArtistAffinityState"("userId", "active", "likedTrackCount");

ALTER TABLE "LikedTrackPreference"
ADD CONSTRAINT "LikedTrackPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtistAffinityEvidence"
ADD CONSTRAINT "ArtistAffinityEvidence_userId_spotifyTrackId_fkey"
FOREIGN KEY ("userId", "spotifyTrackId")
REFERENCES "LikedTrackPreference"("userId", "spotifyTrackId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtistAffinityState"
ADD CONSTRAINT "ArtistAffinityState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
