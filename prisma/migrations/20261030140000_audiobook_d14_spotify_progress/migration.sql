-- AUDIOBOOK-02 D.14 (#489): chapter progress may also come from Spotify's
-- per-chapter resume_point. Additive: existing rows keep USER_DECLARED_UNVERIFIED.

ALTER TABLE "UserAudiobookLibraryReading"
  DROP CONSTRAINT "UserAudiobookLibraryReading_evidence_chk",
  ADD CONSTRAINT "UserAudiobookLibraryReading_evidence_chk"
    CHECK ("evidenceSource" IN ('USER_DECLARED_UNVERIFIED', 'SPOTIFY_RESUME_POINT'));

ALTER TABLE "UserAudiobookLibraryEntry"
  DROP CONSTRAINT "UserAudiobookLibraryEntry_evidence_chk",
  ADD CONSTRAINT "UserAudiobookLibraryEntry_evidence_chk"
    CHECK ("evidenceSource" IN ('USER_DECLARED_UNVERIFIED', 'SPOTIFY_RESUME_POINT'));
