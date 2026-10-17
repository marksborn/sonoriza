-- D.10: additive, user-declared /show/ reference only (not Spotify catalogue evidence).
-- Legacy notebooks and archives remain unchanged (NULL means not recorded).
ALTER TABLE "TargetAudiobookManualNotebook" ADD COLUMN "spotifyShowId" VARCHAR(22);
ALTER TABLE "TargetAudiobookManualEntry" ADD COLUMN "spotifyShowId" VARCHAR(22);
ALTER TABLE "UserAudiobookCompletedReading" ADD COLUMN "spotifyShowId" VARCHAR(22);
ALTER TABLE "UserAudiobookCompletedChapter" ADD COLUMN "spotifyShowId" VARCHAR(22);

ALTER TABLE "TargetAudiobookManualNotebook" ADD CONSTRAINT "TargetAudiobookManualNotebook_show_id_chk"
  CHECK ("spotifyShowId" IS NULL OR "spotifyShowId" ~ '^[[:alnum:]]{22}$');
ALTER TABLE "TargetAudiobookManualEntry" ADD CONSTRAINT "TargetAudiobookManualEntry_show_id_chk"
  CHECK ("spotifyShowId" IS NULL OR "spotifyShowId" ~ '^[[:alnum:]]{22}$');
ALTER TABLE "UserAudiobookCompletedReading" ADD CONSTRAINT "UserAudiobookCompletedReading_show_id_chk"
  CHECK ("spotifyShowId" IS NULL OR "spotifyShowId" ~ '^[[:alnum:]]{22}$');
ALTER TABLE "UserAudiobookCompletedChapter" ADD CONSTRAINT "UserAudiobookCompletedChapter_show_id_chk"
  CHECK ("spotifyShowId" IS NULL OR "spotifyShowId" ~ '^[[:alnum:]]{22}$');
