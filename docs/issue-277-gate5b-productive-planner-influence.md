# #277 MUSIC-06 — Gate 5B: productive bounded planner influence

## Status

Implementation branch: `issue-277-gate5b-productive-planner-influence`

Gate 5B promotes the already validated Gate 5A shadow rerank into a guarded
productive path. It does **not** merge, deploy or enable the feature by itself.

The implementation follows the post-pivot product decision: Sonoriza is a
personal/non-commercial project, Spotify remains an operational provider, and
MUSIC-06 behavioral evidence is derived only from Last.fm scrobbles plus the
first-party order actually published by Sonoriza.

## Real evidence that unlocked Gate 5B

Controlled run: `cmtmwl5a60003jio0livn40v6`.

Observed validation:

- Last.fm provider available, complete pagination;
- one target with coverage `CONFIRMED`;
- 4 evaluable windows;
- 2 inferred `LASTFM_PLANNED_SEQUENCE_GAP` events;
- user confirmed both inferred gaps were intentional skips;
- 2/2 emitted gaps matched controlled ground truth;
- no false positive was observed among emitted gaps;
- Gate 4 projected 4 assessed / 2 negative occurrences with no duplicate,
  conflict or unprojectable rows.

This removes the previous Gate 5B blocker of having no real evaluable data. It
is not a claim of global detector accuracy; productive influence still requires
conservative repeated evidence thresholds.

## Capability decision

The global `DEFAULT_ORIGIN_POLICY` is intentionally unchanged. Last.fm remains
`REVIEW_REQUIRED` for both `RECOMMENDATION` and `PLANNER_ELIGIBILITY`.

Gate 5B resolves exactly one reviewed capability:

```text
scope      = PERSONAL_NON_COMMERCIAL
capability = MUSIC_06_LASTFM_BOUNDED_RERANK
use        = RECOMMENDATION
baseline   = REVIEW_REQUIRED
resolved   = ALLOW
issue      = #277
```

The following are explicitly **not** approved:

- Last.fm-derived candidate removal / hard exclusion;
- Last.fm-derived `PLANNER_ELIGIBILITY` changes;
- AI ingestion;
- external export;
- a global Last.fm policy override;
- Spotify behavioral-data fallback.

A future `DENY` baseline cannot be upgraded by this scoped approval.

## Productive policy

Gate 5B promotes Gate 5A thresholds unchanged.

### Track

```text
min assessed occurrences = 3
min negative occurrences = 2
min distinct negative days = 2
min skip rate = 0.50
max MUSIC rank shift = 2
```

### Artist

```text
min assessed occurrences = 6
min negative occurrences = 3
min distinct negative tracks = 2
min distinct negative days = 2
min skip rate = 0.50
max MUSIC rank shift = 1
```

### Combined

```text
max combined MUSIC rank shift = 3
```

The operation is ranking only:

- candidate count is unchanged;
- candidate set is unchanged;
- podcast slots are unchanged;
- type pattern is unchanged;
- CALENDAR-02 planning blocks are unchanged;
- no inferred evidence creates a hard exclusion;
- explicit first-party TRACK/ARTIST preference suppresses inferred demotion.

## Runtime activation

Code presence does not activate Gate 5B.

Both environment conditions must be satisfied:

```text
MUSIC_06_LASTFM_PLANNER_ENABLED=true
MUSIC_06_LASTFM_PLANNER_USER_EMAILS=<normalized exact email allowlist>
```

The central scoped capability must also resolve `boundedRerankAllowed=true`.

Policy failure happens before provider read. Therefore a disabled or
non-allowlisted account generates exactly as before without a Gate 5B Last.fm
request.

## Runtime evidence preparation

Default bounded preparation:

```text
lookbackDays = 7
windowHours = 6
maxSourceRuns = 28
maxCandidateRunsToRead = 200
maxProviderPages = 8
providerTimeoutMs = 8000
```

Flow:

