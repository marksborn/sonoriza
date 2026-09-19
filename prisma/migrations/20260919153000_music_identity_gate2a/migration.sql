-- MUSIC-IDENTITY-01 Gate 2A — additive canonical identity persistence only.
--
-- No legacy rows are backfilled here and no productive consumer reads these
-- tables in this gate. Provider refs remain separate from canonical identities.

CREATE TYPE "TrackProviderExecutionStatus" AS ENUM (
  'KNOWN',
  'EXECUTABLE',
  'UNAVAILABLE'
);

CREATE TABLE "ArtistIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "canonicalName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtistIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArtistIdentity_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "ArtistIdentity_canonicalName_check" CHECK (btrim("canonicalName") <> '')
);

CREATE TABLE "SongIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "primaryArtistIdentityId" TEXT NOT NULL,
  "canonicalTitle" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SongIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SongIdentity_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "SongIdentity_primaryArtistIdentityId_check" CHECK (btrim("primaryArtistIdentityId") <> ''),
  CONSTRAINT "SongIdentity_canonicalTitle_check" CHECK (btrim("canonicalTitle") <> '')
);

CREATE TABLE "RecordingIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "songIdentityId" TEXT NOT NULL,
  "versionClass" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RecordingIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecordingIdentity_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "RecordingIdentity_songIdentityId_check" CHECK (btrim("songIdentityId") <> ''),
  CONSTRAINT "RecordingIdentity_versionClass_check" CHECK (
    "versionClass" IS NULL OR btrim("versionClass") <> ''
  )
);

CREATE TABLE "AlbumIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "canonicalTitle" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AlbumIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlbumIdentity_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "AlbumIdentity_canonicalTitle_check" CHECK (btrim("canonicalTitle") <> '')
);

CREATE TABLE "AlbumReleaseIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "albumIdentityId" TEXT NOT NULL,
  "editionLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AlbumReleaseIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlbumReleaseIdentity_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "AlbumReleaseIdentity_albumIdentityId_check" CHECK (btrim("albumIdentityId") <> ''),
  CONSTRAINT "AlbumReleaseIdentity_editionLabel_check" CHECK (
    "editionLabel" IS NULL OR btrim("editionLabel") <> ''
  )
);

CREATE TABLE "ArtistProviderRef" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "artistIdentityId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerArtistId" TEXT NOT NULL,
  "uri" TEXT,
  "matchReason" TEXT NOT NULL,
  "confidenceBasisPoints" INTEGER NOT NULL,
  "resolutionLineage" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtistProviderRef_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArtistProviderRef_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "ArtistProviderRef_provider_check" CHECK (
    btrim("provider") <> '' AND "provider" = lower(btrim("provider"))
  ),
  CONSTRAINT "ArtistProviderRef_providerArtistId_check" CHECK (btrim("providerArtistId") <> ''),
  CONSTRAINT "ArtistProviderRef_uri_check" CHECK ("uri" IS NULL OR btrim("uri") <> ''),
  CONSTRAINT "ArtistProviderRef_matchReason_check" CHECK (btrim("matchReason") <> ''),
  CONSTRAINT "ArtistProviderRef_confidence_check" CHECK (
    "confidenceBasisPoints" BETWEEN 0 AND 10000
  ),
  CONSTRAINT "ArtistProviderRef_resolutionLineage_check" CHECK (
    jsonb_typeof("resolutionLineage") = 'object'
    AND "resolutionLineage" ? 'origins'
    AND jsonb_typeof("resolutionLineage" -> 'origins') = 'array'
    AND jsonb_array_length("resolutionLineage" -> 'origins') > 0
  )
);

