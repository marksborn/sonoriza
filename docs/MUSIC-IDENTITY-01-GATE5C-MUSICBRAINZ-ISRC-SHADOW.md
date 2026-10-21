# MUSIC-IDENTITY-01 — Gate 5C: Spotify ISRC → MusicBrainz MBID SHADOW

## Motivation and observed evidence

On 21 October 2026, 19/19 tracks from the last real Carro generation
returned an ISRC from the Spotify catalog. All 19 persisted
`TrackProviderRef` entries were singleton bootstrap without ISRC/MBID.
Of 1,312 historical Last.fm scrobbles, 928 had valid recording MBIDs.
A first manual MusicBrainz ISRC lookup returned:

- `USHR10723245` / Atreyu / Becoming the Bull → one recording MBID.
- `USAT20400765` / Skindred / Nobody → **two distinct** recording MBIDs;
  near-identical durations **do not** allow automatic selection.
- `AUMEV2152349` → HTTP 404; no ISRC mapping observed, **not** evidence
  that no listening or recording exists.

Follow-up MBID and exact-title/artist searches found no matching
Last.fm rows in the local six-month historical snapshot. Missing local
matches **do not imply absence of listening in Last.fm live coverage**.

## Scope

Gate 5C only produces operator-requested diagnostics. It does **not**:

- merge, create or reassociate `RecordingIdentity` or `TrackProviderRef`;
- write ISRC or MBID to the database;
- change a generation, playlist, cooldown, Reserve or KEEP_FILLED;
- expand a canonical canary or use the outcome in planner eligibility;
- fetch Last.fm live data or claim complete listening coverage.

The source GenerationRun and Last.fm history are read in a PostgreSQL
`REPEATABLE READ` / `SET TRANSACTION READ ONLY` transaction, finished
**before** provider requests. This probe calls **Spotify catalog and
MusicBrainz** over HTTP. **Operational OAuth refresh may write Spotify
account credentials** through the existing Spotify token client; there
are no canonical or playlist writes. It is not a globally side-effect-free
probe.

## Explicit operator command (after PR merge and separate deploy)

```bash
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br
npx tsx scripts/report-music-identity-gate5c-musicbrainz-shadow.ts \
  --user=<SonorizaUserId> --target=<CarroTargetId> \
  --offset=0 --limit=3 --ack-provider-reads --json
```

CLI rejects unknown flags, `--write` and `--apply`; `--ack-provider-reads`
is mandatory. `--limit` is max 5 (default 3); offset 0–500. No
automation, cron, or background task is added. Each report is a historical
sample of the latest successful real GenerationRun for the target, not a
live Spotify playlist. The cutoff is computed using the persisted user's
repeat window as of this report; historical policy changes are not
reconstructed. Scrobbles are `LASTFM_SCROBBLE` only, read with a hard
20,000-row cap. Excessive data makes the report abort.

Do not run two probes in parallel or alongside another public MusicBrainz
client from the same IP. Client throttle guarantees >=1.5 seconds between
sequential MusicBrainz requests **in this one process**. It does not
coordinate with other processes or IP-shared clients. All requests carry
`Sonoriza/0.1 (https://github.com/marksborn/sonoriza)` User-Agent.
MusicBrainz can respond with **503** for rate limits; 429, 503, 5xx,
unexpected payloads or network errors abort the entire batch without
retries. **404 becomes explicit abstention** for that ISRC rather than
failing the entire batch. Do not automatically restart after provider
failures.

## Classification: no automatic identity or cooldown decisions

- `REVIEW_SINGLE_MBID`: exactly one valid recording MBID and compatible
  primary artist, derived base title, version, and duration <=5 s apart.
  **Still review-only.**
- `REVIEW_STANDARD_REMASTER`: one valid MBID with compatible standard/
  remaster text/version; **not proof of same master recording**.
- `ABSTAIN_MULTIPLE_MBIDS`: more than one distinct recording MBID for
  the same ISRC. Never use small duration deltas to break the tie.
- `ABSTAIN_ISRC_NOT_FOUND_404`: no public ISRC mapping returned; do not
  treat as absence of listening or an error worthy of retrying the batch.
- `ABSTAIN_ZERO_RECORDINGS`, `ABSTAIN_INVALID_ISRC`,
  `ABSTAIN_INVALID_MUSICBRAINZ_MBID`, `ABSTAIN_RELINKED_TRACK`,
  `ABSTAIN_TITLE_MISMATCH`, `ABSTAIN_ARTIST_MISMATCH`,
  `ABSTAIN_VERSION_CONFLICT`, `ABSTAIN_DURATION_MISSING`,
  `ABSTAIN_DURATION_MISMATCH`: incomplete, incompatible or ambiguous
  evidence. Live, remix, acoustic, demo and cover stay separated.

The resulting MBIDs may be counted against **local** historical Last.fm
scrobbles within the generation window. This is evidence of overlap only;
a count of zero never establishes that a track was never played. Even a
positive count never changes productive cooldown until a separate,
independently reviewed activation gate with permitted data provenance.

## Provider terms and operational safety

Official documentation:
- https://musicbrainz.org/doc/MusicBrainz_API
- https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting

MusicBrainz currently describes its public API as free for
**non-commercial** use and asks for a commercial plan/contact for
commercial deployments. Confirm commercial terms and appropriate
attribution before productizing these reads. No unattended or bulk
MusicBrainz ingestion is authorized by Gate 5C.

## Acceptance before any merge/deploy

1. Pure tests for one/multiple/zero MBIDs, 404, artist/title mismatches,
   version conflicts, duration mismatch/missing, invalid identifiers and
   relinking; client tests for sequential request spacing and failure.
2. Full CI typecheck/build green.
3. Review explicit provider traffic, credential refresh side effects, and
   MusicBrainz usage conditions. Get separate approval before deployment.
4. Pilot only 3 records from Carro; inspect version traits and actual MBID
   overlaps. No production cooldown activation permitted by these results.

Refs: #374, #512, #278, #200; predecessor gates #516 and #517.
