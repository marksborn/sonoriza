# MUSIC-02 — recording evidence for alternative Spotify references

Refs #527, #35, #374, #512. This document uses synthetic examples only.

## Defect and correction

Legacy cleanup recognizes persisted `TrackListeningState` IDs and explicit
Spotify relinking aliases. A source item `source-A` is otherwise retained
even if an immutable Spotify playback event records the same recording
under `heard-B`. This consumer is distinct from the factual Last.fm
cooldown. Neither a cooldown match nor matching artist/title alone proves
authority to delete a source item.

Preview, confirmation and automatic cleanup now share
`resolvePersistedCleanupRecordingEvidence`. It keeps legacy direct-ID
decisions and additionally requires **all** of the following for cross-ID
removal eligibility:

- An existing `SPOTIFY_RECENTLY_PLAYED` event in the same user's namespace,
  with Spotify track ID and a valid non-future playback timestamp.
- The same valid, normalized ISRC; **ISRC alone is insufficient**.
- Both primary artist IDs present and equal; normalized artist names also
  equal. Covers or conflicting artist IDs cannot pass by title.
- Matching shared base-title signals and both version classes `STANDARD`.
- Positive finite durations, including the duration actually persisted in
  the playback event, within **1,000 ms**.
- No incompatible or incomplete same-ISRC event in that user's facts.

Different base-title spacing stays `REVIEW_TEXTUAL_ALIAS`; standard/remaster
and every non-standard performance/remaster stay `REVIEW_VERSION`, even with
an equal ISRC and equal class. Stripping a live venue or remaster year does
not authorize removal. Conflicts and missing metadata abstain. No Last.fm MBID is associated
with Spotify, and no text-only evidence becomes destructive authority.
This does not merge `RecordingIdentity`, reassociate provider refs, update
listening timestamps, manufacture events or change planner/cooldown rules.

Cleanup retains its existing consumed-item semantics: direct-ID historical
playback is not converted into a new six-month retention policy. Positive
recording evidence is likewise historical evidence of consumption; absence
of evidence never authorizes deletion.

## Bounded acquisition and source anchoring

Manual stable playlist reads request ISRC, artists, title and duration in
the existing item pagination response. This adds fields, not another full
playlist scan. For older caches/missing metadata, a textual shortlist may
identify source tracks worth checking; that shortlist never proves identity.

Automatic cleanup retains the complete v5 source-cache/snapshot requirement.
It does not read all playlist pages as a fallback. Source-track catalog GETs
use the existing per-user catalog cache, with **four network requests per
invocation**, and at most 100 candidate lookups including cache hits. There
are no remote searches, MusicBrainz/Last.fm calls or catalog hydration of
all historical track IDs. A later invocation may reuse successful cached
lookups. Source-cache metadata must agree with catalog metadata before a
candidate is accepted. Returned ID/URI/relinking must identify the requested
track. Cached catalog responses retain the existing 30-day TTL.

Budget exhaustion is a local `REVIEW_BUDGET` outcome that retains unresolved
items. A track 404 also retains that item. Quota, auth, timeout, cache-write
and unexpected provider failures abort preparation before any DELETE; no
provider retry/bypass is added. Catalog reads may refresh OAuth credentials,
persist operational backoff or write catalog-cache files; they are not
globally side-effect-free operations.

The history read uses one user-scoped, read-only REPEATABLE READ transaction,
bounded at 20,000 states and 20,000 qualifying events. Exceeding a bound
aborts rather than certifying a partial evidence set.

## Destructive boundary

KEEP_ALL, inbox retention, first-cleanup completion, automation opt-in,
source ownership and complete-cache requirements remain mandatory. Automatic
cleanup additionally checks that the source is still enabled. No new source
is opted in automatically.

Confirmation recomputes recording eligibility from current persisted facts
and stable source metadata, then compares the existing URI/count plan hash
and snapshot. Old previews whose plans change become stale. After enrichment
and before the first DELETE, source authorization, account permission,
provider backoff and the playlist snapshot are checked again. Every request
also observes the shared Spotify backoff. Existing snapshot-guarded batches,
audiobook write fences, post-delete verification and cache continuity remain.

No schema change, migration, environment flag or productive rollout is
introduced by this patch. Deployment must be followed by review of an actual
preview before considering manual removal. The application retains existing
automatic-source authorization; deploying this bug fix can change what a
previously opted-in automatic source recognizes on its next normal cycle.

## Operator diagnostic

```bash
npx tsx scripts/report-music-source-cleanup-recordings.ts \
  --user=<user-id> --source=<source-row-id>
```

Default catalog budget is **zero**: reuse the source cache and any existing
catalog cache only. To authorize a bounded diagnostic catalog read explicitly:

```bash
npx tsx scripts/report-music-source-cleanup-recordings.ts \
  --user=<user-id> --source=<source-row-id> \
  --catalog-budget=4 --ack-provider-reads
```

The maximum diagnostic budget is eight. The report is explicitly
`SOURCE_CACHE_DIAGNOSTIC_NOT_REMOVAL_AUTHORIZATION`: it does not verify the
current remote playlist snapshot. It writes no cleanup audit, source cache,
identity or playlist. With a positive catalog budget, operational OAuth,
backoff and catalog-cache writes remain possible. Invalid/duplicate arguments
fail before database/provider access. Keep real account IDs, source names and
report rows private; public issue/PR examples must remain synthetic.

## Verification

Pure tests cover full evidence, ISRC/text-only rejection, artist/cover/title/
duration conflicts, same-ISRC collisions, spacing/remaster/version REVIEW,
missing facts, foreign users, Last.fm-only evidence, future timestamps,
local/episode/unknown items, metadata drift, budgets and provider aborts.
Existing cleanup/zero-preview/quota-fallback, factual cooldown, strict
canonical comparator and KEEP_FILLED regressions also run.

Opt-in PostgreSQL tests (`MUSIC02_RECORDING_DB_TEST=1`) exercise real persisted
facts, source isolation, a preview without provider mutation, confirmation
staleness, successful synthetic confirmation/automatic cleanup, cache
continuity, snapshot/retention revocation during enrichment, bounded reads
and provider-error aborts. Every HTTP request is mocked; successful DELETEs
exist only inside disposable synthetic tests. The dedicated CI workflow
applies the existing schema to disposable PostgreSQL, then runs tests,
typecheck, lint and production build. Production data is never a test fixture.
