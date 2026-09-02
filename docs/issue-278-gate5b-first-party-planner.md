# Issue #278 — Gate 5B: first-party planner + provider-signal quarantine

Date: 2026-09-02

Branch: `issue-278-gate5-analytics-discovery`

Gate 5B base: Gate 5A HEAD `b11e83e1c039e9c6291bd55211aa5e5d962bb951`

## Canonical objective

Gate 5 is the issue-level step to adjust analytics/discovery so Spotify-derived behavior does not act as the Sonoriza user profile.

Gate 5A closed the productive Discovery profile/runtime boundary. Gate 5B makes the first-party preference model created in Gate 4 productive in planning and removes two remaining provider-derived preference inputs from productive planning:

1. MUSIC-05 inferred skips derived from Spotify Recently Played;
2. the productive Saved Tracks / Liked Tracks planner source.

No data is deleted in this gate.

## 1. First-party preferences now affect the planner

New module:

`src/services/music-preference/first-party-planner-preferences.ts`

Policy version:

`gate5b-first-party-planner-v1`

The generation wrapper loads `FirstPartyPlaybackPreference` rows once for the user and stores them in the per-run runtime state. `filterMusicBatchForCurrentRun()` then applies those preferences after the existing repeat filter and before planner selection.

This path uses only the explicit first-party preference table created in Gate 4. It does not derive preferences from listening history, Saved Tracks, inferred skips, ArtistAffinityState or provider metadata.

### Productive subject types in Gate 5B

Only exact `TRACK` and `ARTIST` preferences are productive in this cut.

Operational subject-key conventions:

- `TRACK`: `spotify:track:<spotifyTrackId>`
- `ARTIST`: `spotify:artist:<spotifyArtistId>`

The Spotify identifier here is an operational entity reference. It does not change the origin of the user's instruction: the instruction remains `FIRST_PARTY`. Any provider metadata associated with that entity retains its own lineage separately.

Matching is exact:

- TRACK -> `Candidate.spotifyTrackId`
- ARTIST -> `Candidate.primaryArtistId`

Gate 5B does not infer a match from title, artist display name, album name or behavioral history.

### Policy semantics

`EXCLUDED`

- evaluated for `PLANNER_ELIGIBILITY`;
- matching candidate is removed before planner selection;
- an ARTIST exclusion is a hard veto even if a TRACK preference says PREFERRED.

`PREFERRED`

- evaluated for `RECOMMENDATION`;
- candidate is promoted ahead of NORMAL candidates.

`NORMAL`

- evaluated for `RECOMMENDATION`;
- explicit TRACK=NORMAL may restore one track from an ARTIST=REDUCED preference;
- it cannot override an EXCLUDED veto.

`REDUCED`

- evaluated for `RECOMMENDATION`;
- candidate remains eligible but is ordered after NORMAL candidates.

Ordering is stable inside each preference bucket.

Every preference is evaluated through the Gate 2 lineage/capability matrix before it can affect planning. Current legitimate Gate 4 sources (`USER_EXPLICIT`, `SONORIZA_INTERACTION`) resolve to `FIRST_PARTY`, which is ALLOW for recommendation/planner eligibility. A forged provider source is rejected by the existing runtime first-party source assertion before receiving FIRST_PARTY lineage.

### Intentionally non-productive subject types

The following Gate 4 preferences remain stored but do not affect planner behavior in Gate 5B:

- `VERSION_TRAIT`
- `DISCOVERY`
- `REPEAT`

This is deliberate.

In particular, `VERSION_TRAIT=live` is not implemented by reusing MUSIC-VERSION-01's Spotify-derived catalog metadata/classifier. A later cut must define provider-neutral subject semantics before these preferences become productive.

## 2. MUSIC-05 inferred skips are quarantined from productive use

New module:

`src/services/music-preference/compliant-inferred-skips.ts`

MUSIC-05 currently derives its inference from Spotify Recently Played history. Gate 5B evaluates the source as:

`SPOTIFY_RECENTLY_PLAYED -> SPOTIFY`

For productive MUSIC-05 use it checks:

- `BEHAVIORAL_ANALYTICS`
- `USER_PROFILING`
- `RECOMMENDATION`
- `PLANNER_ELIGIBILITY`

Current Gate 2 decisions for Spotify are:

- BEHAVIORAL_ANALYTICS -> DENY
- USER_PROFILING -> DENY
- RECOMMENDATION -> DENY
- PLANNER_ELIGIBILITY -> REVIEW_REQUIRED

Therefore productive MUSIC-05 is fail-closed.

The canonical exports from `@/services/music-preference` now use the compliant wrapper:

- `analyzeAndRecordInferredSkips()` does not create new inferred-skip signals while the capability is blocked;
- `loadPendingInferredSkips()` returns empty per-target lists, so existing provider-derived signals no longer suppress tracks in productive planning.

Quarantine reason:

`COMPLIANCE_QUARANTINED_SPOTIFY_INFERRED_SKIP`

The legacy inference implementation remains available explicitly as diagnostic code:

