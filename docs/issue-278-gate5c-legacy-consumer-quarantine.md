# Issue #278 — Gate 5C: legacy consumer quarantine

Date: 2026-09-02

Branch: `issue-278-gate5-analytics-discovery`

Gate 5C base: Gate 5B HEAD `6f11c582b17c7e11b16a2661181fddb87041b972`

Implementation HEAD before this documentation commit: `5c6f3f3b24b0e6a1260273aeb7e4901d77a9bb8b`

## Canonical objective

Gate 5 is the issue-level step to adjust analytics/discovery so Spotify-derived behavior does not act as the Sonoriza user profile.

Gate 5A closed the productive DISCOVERY profile/runtime boundary.

Gate 5B made explicit first-party TRACK/ARTIST preferences productive in the planner and quarantined two provider-derived productive inputs: inferred skips and Saved Tracks as a planner source.

Gate 5C closes the remaining legacy consumers and writers that could still turn Spotify-origin data into:

- planner eligibility;
- behavioral analytics;
- user profiling;
- recommendation/ranking;
- Saved Tracks-derived `ArtistAffinityState` materialization.

No provider-derived rows are deleted or relabeled in this gate. Existing data is quarantined at use boundaries.

## 1. Central legacy-consumer capability guard

New module:

`src/services/data-policy/legacy-consumer-policy.ts`

The module reuses Gate 2 `DataLineage`, `RootDataSource`, `PolicyUse` and `policyDecisionForLineage()`.

A use is productive only when **every required capability is `ALLOW`**. `REVIEW_REQUIRED` is treated as blocked, not as implicit permission.

Current guarded source/use combinations include:

### MUSIC-01 / Recently Played

Source:

`SPOTIFY_RECENTLY_PLAYED -> SPOTIFY`

Required uses:

- `OPERATIONAL_PLANNING`
- `PLANNER_ELIGIBILITY`

Current result: blocked (`REVIEW_REQUIRED`).

### Saved Tracks shadow analytics

Source:

`SPOTIFY_SAVED_TRACKS -> SPOTIFY`

Required use:

- `BEHAVIORAL_ANALYTICS`

Current result: blocked (`DENY`).

### Saved Tracks planner

Required uses:

- `OPERATIONAL_PLANNING`
- `PLANNER_ELIGIBILITY`

Current result: blocked (`REVIEW_REQUIRED`).

### Saved Tracks recommendation / liked-discovery

Required uses:

- `BEHAVIORAL_ANALYTICS`
- `USER_PROFILING`
- `RECOMMENDATION`

Current result: blocked (`DENY`).

### Saved Tracks -> ArtistAffinity/profile materialization

Required uses:

- `BEHAVIORAL_ANALYTICS`
- `USER_PROFILING`

Current result: blocked (`DENY`).

A specific fail-closed assertion was added:

`assertSpotifySavedTracksProfileMaterializationAllowed()`

Blocked calls throw `SavedTracksProfileMaterializationPolicyError` with code:

`DATA_POLICY_SAVED_TRACKS_PROFILE_MATERIALIZATION_BLOCKED`

### History SQL aggregates

For behavioral/recommendation aggregation, Gate 5C uses an explicit source allowlist in addition to the capability matrix.

Current allowlist:

`SQL_AGGREGATE_LINEAGE_SAFE_LISTENING_EVENT_SOURCES = []`

This is deliberate. Current `ListeningEventSource` values are provider/import sources and mixed lineage can also be carried in JSON metadata. Therefore no current history source is admitted into behavioral SQL aggregation by default.

A future first-party listening-event source must be added explicitly only after its metadata contract proves that provider enrichment cannot be laundered into the aggregate.

## 2. MUSIC-01 — Recently Played removed from productive planner eligibility

Gate 1 identified the problematic flow:

`Spotify Recently Played -> TrackListeningState.lastPlayedAt -> cooldown -> planner eligibility`

`TrackListeningState` has no source field, so provenance was lost after projection.

Gate 5C does not relabel this state as first-party and does not invent an operational exception.

The generation/runtime boundary now evaluates `spotifyRecentlyPlayedPlannerCapability()` before the MUSIC-01 synchronization/filtering path can influence planning.

While the current decision is not `ALLOW`:

- generation does not refresh Recently Played for MUSIC-01 planner use;
- the runtime repeat context is non-authoritative for provider-derived blocking;
- candidate filtering does not remove tracks due to Spotify Recently Played cooldown;
- final pre-write revalidation does not veto/replan against that provider-derived cooldown.

The legacy MUSIC-01 implementation remains available behind the capability boundary for a future explicit policy decision.

No existing `TrackListeningState` or `TrackListeningEvent` row is deleted.

## 3. HISTORY-04 — display remains; behavioral aggregates are quarantined

