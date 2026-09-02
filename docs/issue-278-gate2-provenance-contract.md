# Issue #278 — Gate 2 provenance/capability contract

**SPOTIFY-COMPLIANCE-01 — separar Spotify de analytics derivados, perfis e IA**

- Date: 2026-09-02
- Base: `main@46ceedacb9f216fdf94eab9ac8ac51f450d8e03b`
- Branch: `issue-278-gate2-provenance-contract`
- Scope: central contract + exhaustive source mapping + regression tests
- Runtime behavior change: **none**
- Prisma schema/migration: **none**
- Spotify calls/writes: **none**
- Planner/discovery scoring change: **none**
- OAuth scope change: **none**

> This gate establishes a technical policy vocabulary and propagation rule. It is not a legal conclusion and does not activate/deactivate product features by itself.

---

## 1. Contract

### `DataOrigin`

```text
FIRST_PARTY
SPOTIFY
LASTFM
OTHER_PROVIDER
USER_IMPORT
UNKNOWN
```

`DataOrigin` is intentionally coarse. Provider-specific/source-specific detail remains represented by the source/event models; this enum answers the policy question “which rights boundary contributed to this value?”.

### `RootDataSource`

Current/future root evidence is mapped explicitly:

```text
USER_EXPLICIT                  -> FIRST_PARTY
SONORIZA_INTERACTION           -> FIRST_PARTY
SPOTIFY_RECENTLY_PLAYED        -> SPOTIFY
SPOTIFY_EXTENDED_HISTORY       -> SPOTIFY
SPOTIFY_SAVED_TRACKS           -> SPOTIFY
SPOTIFY_PODCAST_PLAYBACK_STATE -> SPOTIFY
SPOTIFY_CATALOG                -> SPOTIFY
LASTFM_SCROBBLE                -> LASTFM
LASTFM_CATALOG                 -> LASTFM
USER_IMPORT                    -> USER_IMPORT
OTHER_PROVIDER                 -> OTHER_PROVIDER
UNKNOWN                        -> UNKNOWN
```

This is not a replacement for provider/source enums. It is a policy projection.

### `PolicyUse`

```text
DISPLAY
OPERATIONAL_PLANNING
BEHAVIORAL_ANALYTICS
USER_PROFILING
RECOMMENDATION
PLANNER_ELIGIBILITY
AI
EXTERNAL_EXPORT
```

The separation between `OPERATIONAL_PLANNING` and `PLANNER_ELIGIBILITY` is deliberate:

- operational planning can include provider data necessary to carry out a reviewed provider operation;
- planner eligibility is the stronger act of using evidence to include/exclude/rank content.

### `PolicyDecision`

```text
ALLOW
REVIEW_REQUIRED
DENY
```

`REVIEW_REQUIRED` exists so Gate 2 does not prematurely classify provider-dependent uses as either globally safe or globally prohibited.

---

## 2. Conservative baseline matrix

| Origin | Display | Operational planning | Behavioral analytics | User profiling | Recommendation | Planner eligibility | AI | External export |
|---|---|---|---|---|---|---|---|---|
| FIRST_PARTY | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | REVIEW_REQUIRED | REVIEW_REQUIRED |
| SPOTIFY | ALLOW | REVIEW_REQUIRED | DENY | DENY | DENY | REVIEW_REQUIRED | DENY | REVIEW_REQUIRED |
| LASTFM | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED |
| OTHER_PROVIDER | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED |
| USER_IMPORT | ALLOW | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED |
| UNKNOWN | REVIEW_REQUIRED | DENY | DENY | DENY | DENY | DENY | DENY | DENY |

Notes:

1. Spotify behavioral analytics/profile/recommendation/AI are fail-closed in the central baseline required by #278.
2. Spotify operational planning and planner eligibility are **not automatically allowed**; existing productive uses remain unchanged until their dedicated review gate.
3. Last.fm is not treated as commercially licensed merely because the user connected it.
4. `USER_IMPORT` does not automatically imply independent commercial/AI rights.
5. First-party AI remains `REVIEW_REQUIRED` because the provider-lineage question is not the only requirement for AI ingestion; consent/privacy/AI-specific policy remains a separate boundary.
6. `UNKNOWN` is intentionally fail-closed.

