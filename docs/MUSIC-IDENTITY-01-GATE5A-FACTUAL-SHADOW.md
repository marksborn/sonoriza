# MUSIC-IDENTITY-01 Gate 5A — Last.fm factual cooldown vs RecordingIdentity (SHADOW)

## Objective
Inventory the difference between the current **artist + track title** factual cooldown
and verifiable **provider-linked canonical recording** evidence, without making any
new eligibility, dedupe or Spotify decisions.

This is a **historical local lower-bound comparison**, NOT the production Last.fm
coverage check. Production still obtains a fresh Last.fm provider observation and
continues running independently via #512/#513/#514/#515.

## Safe command (read-only)

```bash
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br
npx tsx scripts/report-music-identity-gate5a-factual-shadow.ts --user=<userId> --target=<targetPlaylistId> --json
```

**Do not run on production before this report tool has been merged and deployed
through a separately approved gate.** The report performs bounded DB selects
inside a REPEATABLE READ transaction with `SET TRANSACTION READ ONLY`; there
are no provider calls, DB mutations, changes to configuration or playlist
writes. It rejects unknown flags, including `--write` and `--apply`.
It is **not** wired into the normal generation pipeline.

## Semantics

- Source plan: latest successful non-simulation GenerationRun containing the
  selected target. This is a historical generation, **not a live playlist
  snapshot**. Compare only scrobbles before the generation's start time.
- Window: the user's persisted MusicPlaybackPolicy cutoff, as at that run.
- Last.fm factual observations: only rows persisted with
  `source=LASTFM_SCROBBLE` in TrackListeningEvent; live Last.fm pages are **not
  queried**. Thus a missing match is **not evidence of never having listened**.
- Legacy side: compact-whitespace title and normalized artist, as in the current
  operational Last.fm matcher. Artist names in older GenerationItems may reflect
  display subtitles with multiple credits.
- **Current importer limitation (verified in code)**: `toEventRow` in
  `src/services/lastfm/import-history.ts` deliberately persists
  `spotifyTrackId: null` and `isrc: null` for imported Last.fm events.
  `trackMbid` may be stored. Consequently normal imported events will
  **not** produce `EXACT_PROVIDER_REF` or `STRONG_SAME_RECORDING` evidence;
  these categories are future-proof contracts for independently enriched,
  explicitly provider-linked factual events, **not an expectation for current data**.
  The expected present-day outcome is many canonical abstentions and, when
  compatible MBIDs exist, review-only hints. No automated Last.fm-to-Spotify
  association is being introduced here.
- Provider evidence: only literal `spotifyTrackId` recorded in a factual
  scrobble can serve as its provider reference. A text match, ISRC alone,
  MBID alone, or the same title can **never** manufacture such a link.
- `EXACT_PROVIDER_REF`: scrobble and generated item both explicitly carry
  the same Spotify ID. This is not a cross-version merge.
- `STRONG_SAME_RECORDING`: two distinct IDs point to one RecordingIdentity;
  at least one provider association has a strong audited reason and high
  confidence (>=9000), **plus** a matching ISRC or MBID on those refs.
- `REVIEW_WEAK_SAME_RECORDING`: same persisted recording ID but insufficient
  association/evidence; no canonical eligibility claim.
- `REVIEW_ISRC_OR_MBID_ONLY`: matching identifier without the necessary
  proven provider association; ISRC/MBID may aid later human review but does
  not authorize an automatic merge.
- `ABSTAIN_NO_CANONICAL_EVIDENCE`: everything else, including a scrobble
  without an explicit Spotify link. No false-negative conclusion is permitted.
- `additionalCooldownEvidence` counts cases with provider/recording evidence
  where the legacy text comparison did not match. **It does not block music.**

Bounds: 1,000 generation music items, 20,000 local factual scrobbles per run;
overflow abstains instead of presenting misleading partial counts. Samples
are capped at 12. No automatic full-history fetching or retries.

## Acceptance gates

1. Unit regressions for original/remaster, weak bootstrap, same ISRC across
   different recordings, live/studio, covers, exact provider ID, plain Last.fm
   text and missing evidence.
2. Typecheck and build green.
3. Review the local-data coverage and whether Last.fm scrobbles have any
   `spotifyTrackId` at all. If no direct source link, expect zero canonical
   matches and many abstentions; decide a *separate* evidence-enrichment gate
   rather than guessing matches.
4. Never activate RecordingIdentity cooldown or expand canary allowlists based
   only on this lower-bound report.
5. Any later consumer rollout must retain allowed-use/provenance safeguards
   (#278) and original/live/cover distinctions (#374).

Related issues: #374, #512, #278, #200.
