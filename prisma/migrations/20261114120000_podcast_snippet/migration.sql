-- PODCAST-SNIPPET (#559): additive only. Every destination starts unchecked,
-- and the flag has no effect until PODCAST_SNIPPET_MODE=ACTIVE.
ALTER TABLE "TargetPlaylist"
  ADD COLUMN "allowPodcastSnippets" BOOLEAN NOT NULL DEFAULT false;

-- Composition position of a generated item; NULL means "same as contentType".
ALTER TABLE "GenerationItem"
  ADD COLUMN "compositionRole" "ContentType";