---

## 3. No-lineage-laundering invariant

Derived values must carry the **union of every contributing origin**.

```text
FIRST_PARTY + SPOTIFY
        ↓ mergeLineages()
[FIRST_PARTY, SPOTIFY]
        ↓ policy decision
SPOTIFY restriction remains present
```

The policy rule is:

```text
DENY > REVIEW_REQUIRED > ALLOW
```

The most restrictive contributing origin wins for the requested use.

Examples:

```text
FIRST_PARTY + SPOTIFY -> AI                  = DENY
FIRST_PARTY + SPOTIFY -> RECOMMENDATION      = DENY
FIRST_PARTY + SPOTIFY -> BEHAVIORAL_ANALYTICS = DENY
FIRST_PARTY + LASTFM  -> BEHAVIORAL_ANALYTICS = REVIEW_REQUIRED
```

An empty lineage normalizes to `UNKNOWN`, not to an empty/implicitly allowed value.

---

## 4. Exhaustive mapping of existing Prisma enums

Gate 2 includes a separate adapter for the current schema enums:

### `ListeningEventSource`

```text
SPOTIFY_RECENTLY_PLAYED  -> SPOTIFY
SPOTIFY_EXTENDED_HISTORY -> SPOTIFY
LASTFM_SCROBBLE          -> LASTFM
IMPORT                   -> USER_IMPORT
```

The map uses:

```ts
satisfies Record<ListeningEventSource, DataOrigin>
```

Therefore adding a new `ListeningEventSource` enum value without classifying it should fail typecheck instead of silently defaulting to an origin.

### `LikedTrackPreferenceProvenance`

```text
LIKED_TRACK_BACKFILL -> SPOTIFY
LIKED_TRACK_SYNC     -> SPOTIFY
```

This is deliberately conservative.

Gate 1 proved that `LIKED_TRACK_SYNC` currently describes a provider synchronization lifecycle and can also be the final materialization path after an explicit Sonoriza “like” confirmation. It therefore cannot reliably represent first-party intent by itself.

A later gate must model first-party preference separately instead of relabeling these legacy rows.

---

## 5. Tests added

`test:data-policy` covers the central contract.

Required regression properties now include:

- deterministic, deduplicated origin sets;
- empty lineage -> `UNKNOWN`;
- root-source -> origin mapping;
- Spotify analytics/profile/recommendation/AI -> `DENY`;
- Spotify operational/planner eligibility -> `REVIEW_REQUIRED`;
- Last.fm does not silently become commercial-ready;
- mixed `FIRST_PARTY + SPOTIFY` remains denied for restricted uses;
- mixed `FIRST_PARTY + LASTFM` remains `REVIEW_REQUIRED`;
- first-party-only non-AI product uses remain allowed;
- current Prisma listening/liked provenance values map explicitly.

Local isolated validation of the pure contract + Prisma adapter shape:

```text
11 tests
11 passed
0 failed
```

The exact pure TypeScript modules also passed strict/noUncheckedIndexedAccess typechecking in the isolated validation environment. No repository workflow run exists for this branch at the time of this gate, so full-project `npm run typecheck/build` is not claimed here.

---

## 6. Where the contract must be applied later

Gate 2 does **not** wire the policy into these runtime consumers yet. It defines the expected integration points.

### MUSIC-01

Current:

```text
SPOTIFY_RECENTLY_PLAYED
  -> TrackListeningState.lastPlayedAt
  -> blockedTrackIds
  -> planner eligibility
```

Required later:

- the cooldown projection must retain/derive lineage;
- `PLANNER_ELIGIBILITY` must be checked before Spotify-origin state affects candidate exclusion;
- migration/runtime rollout needs its own preview/postcheck because this is productive behavior.