Gate 5C separates historical display/explorer behavior from behavioral analytics.

### Statistics and rankings

`getListeningHistoryStats()` no longer lets current provider-origin `TrackListeningEvent` rows enter top-track/top-artist/top-album/time-listened SQL aggregation under the current matrix.

The source decision is made **before aggregation**, not after a profile or ranking has already been computed.

This avoids the invalid pattern:

`provider rows -> aggregate/profile -> final filter`

The intended pattern is now:

`source/lineage -> capability -> admitted rows -> aggregate`

### General history analytics

`getListeningHistorySummary()` and `getTrackListeningStats()` are similarly separated from provider-derived behavioral aggregation.

Operational/backfill status and raw explorer/display remain separate concerns and are not deleted by this gate.

### Probable-like

`getProbableLikeShadow()` previously built a recommendation from:

- Spotify listening frequency/recency;
- Spotify Extended History completion/skip evidence;
- Recently Played sequence inference;
- Saved Tracks state;
- inferred skip signals.

Gate 5C now blocks the runtime before those behavioral reads/aggregations occur.

The pure ranking function remains for deterministic diagnostic tests, but the production data-acquisition path cannot create a provider-derived probable-like ranking under the current capability matrix.

### Probable-like pilot feedback

The pilot feedback path cannot materialize feedback against a candidate that exists only because the blocked provider-derived recommendation ran. Candidate validation therefore fails closed with the ranking boundary.

Existing pilot feedback rows are not deleted.

## 4. SOURCE-LIKED — shadow and planner paths fully quarantined

Gate 5B had already forced the productive Saved Tracks planner source off.

Gate 5C closes the remaining shadow/reporting route.

The generation collector checks the Saved Tracks shadow capability **before** calling `prepareLikedTrackSourceShadowForCurrentRun()`.

Under the current policy:

- no `LikedTrackPreference` read is made for that shadow path;
- no 5/10/20 exposure comparison is calculated;
- no shadow planner run is created from Saved Tracks;
- no Saved Tracks candidate influences the authoritative plan.

A deterministic runtime compliance test records this boundary.

Legacy pure shadow/arbitration functions remain in the repository for historical tests/diagnostics, but the generation runtime does not invoke them while capability is blocked.

## 5. Saved Tracks / ArtistAffinity writers are quarantined

Blocking consumers alone was insufficient because two background paths could continue creating/updating the provider-derived profile:

1. incremental Saved Tracks sync;
2. full Saved Tracks reconciliation.

Gate 5C closes both at two levels.

### Layer A — cron/job boundary

`src/jobs/liked-track-incremental-sync.ts`

Policy version becomes:

`source-liked-gate5c-v1`

Activation rule:

`SOURCE_CAPABILITY_AND_MASTER_FLAG_AND_USER_ALLOWLIST`

When the current Saved Tracks profile-materialization capability is blocked, the job returns before:

- user enumeration;
- provider token access;
- provider calls;
- local affinity writes.

The old master flag + user allowlist rules are preserved behind the capability check. If capability is explicitly allowed in the future, rollout still remains fail-closed by those controls.

`src/jobs/liked-track-reconciliation.ts`

Uses the same ordering and policy principle for the full scan.

### Layer B — service boundary

`syncLikedTrackIncremental()` calls:

`assertSpotifySavedTracksProfileMaterializationAllowed()`

before reading existing affinity state, access tokens or Spotify.

`reconcileLikedTracks()` does the same before reading local state or performing the full provider scan.

This prevents a manual/direct service invocation from bypassing the cron policy.

Both `PREVIEW` and `APPLY` are blocked because computing an ArtistAffinity/profile delta from Saved Tracks is itself behavioral profiling/analytics even when persistence is disabled.

Low-level provider parsing/inventory helpers remain independently testable and are not reclassified as first-party profile use.

## 6. Liked-discovery / ArtistAffinity recommendation pilot

The legacy liked-discovery pilot uses Saved Tracks / affinity-derived seeds and can reach external discovery/catalog resolution.

Gate 5C adds `SOURCE_CAPABILITY_BLOCKED` to the pilot policy.

Before expansion, calibration or Spotify catalog resolution, the runtime requires Saved Tracks to be allowed for:

- `BEHAVIORAL_ANALYTICS`;
- `USER_PROFILING`;
- `RECOMMENDATION`.

Current result is blocked.

Feature flags and target/user allowlists cannot override the data-policy decision.

The existing rollout controls remain relevant only after the source capability becomes explicitly allowed.

## 7. ALBUM-01 — ranking and stale snapshots quarantined

ALBUM-01 combines behavioral Discovery information with Spotify catalog data to rank album opportunities.

Gate 5C requires the Spotify catalog recommendation capability before opening the report path.

