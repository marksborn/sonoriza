-- HISTORY-04 Gate 1 hardening.
-- A Unix timestamp equal to zero renders as 31/12/1969 in America/Sao_Paulo
-- and cannot represent a real Spotify/Last.fm listening event for Sonoriza.
-- Keep legacy rows untouched for explicit diagnosis/cleanup, but prevent new
-- invalid events from entering the canonical history.

CREATE OR REPLACE FUNCTION "sonoriza_reject_nonpositive_played_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."playedAt" <= TIMESTAMPTZ '1970-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'TrackListeningEvent.playedAt must be after Unix epoch';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "TrackListeningEvent_playedAt_epoch_guard" ON "TrackListeningEvent";

CREATE TRIGGER "TrackListeningEvent_playedAt_epoch_guard"
BEFORE INSERT OR UPDATE OF "playedAt" ON "TrackListeningEvent"
FOR EACH ROW
EXECUTE FUNCTION "sonoriza_reject_nonpositive_played_at"();
