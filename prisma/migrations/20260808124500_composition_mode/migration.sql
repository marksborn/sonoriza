CREATE TYPE "CompositionMode" AS ENUM ('PROPORTION', 'SEQUENCE');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "compositionMode" "CompositionMode" NOT NULL DEFAULT 'PROPORTION';