1. read recent real `SUCCESS|PARTIAL`, non-simulation `GenerationRun`s;
2. select source runs whose Last.fm observation windows do not overlap;
3. prefetch one bounded broad Last.fm recent-tracks observation;
4. require complete pagination;
5. reuse that observation locally for Gate 2/3 evaluation of each selected run;
6. accept at most one `CONFIRMED` + evaluable target per source run;
7. select that target without looking at inferred-negative count;
8. aggregate through the existing Gate 4 projector;
9. use the resulting projection only for bounded rerank.

The one-target-per-run rule is a conservative anti-double-counting rule. Several
Sonoriza destinations can contain overlapping music orders from the same
physical listening session; a single scrobble timeline must not make the same
behavior count multiple times merely because several playlists were published.

The target-selection tie break is based on evaluability/match strength, never on
which target produces more negative gaps.

## Provider failure semantics

MUSIC-06 is optional for generation.

Preparation statuses:

```text
DISABLED
NOT_CONFIGURED
NO_PUBLISHED_RUNS
PROVIDER_UNAVAILABLE
PROVIDER_INCOMPLETE
READY
```

Only `READY` can influence order. Every other status is a no-op.

A Last.fm timeout, request error or incomplete broad pagination does not fail a
playlist generation and does not create a negative signal. It only disables the
Gate 5B influence for that run.

## Pipeline position

The productive bridge is attached to `playlist-ordering` after ORDER-01.

```text
planner selection
  -> ORDER-01 STANDARD/RANDOMIZED
  -> MUSIC-06 bounded rerank (if READY + enabled)
  -> final order hash / simulation parity
  -> existing sequence/diversity/pre-write validations
  -> Spotify write (real run only)
```

This placement provides several properties:

- the approved simulation hash includes MUSIC-06 when enabled;
- if evidence changes enough to change the final order between simulation and
  real publication, the existing ORDER-01 preview parity gate can block the real
  write and ask for a fresh simulation;
- KEEP_FILLED preserved prefix stays outside the orderable suffix and is not
  moved by MUSIC-06;
- CALENDAR-02 groups remain isolated.

## Runtime observability

Generation summary receives `music06PlannerInfluence` with only bounded audit
metadata, including:

- runtime status and policy reason;
- baseline/resolved capability decisions;
- source run IDs and counts;
- observation window/page/scrobble counts;
- aggregate assessed/negative/conflict counts;
- number of track/artist projections;
- application/influence counts;
- max observed rank shift;
- explicit-preference suppression count;
- application failure/abstention information.

The runtime summary does not persist a behavioral profile table and does not log
track names as a new productive profile.

## Persistence

Gate 5B introduces:

- no Prisma schema change;
- no migration;
- no new behavioral profile table;
- no `MusicPreferenceSignal` write path;
- no Last.fm write;
- no Spotify behavioral read.

Negative projection is reconstructed read-only from bounded source runs and
Last.fm observations when the runtime is enabled.

## Fail-closed / fail-open boundaries

Fail closed:

- capability is not approved -> no influence;
- feature flag absent/false -> no influence;
- email missing/not allowlisted -> no provider read / no influence;
- provider pagination incomplete -> no influence;
- insufficient threshold evidence -> no influence;
- explicit first-party preference -> inferred demotion suppressed.

Fail open for generation availability:

- Last.fm request/timeout/runtime application error -> generation continues with
  the pre-MUSIC-06 order.

The latter means "fail open to no optional influence", not "infer on bad data".

## Validation contract before merge

Required on the exact branch SHA:

- capability tests;
- Gate 5A shadow regressions;
- Gate 5B productive bridge tests;
- Gate 5B runtime tests;
- playlist-ordering legacy tests;
- playlist-ordering + MUSIC-06 integration tests;
- Gate 2/3/4 Last.fm regressions;
- typecheck;
- production build;
- real read-only Gate 5B runtime report.

The real report may show zero currently influenced candidates. That is expected
until repeated evidence satisfies the two-day / occurrence thresholds. The
important validation is that the scoped capability is authorized, runtime
preparation is conservative/read-only, and insufficient evidence remains a
no-op.

## Separate gates after this branch

1. validate branch on server;
2. review real read-only Gate 5B report;
3. merge only with explicit authorization;
4. deploy only with explicit authorization;
5. enable feature flag/allowlist only with explicit activation decision;
6. continue to Gate 6 UI/explainability after productive behavior is proven.
