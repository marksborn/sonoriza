# Issue #278 — Gate 5A — analytics/discovery runtime quarantine

Date: 2026-09-02

Branch: `issue-278-gate5-analytics-discovery`

Base: `d2e8fb285d28998a0c18c99799968115658373f2` (`main`, Gates 2–4 deployed)

## Canonical Gate 5 objective

Issue #278 defines Gate 5 as:

> ajustar analytics/discovery

The full Gate 5 is broader than one safe code cut. This document records the first productive cut, **Gate 5A**, which closes the active DISCOVERY runtime paths that were still able to consume provider-derived listening behavior before aggregation or recommendation.

Gate 5 overall remains in progress after this cut.

## Why Gate 5A exists

Gate 1 found multiple active paths where provider-derived behavior could influence DISCOVERY:

1. the COMPLETE runtime profile aggregated all `TrackListeningEvent` rows;
2. a Last.fm canonical event could be enriched by Spotify Extended History while retaining `source=LASTFM_SCROBBLE`;
3. `MusicPreferenceSignal(INFERRED_SKIP)` is currently inferred from Spotify Recently Played;
4. `TrackListeningState` has no provenance and is updated by Spotify Recently Played;
5. `getDiscoveryTrackIdentityEvidence()` reduced all listening events into ISRC / primary-artist identity evidence used by scoring;
6. Gate 5H built a behavioral profile, called Last.fm similarity, resolved candidates through Spotify and could merge the Saved-Tracks/ArtistAffinity pilot.

Filtering only a final score, or only checking `TrackListeningEvent.source`, would therefore be insufficient.

## Gate 2 policy used by this cut

Productive DISCOVERY profile input must be `ALLOW` for all three capabilities:

- `BEHAVIORAL_ANALYTICS`
- `USER_PROFILING`
- `RECOMMENDATION`

`REVIEW_REQUIRED` is not treated as permission.

With the current Gate 2 matrix:

- `FIRST_PARTY` → allowed for these three uses;
- `SPOTIFY` → denied;
- `LASTFM` → review required, therefore quarantined;
- `USER_IMPORT` → review required, therefore quarantined;
- `UNKNOWN` → denied.

This is a conservative technical baseline, not a legal conclusion.

## 1. Central discovery-profile policy

Added:

- `src/services/data-policy/discovery-profile-policy.ts`
- `src/services/data-policy/discovery-profile-policy.test.ts`

`DISCOVERY_PROFILE_POLICY_USES` is intentionally fixed to the three productive uses above.

### Event lineage

`lineageForDiscoveryListeningEvent()` combines:

1. the origin mapped from `ListeningEventSource`; and
2. Spotify lineage whenever `metadata.spotifyExtendedHistory` is present.

The presence of the metadata key is enough to retain provenance even when the nested value is malformed. A malformed shape must not become a laundering path.

The projected PERF-01 loader can pass `spotifyExtendedHistoryPresent=true` when the original JSON object does not cross the SQL boundary.

### Mixed lineage example

A canonical row with:

- `source=LASTFM_SCROBBLE`
- `metadata.spotifyExtendedHistory=...`

resolves to mixed lineage containing both `LASTFM` and `SPOTIFY`.

The most restrictive Gate 2 decision wins, so the row is denied for productive DISCOVERY profiling/recommendation.

## 2. Pre-aggregation Prisma boundary

Added:

- `src/services/data-policy/discovery-profile-policy-client.ts`
- `src/services/data-policy/discovery-profile-policy-client.test.ts`

The productive COMPLETE profile receives a narrow Prisma-shaped client through `createCompliantDiscoveryProfileClient()`.

### TrackListeningEvent

The PERF-01 projected history SQL is intercepted before the canonical aggregator receives rows.

Each physical DB page is evaluated by provenance/capability before it can enter the profile.

The adapter continues scanning physical pages when an entire page is blocked. This matters because filtering one 2k page down to zero must not be mistaken for end-of-history.

