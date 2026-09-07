-- PODCAST-06 Gate 1 — cadence + priority configuration only.
-- No planner/runtime behavior is enabled by this migration.

CREATE TYPE "PodcastCadenceUnit" AS ENUM ('DAY', 'WEEK', 'MONTH');
CREATE TYPE "PodcastShowPriority" AS ENUM ('NORMAL', 'PRIORITY');

ALTER TABLE "PodcastShowPolicy"
  ADD COLUMN "cadenceMaxEpisodes" INTEGER,
  ADD COLUMN "cadenceUnit" "PodcastCadenceUnit",
  ADD COLUMN "priority" "PodcastShowPriority" NOT NULL DEFAULT 'NORMAL';

ALTER TABLE "PodcastShowPolicy"
  ADD CONSTRAINT "PodcastShowPolicy_cadence_pair_check"
  CHECK (
    ("cadenceMaxEpisodes" IS NULL AND "cadenceUnit" IS NULL)
    OR
    (
      "cadenceMaxEpisodes" IS NOT NULL
      AND "cadenceMaxEpisodes" >= 1
      AND "cadenceUnit" IS NOT NULL
    )
  );
