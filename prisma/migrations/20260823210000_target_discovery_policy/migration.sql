-- DISCOVER-DEST-01 Gate 2: persist discovery policy independently per destination.
CREATE TYPE "TargetDiscoveryIntensity" AS ENUM ('CONSERVATIVE', 'BALANCED', 'EXPLORATORY');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "discoveryEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "discoveryFamiliarEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "discoveryRediscoveryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "discoveryNoveltyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "discoveryReleasesEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "discoveryIntensity" "TargetDiscoveryIntensity" NOT NULL DEFAULT 'BALANCED';
