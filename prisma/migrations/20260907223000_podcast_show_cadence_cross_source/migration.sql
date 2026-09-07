-- PODCAST-06 Gate 3 — move cadence/priority authority from explicit SHOW source
-- policy to a source-independent (userId, spotifyShowId) policy.
--
-- The legacy columns remain physically present for compatibility with older
-- Prisma clients, but are neutralized and constrained to null/null + NORMAL so
-- they cannot become a second semantic source of truth.

CREATE TABLE "PodcastShowCadencePolicy" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spotifyShowId" TEXT NOT NULL,
  "showName" TEXT,
  "cadenceMaxEpisodes" INTEGER,
  "cadenceUnit" "PodcastCadenceUnit",
  "priority" "PodcastShowPriority" NOT NULL DEFAULT 'NORMAL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PodcastShowCadencePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PodcastShowCadencePolicy_userId_spotifyShowId_key"
  ON "PodcastShowCadencePolicy"("userId", "spotifyShowId");

CREATE INDEX "PodcastShowCadencePolicy_userId_priority_idx"
  ON "PodcastShowCadencePolicy"("userId", "priority");

ALTER TABLE "PodcastShowCadencePolicy"
  ADD CONSTRAINT "PodcastShowCadencePolicy_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PodcastShowCadencePolicy"
  ADD CONSTRAINT "PodcastShowCadencePolicy_cadence_pair_check"
  CHECK (
    ("cadenceMaxEpisodes" IS NULL AND "cadenceUnit" IS NULL)
    OR
    (
      "cadenceMaxEpisodes" IS NOT NULL
      AND "cadenceMaxEpisodes" >= 1
      AND "cadenceUnit" IS NOT NULL
    )
  );

-- Preserve every existing explicit SHOW policy before neutralizing the old
-- columns. SourcePlaylist uniqueness already guarantees at most one row per
-- (userId, SHOW, spotifyId), but ON CONFLICT keeps the migration idempotent with
-- respect to logical identity if a non-production database was hand-edited.
INSERT INTO "PodcastShowCadencePolicy" (
  "id",
  "userId",
  "spotifyShowId",
  "showName",
  "cadenceMaxEpisodes",
  "cadenceUnit",
  "priority",
  "createdAt",
  "updatedAt"
)
SELECT
  psp."sourcePlaylistId",
  sp."userId",
  sp."spotifyId",
  sp."name",
  psp."cadenceMaxEpisodes",
  psp."cadenceUnit",
  psp."priority",
  psp."createdAt",
  psp."updatedAt"
FROM "PodcastShowPolicy" psp
JOIN "SourcePlaylist" sp
  ON sp."id" = psp."sourcePlaylistId"
WHERE sp."kind" = 'PODCAST'
  AND sp."spotifyType" = 'SHOW'
ON CONFLICT ("userId", "spotifyShowId") DO UPDATE SET
  "showName" = EXCLUDED."showName",
  "cadenceMaxEpisodes" = EXCLUDED."cadenceMaxEpisodes",
  "cadenceUnit" = EXCLUDED."cadenceUnit",
  "priority" = EXCLUDED."priority",
  "updatedAt" = EXCLUDED."updatedAt";

ALTER TABLE "PodcastShowPolicy"
  DROP CONSTRAINT IF EXISTS "PodcastShowPolicy_cadence_pair_check";

UPDATE "PodcastShowPolicy"
SET
  "cadenceMaxEpisodes" = NULL,
  "cadenceUnit" = NULL,
  "priority" = 'NORMAL';

ALTER TABLE "PodcastShowPolicy"
  ADD CONSTRAINT "PodcastShowPolicy_cadence_deprecated_check"
  CHECK (
    "cadenceMaxEpisodes" IS NULL
    AND "cadenceUnit" IS NULL
    AND "priority" = 'NORMAL'
  );
