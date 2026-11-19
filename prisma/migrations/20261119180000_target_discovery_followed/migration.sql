-- DISCOVERY-FOLLOWED-01 (#564) Gate D: per-target opt-in for "Artistas que sigo".
-- Additive; default false keeps every existing target unchanged.
ALTER TABLE "TargetPlaylist" ADD COLUMN "discoveryFollowedEnabled" BOOLEAN NOT NULL DEFAULT false;
