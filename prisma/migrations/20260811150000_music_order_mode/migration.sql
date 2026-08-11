-- ORDER-01: explicit per-destination music ordering policy.
CREATE TYPE "MusicOrderMode" AS ENUM ('STANDARD', 'RANDOMIZED');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "musicOrderMode" "MusicOrderMode" NOT NULL DEFAULT 'STANDARD';
