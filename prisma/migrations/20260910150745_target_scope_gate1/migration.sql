-- TARGET-SCOPE-01 Gate 1
-- Persistence only. No planner/runtime behavior changes.

CREATE TYPE "TargetSourceScopeMode" AS ENUM (
  'INHERIT_GLOBAL',
  'SELECTED_ONLY'
);

CREATE TYPE "TargetSharingPolicy" AS ENUM (
  'INHERIT_GLOBAL',
  'EXCLUSIVE',
  'SHAREABLE'
);

ALTER TABLE "TargetPlaylist"
  ADD COLUMN "sourceScopeMode" "TargetSourceScopeMode"
    NOT NULL DEFAULT 'INHERIT_GLOBAL',
  ADD COLUMN "sharingPolicy" "TargetSharingPolicy"
    NOT NULL DEFAULT 'INHERIT_GLOBAL';

CREATE UNIQUE INDEX "SourcePlaylist_userId_id_key"
  ON "SourcePlaylist"("userId", "id");

CREATE UNIQUE INDEX "TargetPlaylist_userId_id_key"
  ON "TargetPlaylist"("userId", "id");

CREATE TABLE "TargetPlaylistSource" (
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "sourcePlaylistId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TargetPlaylistSource_pkey"
    PRIMARY KEY ("targetPlaylistId", "sourcePlaylistId")
);

CREATE INDEX "TargetPlaylistSource_userId_sourcePlaylistId_idx"
  ON "TargetPlaylistSource"("userId", "sourcePlaylistId");

ALTER TABLE "TargetPlaylistSource"
  ADD CONSTRAINT "TargetPlaylistSource_userId_targetPlaylistId_fkey"
  FOREIGN KEY ("userId", "targetPlaylistId")
  REFERENCES "TargetPlaylist"("userId", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "TargetPlaylistSource"
  ADD CONSTRAINT "TargetPlaylistSource_userId_sourcePlaylistId_fkey"
  FOREIGN KEY ("userId", "sourcePlaylistId")
  REFERENCES "SourcePlaylist"("userId", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
