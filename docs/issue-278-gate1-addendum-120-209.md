# Issue #278 — Gate 1 addendum: #120 and #209

This addendum is part of the read-only Gate 1 inventory for #278.

It corrects an omission in the first consolidated report: an earlier #278 roadmap comment had already required explicit review of #120 PERF-01 and #209 PODCAST-DISCOVERY-01.

No runtime/schema/production behavior was changed by this addendum.

---

## #120 PERF-01 — DISCOVERY complete-profile consumer

Issue #120 is closed as a performance issue, but it contains direct technical evidence relevant to #278:

```text
prepareDiscoveryMusicForCurrentRun()
  -> getCompleteMusicDiscoveryProfile(userId)
  -> getMusicDiscoveryProfile(... completeUniverse: true)
  -> TrackListeningEvent.findMany()
  -> complete in-memory artist/track profile
  -> scoring/ranking
```

The issue records that the complete profile loaded the user's full `TrackListeningEvent` history, including `metadata`, and aggregated that universe into Maps/Sets before scoring.

### Compliance/lineage relevance

- `TrackListeningEvent` can contain SPOTIFY, LASTFM, IMPORT and mixed reconciled evidence.
- The complete profile is therefore a concrete high-volume consumer of provider-derived history.
- Gate 2 origin filtering must be applied **before or during aggregation**, not after the final score is produced.
- Provider-specific metadata should not be loaded merely because it happens to be present if a consumer does not have an allowed use for it.
- A future projection/SQL optimization must preserve lineage instead of making it harder to reconstruct.

### Classification

- Origin: `MIXED`
- Use: `BEHAVIORAL_ANALYTICS`, `USER_PROFILING`, `RECOMMENDATION`
- Runtime status: **ACTIVE/GATED through DISCOVERY runtime**, while #120 itself is closed
- Lineage preserved at consumer output: **insufficient**
- #278 consequence: **include as technical consumer evidence, not as a new hard blocker**

---

## #209 PODCAST-DISCOVERY-01 — future podcast provider boundary

Issue #209 is open and describes a future architecture in which:

```text
PodcastDiscoveryProvider
  -> find podcast / RSS

PodcastFeedSource
  -> canonical publisher feed / catalog

PodcastPlaybackProvider
  -> queue / progress / history / playback state
```

The audited repository tree contains no `podcast-discovery` runtime implementation path at the audited SHA, so this is **DOCUMENTED_ONLY / FUTURE_CONTRACT_ONLY** for Gate 1.

### Compliance/lineage relevance

#209 is directly relevant because the current podcast planner uses Spotify playback-position/completion evidence (`EpisodeListeningState`). The future split proposed by #209 gives Gate 2 a natural boundary:

- RSS/feed/catalog data: `OTHER_PROVIDER`/publisher-feed operational data;
- Spotify playback progress/history: `SPOTIFY`;
- future Pulse playback evidence: `FIRST_PARTY` only if its collection policy qualifies it as such;
- PinePods/gPodder/other playback providers: `OTHER_PROVIDER` with their own capability policy.

`PodcastSource` identity and `PodcastPlaybackProvider` behavior must not silently share one provenance classification just because they refer to the same canonical episode.

### Classification

- Current runtime status: **DOCUMENTED_ONLY / FUTURE_CONTRACT_ONLY**
- Current provider implementation: none found for #209
- Gate consequence: **must enter #278 architectural review before a Spotify `PodcastPlaybackProvider` or other playback-provider analytics path is implemented**
- Not a reason to change current podcast behavior in Gate 1

---

## Updated affected-issue reconciliation

Gate 1 now explicitly covers:

```text
#278
#277
#34
#55
#89
#90
#99
#102
#103
#120
#146
#158
#160
#184
#185
#186
#200
#205
#207
#209
#237
```

### Blocker status

- **#277 remains blocked by #278.**
- #120 is not a new blocker; it is evidence of an important DISCOVERY consumer and future projection risk.
- #209 is not an implemented behavior to disable; it must inherit the #278 capability/provenance contract before its playback-provider layer is implemented.

### Gate 2 scope impact

No new abstraction is required because of #120/#209.

The same minimal Gate 2 contract remains sufficient:

- `DataOrigin` / origin set;
- `PolicyUse` / allowed uses;
- mapping from existing root sources;
- preservation through derived profiles/scores;
- capability enforcement at provider/consumer boundaries.

#120 reinforces that filtering must occur before aggregate materialization. #209 reinforces that catalog/feed origin and playback-behavior origin are separate dimensions.

---

## Stop condition

This addendum does not start Gate 2 and does not change any runtime behavior.