CREATE TABLE "TrackProviderRef" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "recordingIdentityId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerTrackId" TEXT NOT NULL,
  "uri" TEXT,
  "isrc" TEXT,
  "trackMbid" TEXT,
  "market" TEXT,
  "executionStatus" "TrackProviderExecutionStatus" NOT NULL DEFAULT 'KNOWN',
  "matchReason" TEXT NOT NULL,
  "confidenceBasisPoints" INTEGER NOT NULL,
  "resolutionLineage" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TrackProviderRef_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrackProviderRef_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "TrackProviderRef_provider_check" CHECK (
    btrim("provider") <> '' AND "provider" = lower(btrim("provider"))
  ),
  CONSTRAINT "TrackProviderRef_providerTrackId_check" CHECK (btrim("providerTrackId") <> ''),
  CONSTRAINT "TrackProviderRef_uri_check" CHECK ("uri" IS NULL OR btrim("uri") <> ''),
  CONSTRAINT "TrackProviderRef_isrc_check" CHECK ("isrc" IS NULL OR btrim("isrc") <> ''),
  CONSTRAINT "TrackProviderRef_trackMbid_check" CHECK ("trackMbid" IS NULL OR btrim("trackMbid") <> ''),
  CONSTRAINT "TrackProviderRef_market_check" CHECK ("market" IS NULL OR btrim("market") <> ''),
  CONSTRAINT "TrackProviderRef_matchReason_check" CHECK (btrim("matchReason") <> ''),
  CONSTRAINT "TrackProviderRef_confidence_check" CHECK (
    "confidenceBasisPoints" BETWEEN 0 AND 10000
  ),
  CONSTRAINT "TrackProviderRef_resolutionLineage_check" CHECK (
    jsonb_typeof("resolutionLineage") = 'object'
    AND "resolutionLineage" ? 'origins'
    AND jsonb_typeof("resolutionLineage" -> 'origins') = 'array'
    AND jsonb_array_length("resolutionLineage" -> 'origins') > 0
  ),
  CONSTRAINT "TrackProviderRef_execution_shape_check" CHECK (
    "executionStatus" <> 'EXECUTABLE'
    OR ("uri" IS NOT NULL AND btrim("uri") <> '')
  )
);

CREATE TABLE "AlbumReleaseProviderRef" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "albumReleaseIdentityId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAlbumId" TEXT NOT NULL,
  "uri" TEXT,
  "market" TEXT,
  "matchReason" TEXT NOT NULL,
  "confidenceBasisPoints" INTEGER NOT NULL,
  "resolutionLineage" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AlbumReleaseProviderRef_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlbumReleaseProviderRef_userId_check" CHECK (btrim("userId") <> ''),
  CONSTRAINT "AlbumReleaseProviderRef_provider_check" CHECK (
    btrim("provider") <> '' AND "provider" = lower(btrim("provider"))
  ),
  CONSTRAINT "AlbumReleaseProviderRef_providerAlbumId_check" CHECK (btrim("providerAlbumId") <> ''),
  CONSTRAINT "AlbumReleaseProviderRef_uri_check" CHECK ("uri" IS NULL OR btrim("uri") <> ''),
  CONSTRAINT "AlbumReleaseProviderRef_market_check" CHECK ("market" IS NULL OR btrim("market") <> ''),
  CONSTRAINT "AlbumReleaseProviderRef_matchReason_check" CHECK (btrim("matchReason") <> ''),
  CONSTRAINT "AlbumReleaseProviderRef_confidence_check" CHECK (
    "confidenceBasisPoints" BETWEEN 0 AND 10000
  ),
  CONSTRAINT "AlbumReleaseProviderRef_resolutionLineage_check" CHECK (
    jsonb_typeof("resolutionLineage") = 'object'
    AND "resolutionLineage" ? 'origins'
    AND jsonb_typeof("resolutionLineage" -> 'origins') = 'array'
    AND jsonb_array_length("resolutionLineage" -> 'origins') > 0
  )
);

CREATE UNIQUE INDEX "ArtistIdentity_userId_id_key"
  ON "ArtistIdentity"("userId", "id");
CREATE INDEX "ArtistIdentity_userId_canonicalName_idx"
  ON "ArtistIdentity"("userId", "canonicalName");

CREATE UNIQUE INDEX "SongIdentity_userId_id_key"
  ON "SongIdentity"("userId", "id");
CREATE INDEX "SongIdentity_userId_primaryArtistIdentityId_idx"
  ON "SongIdentity"("userId", "primaryArtistIdentityId");
CREATE INDEX "SongIdentity_userId_canonicalTitle_idx"
  ON "SongIdentity"("userId", "canonicalTitle");

CREATE UNIQUE INDEX "RecordingIdentity_userId_id_key"
  ON "RecordingIdentity"("userId", "id");
