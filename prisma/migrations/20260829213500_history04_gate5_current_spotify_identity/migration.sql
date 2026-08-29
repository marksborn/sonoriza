ALTER TABLE "HistoryLikeAction"
ADD COLUMN "resolvedSpotifyTrackId" TEXT,
ADD COLUMN "spotifyResolutionReason" TEXT;

CREATE INDEX "HistoryLikeAction_userId_resolvedSpotifyTrackId_idx"
ON "HistoryLikeAction"("userId", "resolvedSpotifyTrackId");