No provider-derived row is aggregated first and removed later.

### INFERRED_SKIP quarantine

The compliant client returns no `MusicPreferenceSignal(INFERRED_SKIP)` rows.

Reason: the current signal is inferred from Spotify Recently Played and does not carry a typed origin field that could independently prove an allowed lineage.

The existing rows are not deleted or rewritten.

### TrackListeningState quarantine

The compliant client returns no `TrackListeningState` rows.

Reason: the aggregate model has no provenance and Gate 1 proved Spotify Recently Played updates `lastPlayedAt` used by MUSIC-01 cooldown/reconciliation.

The state remains stored for non-compliant/legacy investigation, but it does not cross the Gate 5A productive profile boundary.

### Last.fm coverage metadata

The compliant client withholds `lastFmBackfillRun` coverage metadata from the productive profile while Last.fm remains `REVIEW_REQUIRED`.

## 3. Productive COMPLETE runtime wired to the boundary

Modified:

- `src/services/music-discovery/complete-profile.ts`

`getCompleteMusicDiscoveryProfile()` now wraps its caller/default Prisma client with `createCompliantDiscoveryProfileClient()` before invoking the projected retained profile loader.

This is the path used by `src/jobs/discovery-runtime.ts` for productive discovery scoring.

The canonical aggregation/scoring algorithm itself is not relabeled as compliant; the change is at the input boundary.

## 4. Historical identity reducer quarantined

Modified:

- `src/services/music-discovery/track-identity.ts`
- `src/services/music-discovery/track-identity.test.ts`

The previous runtime loader reduced all `TrackListeningEvent` rows into:

- ISRC evidence;
- primary Spotify artist identity;
- identity conflict flags.

Those values were consumed by discovery scoring independently of the COMPLETE profile, creating a second behavioral-history route.

`getDiscoveryTrackIdentityEvidence()` now fails closed by returning an empty evidence set without querying `TrackListeningEvent`.

The pure `buildDiscoveryTrackIdentityEvidence()` reducer remains available for deterministic tests and a future explicitly eligible source.

## 5. External Discovery / Gate 5H hard abstention

Modified:

- `src/services/music-discovery/external-discovery-runtime.ts`
- added `src/services/music-discovery/external-discovery-runtime-policy.test.ts`

The previous productive entry point could:

1. build a behavioral profile from listening history;
2. build Last.fm artist/track seeds;
3. call Last.fm similarity;
4. inspect known listening history;
5. resolve candidates through Spotify catalog search;
6. return recommendation candidates;
7. subsequently allow the runtime caller to merge the Saved-Tracks/ArtistAffinity pilot.

Under the current Gate 2 matrix this path has no approved capability combination.

`resolveRuntimeExternalDiscovery()` now throws `DiscoveryExternalDataPolicyError` immediately, with code:

`DATA_POLICY_DISCOVERY_EXTERNAL_BLOCKED`

It does so before:

- loading a behavioral profile;
- reading listening history;
- reading Saved-Tracks affinity;
- calling Last.fm;
- calling Spotify catalog resolution.

The existing `discovery-runtime.ts` already catches acquisition errors and abstains while keeping the existing plan. Because it returns from that catch path, the Saved-Tracks/ArtistAffinity pilot is not invoked either.

Pure external-discovery/scoring modules remain in the repository for tests and future capability review; the productive runtime entry point is the hard boundary.

## 6. Current productive behavior after Gate 5A

The current `TrackListeningEvent` enum has no first-party event source.

Therefore, under the current policy matrix, the compliant historical profile can legitimately contain zero behavioral history rows.

This is intentional fail-closed behavior, not a data-loss operation.

Provider history remains stored; it is simply not eligible to influence the productive DISCOVERY profile/recommendation path.

