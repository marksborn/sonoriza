-- HISTORY-04 follow-up.
-- The 1970 residue is a Last.fm backfill-window exception already documented in
-- HISTORY-01, not a global TrackListeningEvent timestamp invariant. Canonical
-- consumers now enforce the authoritative Last.fm window instead.

DROP TRIGGER IF EXISTS "TrackListeningEvent_playedAt_epoch_guard" ON "TrackListeningEvent";
DROP FUNCTION IF EXISTS "sonoriza_reject_nonpositive_played_at"();
