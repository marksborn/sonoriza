# MUSIC-IDENTITY-01 — Gate 4B canonical component closure shadow

## Status

Gate 4B remains diagnostic/read-only. It does not merge identities, propagate preferences, select a representative provider track, activate consumers, or influence planner/playback.

## Purpose

Gate 4A evaluates candidate equivalence pair-by-pair. Gate 4B evaluates the transitive closure of those candidate edges before any canonical dedupe consumer can depend on them.

The critical failure mode is:

```text
A -- safe -- B
B -- safe -- C
A -- blocked -- C
```

The component `[A, B, C]` must be blocked. A connected path is not sufficient evidence for a canonical merge.

## Component safety

A candidate component is `SAFE_CANONICAL_COMPONENT` only when all of the following hold:

- every internal member pair is present in the reconstructed Gate 3 textual pair universe;
- every internal pair is a Gate 4A `CANONICAL_RECORDING_CANDIDATE`;
- the complete component has one normalized ISRC and no missing ISRC;
- every member has live provider duration;
- the component-wide min/max duration envelope is compatible under the same Gate 4A threshold;
- all TRACK-level first-party preferences are either absent on every member or identical in policy and source on every member;
- repeated observations of the same provider track are internally consistent.

Any uncertainty fails closed.

## Decisions

```text
SAFE_CANONICAL_COMPONENT
BLOCKED_INCOMPLETE_INTERNAL_EVIDENCE
BLOCKED_INTERNAL_IDENTITY_CONTRADICTION
BLOCKED_DURATION_CLOSURE
BLOCKED_PREFERENCE_SEMANTICS
```

## Authority

```text
providerCalls=true
identityWrites=false
canonicalWrites=false
preferenceWrites=false
sourceCacheWrites=false
consumerActivation=false
plannerInfluence=false
representativeSelection=false
likedTrackPreferenceRead=false
```

Spotify credential refresh/backoff may perform their existing operational writes; those are not canonical identity or preference writes.

## Preference semantics

Gate 4B reads only native `FirstPartyPlaybackPreference` with `subjectType=TRACK`.

`LikedTrackPreference` is not read and is not a substitute for native Sonoriza preference semantics.

The component preference states are:

```text
NO_EXPLICIT_TRACK_PREFERENCE
IDENTICAL_EXPLICIT_TRACK_PREFERENCE
PREFERENCE_PRESENCE_DIVERGENCE
PREFERENCE_POLICY_DIVERGENCE
PREFERENCE_SOURCE_DIVERGENCE
```

No policy is propagated between aliases. Identical `EXCLUDED` observations are diagnostically compatible; unilateral `EXCLUDED` remains a semantic blocker.

## Representative selection

Gate 4B deliberately does not choose a surviving `RecordingIdentity` or `TrackProviderRef`.

```text
representativeRecordingIdentityId=null
representativeProviderTrackId=null
representativeSelection=NOT_SELECTED_IN_GATE4B
```

## CLI

```bash
npx tsx scripts/report-music-identity-canonical-component-shadow.ts --user=<id>
npx tsx scripts/report-music-identity-canonical-component-shadow.ts --user=<id> --json
```

`--write` is rejected.

## Exit checkpoint

A future consumer shadow gate may use only `SAFE_CANONICAL_COMPONENT` as diagnostic equivalence. Productive identity merge, preference propagation, representative selection, and consumer activation remain separate checkpoints requiring explicit approval.

Refs #374.