CREATE INDEX "RecordingIdentity_userId_songIdentityId_idx"
  ON "RecordingIdentity"("userId", "songIdentityId");
CREATE INDEX "RecordingIdentity_userId_versionClass_idx"
  ON "RecordingIdentity"("userId", "versionClass");

CREATE UNIQUE INDEX "AlbumIdentity_userId_id_key"
  ON "AlbumIdentity"("userId", "id");
CREATE INDEX "AlbumIdentity_userId_canonicalTitle_idx"
  ON "AlbumIdentity"("userId", "canonicalTitle");

CREATE UNIQUE INDEX "AlbumReleaseIdentity_userId_id_key"
  ON "AlbumReleaseIdentity"("userId", "id");
CREATE INDEX "AlbumReleaseIdentity_userId_albumIdentityId_idx"
  ON "AlbumReleaseIdentity"("userId", "albumIdentityId");

CREATE UNIQUE INDEX "ArtistProviderRef_userId_id_key"
  ON "ArtistProviderRef"("userId", "id");
CREATE UNIQUE INDEX "ArtistProviderRef_userId_provider_providerArtistId_key"
  ON "ArtistProviderRef"("userId", "provider", "providerArtistId");
CREATE INDEX "ArtistProviderRef_userId_artistIdentityId_idx"
  ON "ArtistProviderRef"("userId", "artistIdentityId");

CREATE UNIQUE INDEX "TrackProviderRef_userId_id_key"
  ON "TrackProviderRef"("userId", "id");
CREATE UNIQUE INDEX "TrackProviderRef_userId_provider_providerTrackId_key"
  ON "TrackProviderRef"("userId", "provider", "providerTrackId");
CREATE INDEX "TrackProviderRef_userId_recordingIdentityId_idx"
  ON "TrackProviderRef"("userId", "recordingIdentityId");
CREATE INDEX "TrackProviderRef_userId_isrc_idx"
  ON "TrackProviderRef"("userId", "isrc");
CREATE INDEX "TrackProviderRef_userId_trackMbid_idx"
  ON "TrackProviderRef"("userId", "trackMbid");

CREATE UNIQUE INDEX "AlbumReleaseProviderRef_userId_id_key"
  ON "AlbumReleaseProviderRef"("userId", "id");
CREATE UNIQUE INDEX "AlbumReleaseProviderRef_userId_provider_providerAlbumId_key"
  ON "AlbumReleaseProviderRef"("userId", "provider", "providerAlbumId");
CREATE INDEX "AlbumReleaseProviderRef_userId_albumReleaseIdentityId_idx"
  ON "AlbumReleaseProviderRef"("userId", "albumReleaseIdentityId");

ALTER TABLE "SongIdentity"
  ADD CONSTRAINT "SongIdentity_userId_primaryArtistIdentityId_fkey"
  FOREIGN KEY ("userId", "primaryArtistIdentityId")
  REFERENCES "ArtistIdentity"("userId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecordingIdentity"
  ADD CONSTRAINT "RecordingIdentity_userId_songIdentityId_fkey"
  FOREIGN KEY ("userId", "songIdentityId")
  REFERENCES "SongIdentity"("userId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AlbumReleaseIdentity"
  ADD CONSTRAINT "AlbumReleaseIdentity_userId_albumIdentityId_fkey"
  FOREIGN KEY ("userId", "albumIdentityId")
  REFERENCES "AlbumIdentity"("userId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ArtistProviderRef"
  ADD CONSTRAINT "ArtistProviderRef_userId_artistIdentityId_fkey"
  FOREIGN KEY ("userId", "artistIdentityId")
  REFERENCES "ArtistIdentity"("userId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrackProviderRef"
  ADD CONSTRAINT "TrackProviderRef_userId_recordingIdentityId_fkey"
  FOREIGN KEY ("userId", "recordingIdentityId")
  REFERENCES "RecordingIdentity"("userId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AlbumReleaseProviderRef"
  ADD CONSTRAINT "AlbumReleaseProviderRef_userId_albumReleaseIdentityId_fkey"
  FOREIGN KEY ("userId", "albumReleaseIdentityId")
  REFERENCES "AlbumReleaseIdentity"("userId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
