# MUSIC-06 #277 — Gate 3: Last.fm planned-sequence gap shadow

## Status

Implemented on branch `issue-277-gate3-lastfm-gap-shadow`.

This gate is intentionally **shadow/read-only**. It does not persist `INFERRED_SKIP`, does not read Spotify Recently Played, does not change planner eligibility, and does not write playlists.

## Input boundary

Gate 3 consumes only Gate 2 coverage output.

A center occurrence can be considered for a shadow gap only when Gate 2 has already marked its three-item published window as `evaluable=true`.

That means the following protections have already passed:

- Last.fm provider observation was available;
- provider pagination was complete;
- previous and next published occurrences matched unique Last.fm scrobbles;
- anchor timestamps were chronological;
- center identity was not ambiguous/unmatchable;
- there was no unrelated Last.fm scrobble between the anchors.

## Detector

Method:

`LASTFM_PLANNED_SEQUENCE_GAP`

Pattern:

```text
Sonoriza published:
A -> B -> C

Last.fm:
A ✓
B absent
C ✓

Gate 2:
window B = evaluable

Gate 3 shadow:
B -> inferred gap evidence
```

The evidence is explicitly `INFERRED`, never factual.

### Current shadow confidence

`0.90`

This is a conservative shadow constant for ranking/reporting during Gate 3. It is **not** presented as a calibrated probability. Calibration belongs to later shadow analysis before any productive influence.

## Evidence payload

Each shadow gap carries:

- evidence level;
- evidence method;
- confidence;
- generationRunId;
- targetPlaylistId;
- GenerationItem id and published position;
- track/artist display identity persisted by Sonoriza;
- optional Spotify track id only as an operational entity reference;
- previous/next GenerationItem ids and positions;
- previous/next Last.fm scrobble timestamps;
- deterministic reason code.

The behavioral evidence source is Last.fm + Sonoriza first-party published order. The Spotify id is not used as behavioral evidence.

## Fail-closed rules

No gap is emitted when:

1. coverage is UNKNOWN/PARTIAL/UNAVAILABLE;
2. the window is not evaluable;
3. center occurrence has a Last.fm scrobble;
4. center identity is ambiguous/unmatchable;
5. either anchor is not uniquely matched;
6. anchor order is invalid;
7. unrelated listening occurs between anchors.

Prefixes/suffixes remain outside the unit-gap detector because they have no two-sided continuity proof.

## Files

- `src/services/music-preference/lastfm-gap-shadow.ts`
- `src/services/music-preference/lastfm-gap-shadow.test.ts`
- `src/services/music-preference/lastfm-gap-shadow-report.ts`
- `scripts/report-music-06-lastfm-gap-shadow.ts`

Exports are available through `src/services/music-preference/index.ts`.

## Tests added

- A✓ B✕ C✓ -> exactly one shadow gap for B;
- A✓ B✓ C✓ -> zero negative gap evidence;
- UNKNOWN coverage -> zero gaps;
- unrelated scrobble between A and C -> abstain;
- ambiguous center identity -> abstain;
- identical facts -> deterministic identical result.

## Real-data expectation after Gate 2 validation

The first real Gate 2 report on 2026-09-03 had:

- 151 published music occurrences;
- 8 Last.fm scrobbles;
- 0 reconciled occurrences;
- coverage UNKNOWN;
- 0 evaluable windows.

Therefore the correct Gate 3 result for that same run is **0 inferred gaps**. This is an important regression: a generation that was not demonstrably listened to must not create negative signals.

A positive real-data example should only be evaluated after a future generation has enough Last.fm anchors from the actual published sequence.

## Non-goals

Gate 3 does not:

- persist `MusicPreferenceSignal`;
- consume old MUSIC-05 signals;
- alter planner order or eligibility;
- calculate per-track/artist negative profiles;
- classify LIVE/version preference;
- use Spotify Recently Played or Extended Streaming History;
- send data to AI/LLM;
- change schema or migrations.

## Next gate

Gate 4 remains the negative projection/profile stage, but only after Gate 3 shadow quality is validated. The immediate next operational step is validating this branch (`test:music-preference`, typecheck, build) and running the shadow CLI against the same real GenerationRun to confirm `0` gaps under UNKNOWN coverage.