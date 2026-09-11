CREATE TYPE "GlobalTargetSharingPolicy" AS ENUM ('EXCLUSIVE', 'SHAREABLE');

ALTER TABLE "User"
ADD COLUMN "defaultTargetSharingPolicy" "GlobalTargetSharingPolicy"
NOT NULL DEFAULT 'EXCLUSIVE';