- `analyzeAndRecordInferredSkipsLegacyDiagnostic`
- `loadPendingInferredSkipsLegacyDiagnostic`

Existing MUSIC-05 rows are not deleted or relabeled. Retention/deletion belongs to Gate 6.

## 3. Saved Tracks / Liked Tracks productive planner source is quarantined

The former SOURCE-LIKED productive pilot used locally materialized `LikedTrackPreference` rows, but those rows are ultimately derived from Spotify Saved Tracks.

Local persistence and a Sonoriza enable/disable switch do not change that lineage.

`getNativeLikedTrackSourcePreferenceState()` now requires the central capability matrix to allow both:

- `RECOMMENDATION`
- `PLANNER_ELIGIBILITY`

for:

`SPOTIFY_SAVED_TRACKS -> SPOTIFY`

Current result:

- RECOMMENDATION -> DENY
- PLANNER_ELIGIBILITY -> REVIEW_REQUIRED

Therefore the planner-facing state is forced to `enabled=false` even if the user previously enabled the Saved Tracks source.

The stored user choice is not modified. This preserves auditability and allows a future capability decision without rewriting user intent.

The configuration/read-only surface is not treated as first-party personalization merely because it is stored locally.

### Shadow caveat

The historical SOURCE-LIKED shadow/reporting path can still read locally materialized liked-track rows when its separate shadow rollout is enabled. Gate 5B removes productive planner influence, but does not claim that every legacy diagnostic/shadow metric has been removed.

That remaining analytics/reporting audit belongs to the next Gate 5 cut.

## 4. Runtime integration

`src/jobs/generate-playlists.ts`

- loads first-party playback preferences once per generation run;
- injects them into `MusicRepeatRunState`;
- stores only aggregate application evidence in `GenerationRun.summary`;
- does not log raw subject keys.

`src/jobs/music-repeat-runtime.ts`

`filterMusicBatchForCurrentRun()` now performs:

1. existing MUSIC-01 repeat filter;
2. Gate 5B first-party TRACK/ARTIST preference application;
3. handoff to planner.

The first-party application is deterministic and idempotent across incremental replans.

## 5. MUSIC-01 remains an explicit unresolved boundary

Gate 5B does **not** relabel MUSIC-01 as first-party.

The current MUSIC-01 runtime still synchronizes Spotify Recently Played and uses that state for:

- repeat-window candidate filtering;
- final pre-write repeat revalidation.

Under Gate 2, Spotify -> PLANNER_ELIGIBILITY is `REVIEW_REQUIRED`, not `ALLOW`.

Therefore Gate 5 is not complete yet. MUSIC-01 must receive an explicit compliance disposition in a later Gate 5 cut: separate operational semantics from behavioral personalization, obtain/record an allowed capability if appropriate, or quarantine the influence.

This unresolved boundary is intentionally documented rather than hidden behind the new first-party preference model.

## 6. Tests added/updated

`first-party-planner-preferences.test.ts`

Covers:

- stable PREFERRED/REDUCED ordering;
- ARTIST EXCLUDED hard veto;
- TRACK NORMAL over ARTIST REDUCED;
- VERSION_TRAIT/DISCOVERY/REPEAT non-productive behavior;
- exact provider identity matching only;
- forged provider source fail-closed.

`compliant-inferred-skips.test.ts`

Covers:

- current Spotify capability decisions;
- analysis quarantine without persistence calls;
- pending-signal quarantine without legacy reads.

`native-source-preference-compliance.test.ts`

Covers current Saved Tracks planner capability result.

`native-source-preference.test.ts`

Updated to require provenance capability in addition to rollout and persisted consent.

`music-repeat-runtime.test.ts`

Updated for the new runtime state and adds proof that an explicit TRACK=EXCLUDED preference is removed before planner selection.

## 7. Diff characteristics

Gate 5B is code/test only.

No changes to:

- Prisma schema;
- migrations;
- database data;
- Spotify OAuth scopes;
- provider synchronization jobs;
- production environment flags;
- deployment configuration.

No merge or deploy was performed.

## 8. Validation status

The final branch diff was reviewed against Gate 5A and against `main`.

At documentation time GitHub reported no Actions workflow run/status for the branch HEAD. Therefore this gate does **not** claim that the full repository suite ran remotely.

Required checkout validation before merge/deploy:

```bash
npm run test:data-policy
npm run test:music-preference
npm run test:incremental
npm run test:discovery
npm run typecheck
npm run build
```

## 9. Remaining Gate 5 work

Recommended next cut: Gate 5C.

Primary remaining audit/guards:

1. MUSIC-01 Recently Played planner eligibility/pre-write boundary;
2. legacy SOURCE-LIKED shadow/reporting analytics;
3. History surfaces that derive suggestions/ranking from provider listening history;
4. ArtistAffinity/Saved Tracks reports or consumers not already cut off from productive planning;
5. ALBUM-01 opportunity/ranking inputs;
6. remaining `Para você` / Descobrir / Álbuns surfaces;
7. VERSION_TRAIT, DISCOVERY and REPEAT first-party semantics without provider-lineage laundering.

Gate 5 remains open after 5B.
