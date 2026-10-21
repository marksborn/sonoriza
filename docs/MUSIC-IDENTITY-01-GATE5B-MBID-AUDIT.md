# MUSIC-IDENTITY-01 Gate 5B — Last.fm MBID overlap audit (review only)

## Why

Gate 5A (#516) showed that `LastFM_SCROBBLE` historical events are
persisted with `spotifyTrackId = null` and `isrc = null`. Some Last.fm
events retain `trackMbid`, while `TrackProviderRef` also has an optional
`trackMbid`. Overlapping MBIDs can be measured **without pretending they
are proven Spotify links**.

This gate **does not enrich, link, merge, or write** any RecordingIdentity
or TrackProviderRef. It also does not change cooldown, KEEP_FILLED, generation,
Reserve, Spotify playlist content, flags, or user consent.

## Read-only command (after separate approval, merge and deployment)

```bash
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br
npx tsx scripts/report-music-identity-gate5b-mbid-shadow.ts --user=<userId> --target=<targetPlaylistId> --json
```

No `--apply` or `--write` option exists. The CLI rejects unknown flags.
The report operates inside a REPEATABLE READ PostgreSQL transaction with
`SET TRANSACTION READ ONLY`.

- Target and source: target owned by specified user and its latest successful
  real GenerationRun. It is a **historical snapshot**, not the current Spotify
  playlist or a fresh provider read.
- Window: the persisted MusicPlaybackPolicy window ending at generation start.
- Scrobbles: only local `LASTFM_SCROBBLE` events already imported before that
  generation. The current live Last.fm observation is *not* represented;
  incomplete history means missing matches are not evidence of no plays.
- Provider refs: user-scoped Spotify/global TrackProviderRefs for the generation
  items, followed by a case-insensitive query for **all owner refs** with
  matching MBIDs in that same provider namespace to detect collisions.
- Limits: 1,000 music items, 20,000 local scrobbles, 3,000 matching owner refs.
  Any exceeded limit forces an abstention rather than partial coverage.
- Only canonical UUID-format `trackMbid` values are accepted for overlap.
  MBID is not silently recast as Spotify ID, ISRC or permission to merge.
- Bounded report samples: max 12 matching items. This data should be handled
  as user-private listening history.

## Decision semantics

All returned decisions have `eligibleForProductiveCooldown = false` and
`inferredRecordingEquivalence = false`.

- `ABSTAIN_PROVIDER_MBID_MISSING`: target ref lacks valid MBID.
- `ABSTAIN_NO_SCROBBLE_MBID_MATCH`: no imported scrobble with matching valid MBID.
- `ABSTAIN_MBID_RECORDING_COLLISION`: the MBID maps to zero or multiple
  RecordingIdentity owners in the user/provider namespace, or the candidate is
  not among those owners.
- `ABSTAIN_ARTIST_CONFLICT`: any matching-MBID Last.fm observation disagrees
  with the item's artist, including a possible cover.
- `ABSTAIN_TITLE_CONFLICT`: base-title evidence differs. Derived base title
  is **review-only text** and can never establish identity by itself.
- `ABSTAIN_VERSION_CONFLICT`: live, acoustic, remix, demo or other incompatible
  version traits; no studio/live merger.
- `ABSTAIN_METADATA_INCOMPLETE`: insufficient title, artist, or version.
- `REVIEW_MBID_SAME_VERSION`: MBID and essential text metadata overlap,
  canonical provider MBID ownership is unambiguous. **Still not proof.**
- `REVIEW_MBID_REMASTER_STANDARD`: same MBID and compatible metadata, but
  candidate/scrobble differ between standard/remaster. Review only, not a
  hard cooldown or automatic RecordingIdentity fusion.

The classifier is conservative if any of several matching-MBID scrobbles
conflicts. `Live Forever` is not considered a live performance by token alone.

## Acceptance

1. Pure tests: same-version, original/remaster, live/studio, acoustic/remix/demo,
   cover, mismatched base title, conflicting/absent MBID owners, malformed
   UUID, repeated contradictory scrobbles, and missing metadata.
2. Typecheck and Next.js build green.
3. Review read-only coverage on a narrowly selected target after separate
   approval to deploy. A report with zero matches must not drive production
   behavior.
4. If data shows useful MBID overlap, define Gate 5C for independent evidence
   of artist identity, provider recording, duration and provenance. Do not
   update the canonical graph based only on the MBID overlap audit.

## Dependencies / rollout rules

PR #517 must be based on **PR #516** until Gate 5A merges; this is a stacked
PR, not an invitation to merge #516 implicitly. No merge/deploy or extension
of existing canonical canary is authorized by a passing CI run.

Refs #374, #512, #278, #200, #442.
