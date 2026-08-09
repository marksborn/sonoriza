CREATE TABLE "MusicIngestionLease" (
    "targetSourcePlaylistId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MusicIngestionLease_pkey" PRIMARY KEY ("targetSourcePlaylistId")
);

CREATE INDEX "MusicIngestionLease_expiresAt_idx"
ON "MusicIngestionLease"("expiresAt");

ALTER TABLE "MusicIngestionLease"
ADD CONSTRAINT "MusicIngestionLease_targetSourcePlaylistId_fkey"
FOREIGN KEY ("targetSourcePlaylistId") REFERENCES "SourcePlaylist"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
