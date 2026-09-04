# MUSIC-06 #277 — Gate 5A: planner influence shadow

## Status

Implemented on branch `issue-277-gate5-planner-influence-shadow`.

This cut is intentionally **shadow/read-only**. It does not alter the productive planner, candidate eligibility, playlist contents, `MusicPreferenceSignal`, or persisted user preferences.

## Why Gate 5 begins in shadow

Gate 4 established a negative projection using only Last.fm windows that Gate 2 marked as evaluable. The first real report for the current production run had:

- `assessedOccurrenceCount = 0`;
- `negativeOccurrenceCount = 0`;
- coverage `UNKNOWN`.

Therefore there is not yet real evidence with which to calibrate a productive penalty. Gate 5A measures the shape and safety of a possible influence without turning synthetic thresholds into production behavior.

## Input lineage

Behavioral evidence is derived from:

```text
Sonoriza published order (first-party execution fact)
+ Last.fm scrobbles
+ Gate 2 confirmed coverage
+ Gate 3 inferred unit gaps
+ Gate 4 negative projections
```

Spotify identifiers remain operational identity references only. Spotify Recently Played / Extended History are not inputs to MUSIC-06.

## Planner effect model

The Gate 5A preview does not calculate a permanent dislike and does not remove any candidate.

It computes a bounded hypothetical movement **inside the MUSIC subsequence only**.

Provisional configurable defaults:

```text
TRACK evidence
  assessed occurrences >= 3
  inferred negatives   >= 2
  distinct negative days >= 2
  skipRate >= 0.50
  max rank shift = 2

ARTIST evidence
  assessed occurrences >= 6
  inferred negatives   >= 3
  distinct negative tracks >= 2
  distinct negative days >= 2
  skipRate >= 0.50
  max rank shift = 1

combined cap = 3 MUSIC ranks
```

These are **shadow calibration defaults**, not a final productive policy.

A qualifying track can move only a small bounded number of positions later in the music pool. Artist evidence is weaker and requires diversity across negative tracks before contributing.

## No hard exclusion

Gate 5A guarantees:

```text
inputCandidateCount == outputCandidateCount
```

It does not:

- delete a candidate;
- mark a candidate ineligible;
- ban a track or artist;
- persist a negative preference;
- call the productive planner;
- write a playlist.

Podcast positions are kept fixed; only the MUSIC subsequence is hypothetically reordered.

## Explicit preference precedence

Any matching first-party TRACK or ARTIST preference suppresses inferred Last.fm demotion for that candidate.

This intentionally avoids double-applying behavioral inference on top of an explicit user instruction. The productive first-party bridge remains the owner of `PREFERRED`, `NORMAL`, `REDUCED`, and `EXCLUDED` semantics.

## Capability state

The central conservative policy matrix created under #278 still currently evaluates Last.fm as:

```text
RECOMMENDATION       = REVIEW_REQUIRED
PLANNER_ELIGIBILITY  = REVIEW_REQUIRED
```

Gate 5A exposes this state in every report rather than bypassing it.

Therefore:

```text
productivelyAuthorized = false
```

No productive bridge is introduced in Gate 5A.

The post-pivot decision in #277 is enough to continue design and shadow validation, but a scoped capability decision must be explicit before productive Last.fm recommendation influence is wired into the planner.

## Real report semantics

`scripts/report-music-06-planner-influence-shadow.ts` accepts one or more explicit GenerationRun IDs.

The selected runs build the Gate 4 projection. The last supplied run is then reused only as a **published-order sample** to illustrate hypothetical rank movement.

That sample is not claimed to be the future candidate pool.

The report prints:

- Last.fm capability decision;
- assessed / negative occurrence counts;
- number of influenced candidates;
- track vs artist influence count;
- explicit-preference suppressions;
- maximum observed music-rank shift;
- examples with before/after rank and reasons.

## Required regressions

Gate 5A tests cover:

1. current Last.fm recommendation capability remains `REVIEW_REQUIRED`;
2. insufficient evidence causes no movement;
3. qualifying track evidence has a bounded two-rank default shift;
4. track + artist influence is capped at three MUSIC ranks;
5. explicit TRACK preference suppresses inference;
6. explicit ARTIST preference suppresses inference;
7. artist evidence requires multiple distinct negative tracks;
8. podcast positions remain unchanged;
9. no candidate is removed or hard-excluded;
10. identical facts produce deterministic output;
11. invalid configuration fails closed.

## Gate 5B entry criteria

Do not activate productive influence merely because synthetic tests pass.

Before Gate 5B:

1. validate Gate 5A tests/typecheck/build;
2. run the real shadow report;
3. collect at least some real `CONFIRMED` coverage / assessed occurrences from runs actually listened to;
4. review apparent inferred gaps and rank movements;
5. make an explicit scoped Last.fm capability decision for MUSIC-06 recommendation use;
6. only then wire a bounded productive bridge behind a rollout switch.

## Non-goals

Gate 5A does not:

- change `DEFAULT_ORIGIN_POLICY` globally;
- authorize Last.fm for AI;
- authorize Last.fm external export;
- re-enable Spotify behavioral analytics;
- implement LIVE learning;
- persist track/artist negative profiles;
- merge or deploy itself.