The base source universe and existing operational planner remain separate from this behavioral-profile quarantine. Gate 5B must explicitly determine how first-party preferences replace the removed personalization signals and whether any remaining source/catalog use requires additional capability gating.

## 7. First-party path remains available

Gate 4 introduced `FirstPartyPlaybackPreference` with origins:

- `USER_EXPLICIT`
- `SONORIZA_INTERACTION`

Pure `FIRST_PARTY` lineage is `ALLOW` for the three Gate 5A profile uses.

Gate 5A tests lock this fact, but **does not yet wire preference semantics into scoring**. That wiring belongs to the next Gate 5 cut so that preference meaning (`ARTIST`, `VERSION_TRAIT`, `DISCOVERY`, `REPEAT`, etc.) is not mixed with provenance mechanics.

## Tests added/changed

### Data-policy

New tests cover:

- exact required capability set;
- Spotify denial before aggregation;
- Last.fm review-required quarantine;
- user-import quarantine;
- mixed Last.fm + Spotify lineage;
- projected Extended History lineage preservation;
- malformed Extended History marker preserving Spotify provenance;
- unknown source fail-closed;
- pure first-party lineage allowed for non-AI discovery personalization;
- restricted auxiliary delegates never being called;
- physical pagination continuing through a fully blocked page;
- mixed projected lineage blocked before aggregation;
- unrelated raw queries forwarded unchanged.

### Music-discovery

Changed/added tests cover:

- runtime historical identity loader does not query provider history;
- external discovery runtime raises the data-policy boundary before provider/profile acquisition.

The existing `test:data-policy` and `test:discovery` package globs include these new tests.

## Validation performed in the implementation environment

Performed:

- GitHub compare against `main`;
- branch confirmed based on deployed Gate 4 SHA;
- isolated strict TypeScript compile of the new discovery policy/client contract against Gate 2-compatible interfaces;
- isolated strict TypeScript compile of the new external-runtime boundary and identity-loader shape.

Not executed in the connector environment:

- `npm run test:data-policy`
- `npm run test:discovery`
- `npm run typecheck`
- `npm run build`

These must be executed on the Sonoriza server/worktree before merge/deploy, as done for Gate 4.

## Schema / migration

Gate 5A makes no Prisma schema change and adds no migration.

No stored listening-history, Saved Tracks, affinity, inferred-skip or TrackListeningState row is deleted or rewritten.

## Explicit non-goals of Gate 5A

Not completed in this cut:

- wiring Gate 4 first-party preferences into discovery scoring;
- changing the first-party preference UI/API;
- deleting or backfilling provider-derived history;
- changing Spotify OAuth scopes;
- changing Spotify writes/playlists;
- changing MUSIC-05 inference production/storage;
- fixing provenance inside `TrackListeningState` itself;
- changing the legacy `getMusicDiscoveryProfile()` diagnostic loader and all historical CLI reports;
- HISTORY-04 probable-like behavior;
- ALBUM-01 affinity/profile consumers;
- `Para você` / `Descobrir` surface semantics;
- retention/deletion policy;
- AI enablement.

## Next: Gate 5B

Gate 5B should continue the same canonical Gate 5 with two goals:

1. make explicit Sonoriza first-party preferences the usable personalization input for discovery; and
2. audit/guard remaining analytics surfaces and diagnostics that still directly consume provider-derived history/affinity.

Priority consumers:

- first-party `ARTIST`, `VERSION_TRAIT`, `DISCOVERY`, `REPEAT` preferences;
- legacy `getMusicDiscoveryProfile()` / discovery report CLIs;
- HISTORY probable-like;
- Saved Tracks / `ArtistAffinityState` consumers;
- ALBUM-01 profile/ranking;
- `Descobrir`, `Álbuns`, `Para você` surfaces;
- MUSIC-05 / MUSIC-01 planner eligibility where provenance is still absent or Spotify-derived.

Gate 5 overall remains open until those remaining consumers are reconciled.