### HISTORY / `TrackListeningEvent`

A future lineage resolver cannot use only `TrackListeningEvent.source`.

Example already found in Gate 1:

```text
source = LASTFM_SCROBBLE
metadata.spotifyExtendedHistory = {...}
```

Expected lineage:

```text
[LASTFM, SPOTIFY]
```

The resolver must include provider evidence embedded during reconciliation/enrichment.

### MUSIC-05

Current inferred skips may use anchors from mixed `TrackListeningEvent` history and then materialize `MusicPreferenceSignal(INFERRED_SKIP)` without an origin set.

Required later:

```text
anchor event lineage
+ other behavioral evidence lineage
+ first-party generation-order evidence when applicable
        ↓
MusicPreferenceSignal lineage
```

A signal containing Spotify lineage cannot become a provider-neutral negative preference merely because the raw event was transformed into an inference.

### LIKED / ArtistAffinity

Current:

```text
Spotify Saved Tracks
 -> LikedTrackPreference
 -> ArtistAffinityEvidence
 -> ArtistAffinityState
```

And an explicit Sonoriza confirmation can eventually enter the same legacy `LIKED_TRACK_SYNC` path.

Required later:

- first-party explicit preference must have its own origin/semantic record;
- provider mirror and user intent must be reconcilable but not indistinguishable;
- aggregate affinity must preserve contributing origin sets.

### DISCOVERY / ALBUM

Filtering after a final score is too late.

Required later:

```text
root evidence
 -> origin eligibility for requested use
 -> permitted aggregate/profile
 -> score/reason with lineage
 -> recommendation/planner
```

This also addresses the #120 lesson: complete-profile optimization/projections must not erase lineage when moving aggregation into SQL or persistent summaries.

### Podcast state

Current:

```text
Spotify resume_position_ms / fully_played
 -> EpisodeListeningState
 -> eligibility/replay/planner
```

The root source maps to `SPOTIFY_PODCAST_PLAYBACK_STATE -> SPOTIFY`.

Its current planner use remains unchanged in Gate 2, but any future `PodcastPlaybackProvider` (#209) must keep playback evidence origin separate from RSS/catalog identity.

### AI / export

No active AI integration was found in Gate 1.

Gate 2 reserves the vocabulary needed for the next guard:

```text
policyDecisionForLineage(lineage, "AI")
```

Gate 3 should create the hard ingestion boundary without inventing a fake AI runtime dependency.

---

## 7. Explicit non-goals of Gate 2

Not done here:

- no Prisma migration;
- no new lineage columns on productive tables;
- no backfill;
- no deletion/retention action;
- no change to MUSIC-01 cooldown;
- no change to MUSIC-05 suppression;
- no change to DISCOVERY/ALBUM scores;
- no change to Saved Tracks behavior;
- no change to podcast eligibility;
- no Spotify scope removal;
- no Spotify/Last.fm calls;
- no AI integration;
- no provider refactor;
- no deploy/merge.

---

## 8. Gate 2 result

The architecture now has a reusable, fail-closed answer to:

```text
What origin(s) contributed to this value?
What use is being requested?
Is the use allowed, denied, or still awaiting explicit review?
```

The key invariant is implemented as a pure contract:

> **aggregation cannot erase a restrictive origin.**

This is sufficient to proceed to the next gated step without changing productive behavior in Gate 2.

---

## 9. Proposed next gate — Gate 3

Gate 3 should implement the **hard AI/export boundary** around this contract, even though no active LLM/Tião Brain path exists today.

Minimum safe scope:

- generic guard accepting `DataLineage` + AI/export intent;
- Spotify lineage => hard deny;
- `UNKNOWN` => hard deny;
- `REVIEW_REQUIRED` must not pass as allowed;
- tests proving direct and mixed Spotify data cannot cross;
- no OpenAI/LLM dependency introduced merely to test the guard;
- no runtime behavior changes outside an actual AI/export boundary.

Gate 3 remains separate and is **not started by this document**.