Current:

`SPOTIFY_CATALOG -> RECOMMENDATION = DENY`

Therefore:

- report computation stops before creating Spotify catalog/search clients;
- no new album-opportunity ranking is produced;
- snapshot refresh does not repeatedly attempt a blocked recommendation computation;
- previously persisted ranking snapshots are not exposed as current recommendation output while capability remains blocked.

The explicit album queue/memory chosen by the user remains a separate operational/user-action path and is not deleted.

## 8. First-party behavior preserved

Gate 5C does not roll back Gate 5B first-party personalization.

`FirstPartyPlaybackPreference` TRACK/ARTIST rules remain the valid productive personalization path:

- user instruction origin remains `FIRST_PARTY`;
- Gate 2 allows FIRST_PARTY for recommendation/planner eligibility;
- exact provider IDs may still be used as operational entity references without changing the origin of the user instruction;
- any provider metadata combined later must retain/merge its own lineage.

No provider-derived Saved Tracks, Recently Played, inferred skip, history ranking or ArtistAffinity row is promoted to FIRST_PARTY.

## 9. Tests added/adjusted in Gate 5C

Gate 5C adds or updates tests covering:

- central legacy capability decisions;
- Spotify Recently Played not productively authorized for MUSIC-01 planner use;
- Saved Tracks blocked for shadow, planner, recommendation and profile materialization;
- `SavedTracksProfileMaterializationPolicyError` fail-closed assertion;
- mixed Last.fm + Spotify-enriched history cannot launder into recommendation;
- no current listening-event source admitted to history behavioral SQL aggregation;
- MUSIC-01 no longer filters/revalidates against provider-derived cooldown while blocked;
- Saved Tracks shadow not prepared by generation runtime while blocked;
- history aggregate/probable-like runtime abstention;
- ALBUM-01 report/snapshot capability boundary;
- liked-discovery pilot `SOURCE_CAPABILITY_BLOCKED` behavior;
- incremental Saved Tracks cron blocked before legacy rollout controls;
- reconciliation cron blocked before legacy rollout controls;
- direct incremental affinity service rejected before local/provider reads;
- direct reconciliation service rejected before local/provider reads.

Legacy pure-function tests are intentionally retained where they still document historical algorithms. They do not prove that the current production runtime is allowed to invoke those algorithms.

## 10. Diff characteristics

Compared with Gate 5B HEAD `6f11c582b17c7e11b16a2661181fddb87041b972`, the implementation cut changes runtime/test files across:

- generation/incremental planning;
- MUSIC-01 repeat runtime;
- Saved Tracks shadow/runtime;
- Saved Tracks incremental/reconciliation jobs;
- Saved Tracks incremental/reconciliation services;
- listening-history analytics/stats/probable-like;
- liked-discovery pilot;
- ALBUM-01 report/snapshot;
- central data-policy guard.

No Gate 5C changes to:

- Prisma schema;
- Prisma migrations;
- database data;
- Spotify OAuth scopes;
- package dependencies;
- provider credentials;
- production environment flags;
- deployment configuration.

No merge or deploy was performed.

## 11. Validation status

GitHub compare confirms the Gate 5C branch remains directly ahead of Gate 5B with the Gate 5B commit as merge base, and remains 0 behind the current `main` base used by this gate stack.

GitHub reported no Actions workflow run for implementation HEAD `5c6f3f3b24b0e6a1260273aeb7e4901d77a9bb8b`.

Therefore Gate 5C does **not** claim that the complete repository test suite/build ran remotely.

Required checkout validation before merge/deploy:

```bash
npm run test:data-policy
npm run test:music-preference
npm run test:incremental
npm run test:discovery
npm run typecheck
npm run build
```

Because this Gate changes no schema, no Prisma migration should be applied as part of Gate 5C validation.

## 12. Gate 5 status after 5C

Gate 5C closes the known legacy music analytics/discovery/profile boundaries identified for this cut:

- DISCOVERY behavioral profile — Gate 5A;
- first-party planner path — Gate 5B;
- inferred skips — Gate 5B;
- Saved Tracks productive planner source — Gate 5B;
- MUSIC-01 Recently Played planner influence — Gate 5C;
- HISTORY behavioral aggregates/probable-like — Gate 5C;
- Saved Tracks shadow/reporting — Gate 5C;
- Saved Tracks -> ArtistAffinity automatic writers — Gate 5C;
- liked-discovery provider-derived recommendation — Gate 5C;
- ALBUM-01 provider-derived opportunity ranking/snapshots — Gate 5C.

Remaining provider boundaries from the broader #278 inventory, especially podcast playback-state/elegibility and retention/deletion/scopes, belong to later canonical gates rather than reopening the music analytics cut.

Gate 6 is not started by this document.
