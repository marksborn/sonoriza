# Issue #278 — Gate 1 read-only inventory

**SPOTIFY-COMPLIANCE-01 — separar Spotify de analytics derivados, perfis e IA**

- Date: 2026-09-02
- Base branch: `main`
- Base SHA: `46ceedacb9f216fdf94eab9ac8ac51f450d8e03b`
- Audit branch: `issue-278-gate1-inventory`
- Scope: technical inventory only; no compliance behavior change
- Runtime writes executed by this audit: **none**
- Spotify writes executed by this audit: **none**
- Schema/migrations changed: **none**
- Build/typecheck/generation executed: **none** (not required because only this documentation file was added)

> This report is a technical lineage/provenance inventory. It deliberately does not decide the legal permissibility of each use.

---

## 1. Executive summary

### How coupled is Sonoriza to Spotify for behavior/profile today?

**High in the behavioral/profile layer, while the operational provider layer is also clearly separable.**

Spotify is currently more than an operational playlist/catalog adapter in several productive or gated-productive paths:

1. `GET /me/player/recently-played` updates `TrackListeningState.lastPlayedAt`, which directly drives MUSIC-01 cooldown and candidate eligibility.
2. Spotify Recently Played also enters `TrackListeningEvent`, which is consumed by HISTORY, MUSIC-05 and DISCOVERY/ALBUM-derived metrics.
3. Spotify Saved Tracks is materialized as `LikedTrackPreference`, then as `ArtistAffinityEvidence` and `ArtistAffinityState`, and is used by liked/discovery pilot paths.
4. Spotify episode playback position (`resume_position_ms`, `fully_played`) is materialized as `EpisodeListeningState` and directly changes podcast eligibility/replay/planning.
5. Spotify catalog metadata participates in resolution/classification/ranking paths such as MUSIC-VERSION-01.

At the same time, playlist read/write, catalog resolution, album queueing and opening/managing Spotify content are already conceptually distinguishable from behavioral analytics. Gate 2 does not need to remove Spotify; it needs a policy-grade boundary between provider-operational data and behavioral/profile consumers.

### Five largest technical risks found

1. **MUSIC-01 loses origin in its state projection.**
   `syncRecentlyPlayed()` writes Spotify evidence into `TrackListeningState`, but the model only keeps Spotify identity + `lastPlayedAt`; it has no provider/source/provenance field. `loadMusicRepeatContext()` later queries that table and blocks candidates. The canonical event stream preserves `source=SPOTIFY_RECENTLY_PLAYED`, but the cooldown projection does not.

2. **Canonical history can contain mixed evidence while `TrackListeningEvent.source` remains singular.**
   Spotify Extended History can enrich a pre-existing canonical event (including another provider's event) through `metadata.spotifyExtendedHistory` without replacing its primary `source`. Therefore `source` alone is insufficient to answer which providers contributed evidence to an event.

3. **Saved Tracks and explicit Sonoriza LIKEs collapse into the same affinity semantics.**
   Spotify Saved Tracks becomes `LikedTrackPreference` -> `ArtistAffinityEvidence(type=LIKED_TRACK)` -> `ArtistAffinityState`. The provenance enum currently distinguishes `LIKED_TRACK_BACKFILL` vs `LIKED_TRACK_SYNC`, not provider vs first-party intent. `confirmProbableLike()` is an explicit user action in Sonoriza, but after the Spotify save it also materializes preference/evidence as `LIKED_TRACK_SYNC`. At aggregate `ArtistAffinityState`, even that limited provenance is gone.

4. **MUSIC-05 derives negative preference signals from cross-provider history without carrying the anchor origins into a typed field.**
   `analyzeCurrentInferredSkips()` queries `TrackListeningEvent` without filtering `source`; inferred gaps are persisted as `MusicPreferenceSignal(INFERRED_SKIP)`. The signal stores JSON `evidence`, but has no policy-grade origin set. The generation runtime consumes pending signals to block tracks.

5. **Podcast playback state from Spotify directly gates planner eligibility.**
   `EpisodeListeningState` stores Spotify resume/completion state and PODCAST-04/PODCAST-05 use it to determine `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, replay eligibility and strict pre-write completion revalidation. No provider-neutral alternative for this playback state is present in the audited runtime.

### Is Spotify -> AI active currently?

**No ACTIVE Spotify -> AI/LLM/Tião Brain runtime path was identified in the audited `main` source.**

Evidence used:

- `package.json` has no OpenAI/Anthropic/LLM/embedding dependency;
- `.env.example` / `src/lib/env.ts` audited previously expose no AI provider configuration used by runtime;
- the complete repository tree at the audited SHA has no OpenAI/LLM/Brain service path;
- audited music/history/discovery/provider paths do not call an external intelligence layer.

A schema comment on `MusicPreferenceSignal` explicitly mentions future consumers “like Tião Brain”; that is **future-contract/documentation intent**, not a runtime integration.

Status: **no real AI integration found in runtime**.

`NEEDS_RUNTIME_VALIDATION`: if production may run code/config not represented by audited `main`, a later read-only runtime check should compare deployed SHA and environment/service inventory. A deterministic repository grep/AST pass over the deployed SHA for `openai|anthropic|llm|brain|embedding|chat completion|model` can additionally close the literal-content search gap. No such script was required or executed in Gate 1.

### Does Sonoriza control Spotify playback?

**No playback-control implementation was found.**

The current code does not request `user-modify-playback-state`, and the audited Spotify client paths do not implement:

- `/me/player/play`
- `/me/player/pause`
- `/me/player/next`
- `/me/player/previous`
- transfer playback
- queue control
- Web Playback SDK
- Spotify Connect playback control

The only `/me/player/...` data path found is `GET /me/player/recently-played`.

Sonoriza does perform **playlist writes** and an explicit **library save**. Those are operational provider actions, not playback control.

### Probable impact of removing Spotify from derived analytics

**High in derived analytics, but tractable without removing the operational Spotify adapter.**

The likely affected behavioral layers are:

- MUSIC-01 cooldown state;
- MUSIC-05 negative signals/suppression;
- HISTORY statistics/probable-like ranking;
- DISCOVERY affinity/recency/momentum/rediscovery/conversion scoring;
- ALBUM opportunity ranking;
- Saved Tracks -> artist affinity;
- podcast eligibility if Spotify playback-position data is classified as disallowed for that use.

The operational layers can remain structurally separate:

- OAuth/account identity;
- playlist/source browsing;
- playlist item reads;
- playlist writes after authorization/policy;
- catalog/search/identity resolution;
- album queue write after explicit confirmation;
- opening Spotify content;
- explicit Spotify library save, if that capability remains allowed by future policy.

The main Gate 2 requirement is therefore **origin-aware recomputation/filtering**, not deletion of the Spotify integration.

---

## 2. Data-flow map

### 2.1 Spotify Recently Played

```text
SPOTIFY GET /me/player/recently-played
        |
        +--> MusicPlaybackPolicy.syncAfterCursor / lastSyncAt
        |
        +--> TrackListeningState
        |      - spotifyTrackId
        |      - spotifyUri
        |      - lastPlayedAt
        |      - NO source/provenance field
        |            |
        |            +--> loadMusicRepeatContext()
        |                    |
        |                    +--> MUSIC-01 cooldown
        |                            |
        |                            +--> candidate eligibility / planner
        |
        +--> TrackListeningEvent
               source=SPOTIFY_RECENTLY_PLAYED
               contextType/contextUri
               metadata.spotifyRecentlyPlayed.trackDurationMs
                    |
                    +--> HISTORY analytics
                    +--> HISTORY probable-like shadow ranking
                    +--> DISCOVERY complete profile / scores
                    +--> ALBUM profile/opportunity score
                    +--> MUSIC-05 anchor evidence
                              |
                              +--> MusicPreferenceSignal(INFERRED_SKIP)
                                      |
                                      +--> temporary negative suppression
                                      +--> generation planner blocking
```

Important handoff nuance in `syncRecentlyPlayed()`:

- if a Last.fm backfill has established a handoff boundary, pre-boundary Spotify events can be suppressed from `TrackListeningEvent`;
- **the same Spotify observations still update `TrackListeningState` and therefore MUSIC-01 cooldown**.

This makes the cooldown projection a separate compliance boundary from the canonical historical event stream.

### 2.2 Spotify Saved Tracks

```text
SPOTIFY GET /me/tracks
        |
        +--> operational liked-track/native source ingestion
        |
        +--> LikedTrackPreference
               first/lastProvenance = BACKFILL | SYNC
               (not DataOrigin)
                    |
                    +--> ArtistAffinityEvidence
                    |      type=LIKED_TRACK
                    |      first/lastProvenance = BACKFILL | SYNC
                    |          |
                    |          +--> ArtistAffinityState
                    |                 likedTrackCount
                    |                 active
                    |                 NO origin breakdown
                    |
                    +--> liked discovery shadow/calibration
                           |
                           +--> controlled liked-discovery runtime pilot
                                   |
                                   +--> Spotify catalog re-resolution
                                   +--> discovery planner path (allowlisted)
```

The local label `native:liked-tracks` describes a Sonoriza source projection, **not first-party data origin**. Its backing preference is synchronized from Spotify Saved Tracks.

### 2.3 Explicit Sonoriza probable-like confirmation

```text
HISTORY probable-like candidate (derived ranking)
        |
        +--> user explicitly confirms LIKE in Sonoriza
                |
                +--> saveSpotifyTrackToLibrary()  [Spotify operational write]
                |
                +--> LikedTrackPreference
                |      provenance recorded as LIKED_TRACK_SYNC
                |
                +--> ArtistAffinityEvidence(type=LIKED_TRACK)
                |      provenance recorded as LIKED_TRACK_SYNC
                |
                +--> ArtistAffinityState
```

The **user action itself is FIRST_PARTY**, but the current canonical liked/affinity materialization does not retain a first-party-vs-provider-origin distinction.

### 2.4 Spotify Extended Streaming History

```text
USER-SUPPLIED SPOTIFY EXTENDED HISTORY PACKAGE
        |
        +--> import plan / SpotifyExtendedHistoryImportRun
        |
        +--> new TrackListeningEvent
        |      source=SPOTIFY_EXTENDED_HISTORY
        |
        `--> OR enrich matching existing TrackListeningEvent
               source may remain LASTFM_SCROBBLE / SPOTIFY_RECENTLY_PLAYED / IMPORT
               metadata.spotifyExtendedHistory = {...}
                         |
                         +--> HISTORY / DISCOVERY / ALBUM / analytics consumers
```

Consequence: primary `source` may say LASTFM while the row also contains Spotify Extended evidence. This is a concrete `MIXED` lineage case.

### 2.5 Podcasts / episode playback state

```text
SPOTIFY library/catalog
   GET /me/shows
   GET /shows/{id}/episodes
   GET /episodes/{id}
        |
        +--> Spotify episode identity + duration
        +--> resume_position_ms
        +--> fully_played
                |
                +--> EpisodeListeningState
                       NOT_STARTED | IN_PROGRESS | COMPLETED
                       resumePositionMs
                       fullyPlayed
                       durationMs
                           |
                           +--> PODCAST-04 eligibility
                           +--> PODCAST-05 show policy / replay / sequence
                           +--> remaining duration
                           +--> planner eligibility
                           +--> strict authoritative re-read before real write
```

### 2.6 Spotify catalog metadata

```text
Spotify track/artist/album/search metadata
        |
        +--> candidate resolution / provider identity
        +--> GenerationItem provider-specific identity
        +--> album review/queue preview
        +--> MUSIC-VERSION-01 classifier inputs
                trackName + albumName
                    |
                    +--> STUDIO_OR_STANDARD | LIVE | UNKNOWN
                            |
                            +--> LIVE multiplier x0.90
                                in controlled discovery resolver/ranking path
```

The classifier itself uses names only. In the productive Spotify resolution path those names are Spotify catalog metadata; the rule is global in that path, not learned per user.

### 2.7 Last.fm

```text
LASTFM history/backfill
        |
        +--> TrackListeningEvent(source=LASTFM_SCROBBLE)
                |
                +--> HISTORY
                +--> DISCOVERY profile
                +--> ALBUM profile
                +--> MUSIC-05 anchors

LASTFM similarity
        |
        +--> ArtistSimilaritySeedState / ArtistSimilarityEdge
                |
                +--> external discovery candidate
                        |
                        +--> Spotify catalog resolution for executable identity
```

Last.fm recommendation evidence and Spotify catalog resolution are distinct origins and should remain distinguishable.

### 2.8 First-party / Sonoriza interaction

Current source contains first-party actions/preferences such as:

```text
NativeSourcePreference
HistoryLikeAction
explicit album queue confirmation
TargetPlaylist policy/configuration
explicit user actions in Sonoriza UI
```

However, **Sonoriza Pulse is not implemented in this audited runtime**. Issue #146 is the planned first-party playback-observation path.

---

## 3. Inventory table

| Source | Endpoint/origin | OAuth scope | Storage | Projection / aggregate | Consumer | Use | Lineage preserved? | Runtime status |
|---|---|---|---|---|---|---|---|---|
| Spotify account identity | `GET /me` during auth | `user-read-email`, `user-read-private` | Auth `Account` + user identity | session/account | auth/UI | DISPLAY, OPERATIONAL | provider is explicit at auth layer | ACTIVE |
| User playlists | `GET /me/playlists` | `playlist-read-private`, `playlist-read-collaborative` | source/config/cache structures | candidate source configuration | UI, ingestion, planner | DISPLAY, OPERATIONAL | provider-specific IDs preserved; no general DataOrigin contract | ACTIVE |
| Playlist items | `GET /playlists/{id}/tracks` | playlist read scopes for private/collab content | source/cache/candidates, GenerationItem evidence | planner candidate pools | planner | OPERATIONAL, PLANNER_ELIGIBILITY | operational provider identity preserved; derived lineage not centralized | ACTIVE |
| Recently Played | `GET /me/player/recently-played` | `user-read-recently-played` | `MusicPlaybackPolicy`, `TrackListeningState`, `TrackListeningEvent` | cooldown, history, profile inputs | MUSIC-01, HISTORY, MUSIC-05, DISCOVERY, ALBUM | BEHAVIORAL_ANALYTICS, USER_PROFILING, PLANNER_ELIGIBILITY, RECOMMENDATION | **partial**: event has source; cooldown state does not | ACTIVE when MUSIC-01 enabled |
| Saved Tracks | `GET /me/tracks` | `user-library-read` | `LikedTrackPreference`, sync/reconciliation state, source cache | `ArtistAffinityEvidence`, `ArtistAffinityState`, liked discovery | native liked source, LIKED-01, SOURCE-LIKED, discovery pilot | OPERATIONAL, USER_PROFILING, RECOMMENDATION, PLANNER_ELIGIBILITY | **insufficient**: SYNC/BACKFILL != data origin; aggregate loses it | ACTIVE sync; reconciliation/pilot gated |
| Explicit Save Track | `PUT /me/tracks?ids=...` | `user-library-modify` | `HistoryLikeAction`, `LikedTrackPreference`, affinity evidence/state | canonical liked state/affinity | HISTORY probable-like confirmation, later affinity consumers | FIRST_PARTY intent + OPERATIONAL provider write | **insufficient**: explicit Sonoriza intent is materialized as `LIKED_TRACK_SYNC` | ACTIVE where UI action enabled |
| Saved Shows | `GET /me/shows` | `user-library-read` | source/cache/candidate state | podcast source universe | podcast planner | DISPLAY, OPERATIONAL | provider identity explicit | ACTIVE for configured source |
| Show episodes | `GET /shows/{id}/episodes` | token; library scope for source relationship where applicable | source/cache/candidate + `EpisodeListeningState` | show policy candidates | PODCAST-04/05 | OPERATIONAL, PLANNER_ELIGIBILITY | Spotify identity explicit; no generic origin field | ACTIVE |
| Episode progress | episode `resume_point` / `GET /episodes/{id}` | `user-read-playback-position` | `EpisodeListeningState` | NOT_STARTED/IN_PROGRESS/COMPLETED, remaining duration | PODCAST-04/05, pre-write revalidation | BEHAVIORAL_ANALYTICS-like state, PLANNER_ELIGIBILITY | semantically Spotify-specific but not typed as DataOrigin | ACTIVE |
| Spotify catalog tracks/artists/albums/search | catalog/search endpoints | no dedicated behavioral scope; authenticated token used | provider IDs/metadata in candidates, cache, GenerationItem, album memory | identity resolution, version classification | planner, discovery resolver, album queue | DISPLAY, OPERATIONAL, RECOMMENDATION/ranking component | provider IDs survive; generic policy lineage absent | ACTIVE |
| Extended Streaming History | user-imported Spotify export package | none (file import) | `SpotifyExtendedHistoryImportRun`, `TrackListeningEvent`, metadata enrichment | HISTORY metrics, profiles/scores | HISTORY, DISCOVERY, ALBUM | USER_IMPORT + SPOTIFY origin; BEHAVIORAL_ANALYTICS, USER_PROFILING, RECOMMENDATION | **partial/mixed**: new event source typed; enriched event can keep another source | IMPORT/MANUAL |
| Last.fm history | Last.fm `user.getRecentTracks` / backfill | Last.fm credentials, not Spotify scope | `LastFmBackfillRun`, `TrackListeningEvent` | history/profile inputs | HISTORY, DISCOVERY, MUSIC-05, ALBUM | BEHAVIORAL_ANALYTICS, USER_PROFILING, RECOMMENDATION | source typed at event root; downstream aggregates can lose it | IMPORT/BACKFILL |
| Last.fm similarity | Last.fm similarity APIs | Last.fm | `ArtistSimilaritySeedState`, `ArtistSimilarityEdge` | external discovery candidates | DISCOVERY | RECOMMENDATION | provider enum preserved until Spotify resolution; derived final candidate needs multi-origin lineage | SHADOW/GATED runtime paths |
| Generic import | `ListeningEventSource.IMPORT` | none | `TrackListeningEvent` | history/profile inputs | HISTORY/DISCOVERY/MUSIC-05/ALBUM | USER_IMPORT, BEHAVIORAL_ANALYTICS | root source preserved; aggregate origin not centralized | IMPORT |
| Generation evidence | internal planner/runtime | n/a | `GenerationRun.summary`, `GenerationLog.data`, `GenerationItem` | diagnostics/reasons | UI/diagnostics/MUSIC-05 | DISPLAY, OPERATIONAL, PLANNER_ELIGIBILITY | `GenerationItem.sourceSpotifyType/sourceSpotifyId` is source configuration, not complete DataOrigin lineage | ACTIVE |
| Inferred skip | internal from GenerationItem order + TrackListeningEvent anchors | n/a | `MusicPreferenceSignal` | pending negative signal/suppression | generation planner | BEHAVIORAL_ANALYTICS, USER_PROFILING, PLANNER_ELIGIBILITY | **no typed origin set**; JSON evidence only | ACTIVE |
| Album opportunity | internal derived profile | n/a | snapshots/cache + `AlbumRecommendationMemory` for lifecycle | `albumOpportunityScore` | Descobrir > Álbuns | RECOMMENDATION | inherits mixed profile lineage; lifecycle memory does not encode score evidence origin | ACTIVE/read UI; explicit writer separate |
| First-party UI/config action | Sonoriza user interaction | n/a | `NativeSourcePreference`, `HistoryLikeAction`, target/config models | planner/product policy | UI/planner | FIRST_PARTY, OPERATIONAL | first-party action exists, but can collapse into provider-like aggregate semantics | ACTIVE |
| Sonoriza Pulse | planned issue #146 | n/a | **not implemented in audited runtime** | planned first-party playback evidence | future HISTORY/MUSIC/DISCOVERY | FIRST_PARTY | future contract | DOCUMENTED_ONLY / FUTURE |

### Retention observations

Static schema/code audit found **no policy-grade retention/deletion contract** attached to the durable behavioral models above (`TrackListeningState`, `TrackListeningEvent`, `LikedTrackPreference`, `ArtistAffinityEvidence/State`, `EpisodeListeningState`, `MusicPreferenceSignal`). Cache structures have freshness/expiry concepts, but that is not equivalent to retention of durable user/history data.

`NEEDS_RUNTIME_VALIDATION`: actual production row ages, cleanup jobs outside audited paths, and deletion behavior on Spotify disconnect should be measured with read-only DB queries in a later gate before any destructive change.

---

## 4. Models/tables affected

### Direct provider/auth/source state

- `Account` — Spotify provider account, token/scope context.
- `SourcePlaylist` — configured Spotify source identity/type.
- `SpotifySourceCacheItem` — provider-source cache/snapshot/metadata/freshness.
- `MusicIngestionRule` / `MusicIngestionRun` — playlist/saved-track ingestion configuration and diagnostics.

### MUSIC-01 / HISTORY

- `MusicPlaybackPolicy`
  - `enabled`
  - `windowValue`
  - `windowUnit`
  - `historyKnownSince`
  - `lastSyncAt`
  - `syncAfterCursor`
- `TrackListeningState`
  - `spotifyTrackId`
  - `spotifyUri`
  - `lastPlayedAt`
  - **no source/provenance**
- `TrackListeningEvent`
  - Spotify IDs/URI
  - canonical-ish name/MBID/ISRC evidence
  - `playedAt`
  - `source: ListeningEventSource`
  - `sourceEventKey`
  - `contextType`, `contextUri`
  - `metadata`
- `LastFmBackfillRun`
- `SpotifyExtendedHistoryImportRun`

### LIKED / affinity

- `LikedTrackPreference`
  - Spotify track/artist/album identity
  - `isLiked`
  - `firstProvenance`, `lastProvenance`
  - enum values are `LIKED_TRACK_BACKFILL` / `LIKED_TRACK_SYNC`
- `ArtistAffinityEvidence`
  - `type=LIKED_TRACK`
  - Spotify track + artist IDs
  - same SYNC/BACKFILL provenance enum
- `ArtistAffinityState`
  - `likedTrackCount`
  - `active`
  - no evidence/provider-origin breakdown
- `ArtistSimilaritySeedState`
- `ArtistSimilarityEdge`
- `NativeSourcePreference`

### MUSIC-05

- `MusicPreferenceSignal`
  - `type=INFERRED_SKIP`
  - `spotifyTrackId`
  - generation/target/position identity
  - `confidence`
  - `evidence Json?`
  - no typed origin/provider set

### Podcast

- `EpisodeListeningState`
  - `spotifyEpisodeId`, `spotifyUri`
  - `durationMs`
  - `resumePositionMs`
  - `fullyPlayed`
  - `status = NOT_STARTED | IN_PROGRESS | COMPLETED`

### Generation / diagnostics / derived evidence

- `GenerationRun.summary`
- `GenerationLog.data`
- `GenerationItem`
  - `spotifyUri`, `spotifyTrackId`, `primaryArtistId`, `albumId`
  - `resumePositionMs`
  - `sourceSpotifyType`, `sourceSpotifyId`, `sourceIncludePlayed`
- `TargetScheduleRun.details`
- `TargetScheduleAttempt.details`

### Album

- `AlbumRecommendationMemory`
  - `spotifyAlbumId`
  - recommendation lifecycle state
  - queue/write memory (`queued...`, `source`)

### Important interpretation warning

Fields named `source`, `provenance`, or `native` are **not equivalent contracts**:

- `TrackListeningEvent.source` = primary listening-event source;
- `GenerationItem.sourceSpotifyType/sourceSpotifyId` = configured collection source;
- `LikedTrackPreference.first/lastProvenance` = sync/backfill lifecycle provenance;
- `NativeSourcePreference` = product source configuration;
- `AlbumRecommendationMemory.source` = queue/lifecycle writer source;
- JSON `reason` / `resolutionReason` / `evidence` = diagnostics/explanation.

None is currently a universal `DataOrigin + AllowedUses` contract.

---

## 5. Code paths

### High-priority productive paths

| File | Function/path | Responsibility | Origin | Consumer |
|---|---|---|---|---|
| `src/lib/auth.ts` | Spotify NextAuth provider config | OAuth scopes + `/v1/me` account identity | SPOTIFY | auth/session |
| `src/services/spotify/recently-played.ts` | `syncRecentlyPlayed()` | read Recently Played; update cooldown state + canonical events | SPOTIFY | MUSIC-01, HISTORY |
| `src/services/spotify/recently-played.ts` | `loadMusicRepeatContext()` | query `TrackListeningState` cutoff and blocked IDs | SPOTIFY-derived state | planner eligibility |
| `src/services/spotify/recently-played.ts` | `filterMusicCandidatesForRepeat()` | remove recently heard tracks | SPOTIFY-derived state | planner |
| `src/jobs/music-repeat-runtime.ts` | repeat revalidation | MUSIC-01 runtime/pre-write protection | SPOTIFY-derived state | generation |
| `src/services/music-preference/analyze.ts` | `analyzeAndRecordInferredSkips()` | persist MUSIC-05 signals for non-simulation run | MIXED event history | `MusicPreferenceSignal` |
| `src/services/music-preference/analyze.ts` | `loadPendingInferredSkips()` | load persisted + current preview signals | MIXED | generation |
| `src/services/music-preference/analyze.ts` | `analyzeCurrentInferredSkips()` | query GenerationItem + TrackListeningEvent anchors **without source filter** | MIXED | infer-skips |
| `src/jobs/generate-playlists-incremental.ts` | `generatePlaylists()` | runs MUSIC-05 analysis; converts pending signals to blocked track IDs | MIXED | planner |
| `src/services/music-preference/infer-skips.ts` | skip inference | detect planned sequence gaps | MIXED anchors + internal plan | negative signal |
| `src/services/music-preference/liked-track-incremental-sync.ts` | liked sync | read `/me/tracks`, persist mirror | SPOTIFY | LIKED-01/SOURCE-LIKED |
| `src/services/music-preference/liked-track-affinity.ts` | affinity materialization | Saved Tracks -> affinity evidence/state | SPOTIFY | discovery/affinity |
| `src/jobs/liked-track-reconciliation.ts` | periodic reconciliation | full Saved Tracks provider scan + local apply; master flag + user allowlist | SPOTIFY | liked canonical state |
| `src/services/music-preference/liked-discovery-pilot-runtime.ts` | controlled runtime | liked-derived expansion -> calibrated candidate -> Spotify revalidation -> discovery planner path | SPOTIFY + LASTFM/mixed | planner pilot |
| `src/services/listening-history/probable-like-action.ts` | `confirmProbableLike()` | explicit Sonoriza LIKE -> Spotify save -> canonical liked/affinity | FIRST_PARTY action + SPOTIFY write | affinity/provider library |
| `src/services/music-discovery/complete-profile-batched.ts` | complete profile | aggregate listening history/profile components | MIXED | scoring |
| `src/services/music-discovery/scoring.ts` | scoring | familiar/rediscovery/discovery score components | MIXED | discovery ranking |
| `src/jobs/discovery-runtime.ts` | discovery runtime Gate 5H | feature-gated profile/ranking/reordering | MIXED | generation planner |
| `src/services/album-discovery/profile.ts` | album profile | history/affinity/coverage/negative inputs | MIXED | album score |
| `src/services/album-discovery/opportunity.ts` | opportunity scoring | `albumOpportunityScore` | MIXED | Descobrir > Álbuns |
| `src/services/album-discovery/queue-operation.ts` | `getAlbumQueueReview()` | read-only album/playlist preview | SPOTIFY | UI/review |
| `src/services/album-discovery/queue-operation.ts` | `executeAlbumQueueWrite()` | explicit verified append + queue memory | SPOTIFY operational | playlist write |
| `src/services/music-discovery/track-version-preference.ts` | classifier | classify track/album names | catalog metadata | version rule |
| `src/services/music-discovery/track-version-score-policy.ts` | score policy | LIVE x0.90 | classified catalog metadata | discovery ranking |
| `src/services/music-discovery/track-version-score-runtime.ts` | runtime application | apply multiplier + reason | catalog metadata | controlled discovery runtime |
| `src/services/spotify/podcast-listening-state.ts` | state mapping/store | map resume/completion to canonical episode state | SPOTIFY | podcast planner |
| `src/services/spotify/podcast-authoritative-state.ts` | pre-write state check | authoritative episode state re-read | SPOTIFY | write gate |
| `src/services/spotify/podcast-show-policy.ts` | show policy | apply listened/replay/sequence policy | SPOTIFY-derived episode state + first-party config | planner |
| `src/services/spotify-extended-history/persistence-writer.ts` | history writer/reconciler | insert or enrich canonical events | SPOTIFY / MIXED | HISTORY + downstream analytics |
| `src/services/lastfm/import-history.ts` | Last.fm backfill | persist canonical events | LASTFM | HISTORY + downstream analytics |
| `src/services/spotify/client.ts` | provider client | playlist/library/catalog/recent/podcast reads + playlist writes | SPOTIFY | operational runtime |
| `src/services/spotify/incremental-reader.ts` | source cursor | incremental playlist/liked/podcast reads | SPOTIFY | candidate collection |
| `src/services/spotify/source-cache.ts` | source cache | cache/snapshot/freshness | SPOTIFY | source collection |

### Runtime classification notes

- **MUSIC-01**: ACTIVE when `MusicPlaybackPolicy.enabled`.
- **MUSIC-05**: ACTIVE in real generation; simulations use read-only current-inference preview.
- **DISCOVERY-01**: GATED_ACTIVE via feature flags/allowlists/target policy.
- **Liked full reconciliation**: IMPLEMENTED but master flag defaults off; allowlist-gated.
- **Liked discovery**: CONTROLLED_RUNTIME pilot, gated by base discovery + master flag + user + target allowlists.
- **Spotify Extended History**: IMPORT/MANUAL path, not continuous provider polling.
- **Last.fm historical import**: BACKFILL/IMPORT path.
- **Probable-like ranking**: shadow-derived ranking; explicit confirmation action exists separately.
- **Album queue write**: explicit operational action with preview/snapshot/fingerprint/confirmation safeguards.

---

## 6. AI boundary

### Paths found

| Potential path | Status | Finding |
|---|---|---|
| Spotify raw response -> OpenAI/LLM | NOT_FOUND | no runtime integration identified |
| TrackListeningEvent -> AI | NOT_FOUND | no consumer path to AI identified |
| Artist/profile/affinity DTO -> AI | NOT_FOUND | no runtime AI boundary identified |
| GenerationRun/summary -> AI | NOT_FOUND | no external intelligence export identified |
| MusicPreferenceSignal -> Tião Brain | FUTURE_CONTRACT_ONLY | schema comment explicitly anticipates possible future consumer, but no implementation found |
| UI “Tião Brain” explanation path | NOT_FOUND | no service/package/config path found in audited source |

### Current conclusion

**There is no real Spotify -> IA/Tião Brain integration in the audited runtime.**

This is stronger than “apparently”: package dependencies, provider/env surfaces, repository tree and the audited consumers were checked. The remaining uncertainty is deployment drift, not an identified source-code path.

### Later validation if needed

`NEEDS_RUNTIME_VALIDATION` only if production may differ from `main`:

1. read deployed Git SHA;
2. list runtime env variable names only (not secret values) and process/service inventory;
3. run read-only repository grep/AST over the deployed SHA for external AI SDKs/endpoints/contracts;
4. confirm no outbound service dedicated to Brain/LLM.

No Spotify/user payload should be sent during that validation.

---

## 7. OAuth scopes

Current scopes from `src/lib/auth.ts`:

| Scope | Configured for | Feature that depends on it today | Technically necessary today? | Data obtained / action |
|---|---|---|---|---|
| `user-read-email` | Spotify OAuth | account/session identity | Yes for current auth profile flow | account email |
| `user-read-private` | Spotify OAuth | account/session identity | Yes for current auth profile flow | private profile/account attributes |
| `playlist-read-private` | Spotify OAuth | read configured/private playlists | Yes for current source-management behavior | private playlists/items as authorized |
| `playlist-read-collaborative` | Spotify OAuth | collaborative playlist source read | Yes if collaborative sources remain supported | collaborative playlists/items |
| `playlist-modify-public` | Spotify OAuth | target/queue playlist writes | Yes for public playlist writes | write action |
| `playlist-modify-private` | Spotify OAuth | target/queue playlist writes | Yes for private playlist writes | write action |
| `user-read-playback-position` | Spotify OAuth | podcast resume/completion state | Yes for current PODCAST-04/05 behavior | episode resume position / fully played state |
| `user-read-recently-played` | Spotify OAuth | MUSIC-01 + HISTORY recent ingestion | Yes for current behavior; **future minimization candidate after analytics split** | recent listening history/context |
| `user-library-read` | Spotify OAuth | Saved Tracks and saved-show/library sources | Yes for current liked/podcast-library behavior; **future minimization candidate depending on retained capabilities** | saved tracks/shows/library |
| `user-library-modify` | Spotify OAuth | explicit probable-like “save to Spotify” action | Yes only if that explicit provider write remains a feature; **future minimization candidate otherwise** | library write |

Not found/requested:

- `user-top-read`
- `user-read-playback-state`
- `user-modify-playback-state`
- streaming/Web Playback scope

No scope should be removed in Gate 1.

---

## 8. Playback control audit

### Present

- `GET /me/player/recently-played` — **data query**, not control.
- podcast episode playback-position reads — **data query**.
- playlist reads/writes — **playlist management**.
- Spotify library save — **library management**.

### Not found

- Play
- Pause
- Next
- Previous
- Seek/start/resume playback
- Transfer playback
- Queue control
- Web Playback SDK
- Spotify Connect playback control

### Conclusion

The audited source matches a **non-streaming playlist manager/orchestrator architecture** from a playback-control perspective. Gate 1 found no code that makes Sonoriza a Spotify playback controller.

---

## 9. Lineage gaps

### Gap 1 — `TrackListeningState`

**Where lineage is lost:** `syncRecentlyPlayed()` -> `TrackListeningState`.

The row stores `spotifyTrackId`, `spotifyUri`, `lastPlayedAt`; no origin. MUSIC-01 consumes the state directly.

**Can answer “is this cooldown Spotify-derived?” today?** Only by knowing the writer implementation, not from the row itself.

### Gap 2 — mixed `TrackListeningEvent`

**Where singular origin becomes insufficient:** Extended History reconciliation can enrich an existing event and keep its existing primary `source`.

**Can answer “which providers contributed evidence to this event?” today?** Not reliably from `source`; must inspect provider-specific JSON metadata/reconciliation history.

### Gap 3 — DISCOVERY profile/scoring

Event-level source can exist, but complete profiles aggregate play counts, recent windows, historical/recent affinity, momentum, rediscovery and related metrics before scoring.

**Can exclude Spotify today using a single central policy?** No. Current profile builders do not expose a central `AllowedOrigins`/policy filter that propagates through every metric and signal.

### Gap 4 — `MusicPreferenceSignal`

MUSIC-05 anchors are queried across all `TrackListeningEvent` sources. The resulting signal has JSON evidence but no typed `origins` set.

**Can answer “was this skip signal derived exclusively from Last.fm/Pulse/non-Spotify evidence?” today?** Not from typed fields.

### Gap 5 — Saved Tracks vs explicit Sonoriza preference

`LikedTrackPreferenceProvenance` is lifecycle provenance (`BACKFILL`/`SYNC`), not user-intent/provider origin. `confirmProbableLike()` writes an explicit Sonoriza choice using `LIKED_TRACK_SYNC` after saving to Spotify.

**Can answer “was this artist affinity created because the user explicitly chose it in Sonoriza or because Spotify Saved Tracks contained it?” today?** Not reliably from `ArtistAffinityState`; the aggregate has no such field.

### Gap 6 — “native liked tracks” naming

`NativeSourcePreference(type=LIKED_TRACKS)` is a Sonoriza configuration preference. The source payload it enables is still Spotify Saved Tracks.

A consumer can mistake “native/local projection” for “first-party origin” unless Gate 2 separates those concepts explicitly.

### Gap 7 — Generation diagnostics

`GenerationRun.summary`, `GenerationLog.data`, `GenerationItem` and `resolutionReason` can contain derived evidence/reasons from multiple sources. They are auditable but not policy-bearing lineage.

### Gap 8 — Podcast state

`EpisodeListeningState` is semantically Spotify-derived and keyed by Spotify episode identity, but lacks a generic origin/policy classification. This is currently safe only because its implementation is provider-specific; it is not future-proof for a provider-neutral policy engine.

---

## 10. Existing safeguards reusable in Gate 2

### Strong/reusable pieces

1. **`ListeningEventSource` enum**
   - `SPOTIFY_RECENTLY_PLAYED`
   - `SPOTIFY_EXTENDED_HISTORY`
   - `LASTFM_SCROBBLE`
   - `IMPORT`

   This is the best current root source signal and should map into the central origin contract rather than be replaced gratuitously.

2. **Canonical event idempotency**
   - `sourceEventKey`
   - unique `(userId, source, sourceEventKey)`

3. **Provider-specific source typing**
   - `SpotifySourceType`
   - source IDs / cache/snapshot metadata

4. **Canonical-ish identity evidence**
   - Spotify IDs plus ISRC/MBID/name/album evidence in history/discovery resolution paths.

5. **Reasons/evidence**
   - `MusicPreferenceSignal.evidence`
   - planner/reconciliation reasons
   - `resolutionReason`
   - generation summaries/log data

   Useful for diagnostics, but should not be the enforcement mechanism alone.

6. **Feature gates/allowlists**
   - discovery runtime gating
   - liked reconciliation master flag + user allowlist
   - liked-discovery master/user/target allowlists

7. **Shadow/runtime separation**
   - many discovery/liked/history paths already distinguish reports/shadow from productive influence.

8. **Explicit write safeguards**
   - album queue writer requires preview, expected snapshot, fingerprint and confirmation, and verifies append after write.

9. **First-party action records**
   - `HistoryLikeAction` is a concrete place where explicit Sonoriza intent already exists and can be separated from provider mirror state.

### Not sufficient as the central safeguard

- a single `source` enum on an aggregate;
- JSON metadata only;
- `native` naming;
- provider-specific IDs;
- `resolutionReason`;
- lifecycle provenance `SYNC/BACKFILL`.

---

## 11. Recommendations for Gate 2 — proposal only

**Do not implement in Gate 1.**

The smallest central contract that appears sufficient is a **typed origin set + typed use classification at derivation boundaries**, reusing existing source enums.

Conceptual shape:

```ts
type DataOrigin =
  | "FIRST_PARTY"
  | "SPOTIFY"
  | "LASTFM"
  | "OTHER_PROVIDER"
  | "USER_IMPORT"
  | "UNKNOWN";

type PolicyUse =
  | "DISPLAY"
  | "OPERATIONAL"
  | "BEHAVIORAL_ANALYTICS"
  | "USER_PROFILING"
  | "RECOMMENDATION"
  | "PLANNER_ELIGIBILITY"
  | "AI"
  | "EXTERNAL_EXPORT";

type Lineage = {
  origins: readonly DataOrigin[];
  evidenceRefs?: readonly string[];
};
```

Then one central policy function/guard, conceptually:

```ts
isUseAllowed(lineage, use, policyContext)
```

### Minimum Gate 2 scope

1. Define deterministic mapping from existing roots:
   - `ListeningEventSource.SPOTIFY_* -> SPOTIFY`
   - `LASTFM_SCROBBLE -> LASTFM`
   - `IMPORT -> USER_IMPORT` plus imported-provider metadata where known
   - explicit Sonoriza actions -> FIRST_PARTY.
2. Define how **MIXED** is represented: prefer `origins: Set<DataOrigin>` rather than a lossy single enum.
3. Make the critical derived boundaries able to expose/accept lineage:
   - MUSIC-01 cooldown projection;
   - HISTORY profile/analytics builders;
   - MUSIC-05 inferred signals;
   - LIKED/ArtistAffinity materialization;
   - DISCOVERY profile/scoring;
   - ALBUM opportunity profile;
   - podcast planner state if policy requires it.
4. Define capability/use matrix for each origin **without changing behavior yet**.
5. Add contract tests that prove an aggregate cannot silently erase `SPOTIFY` from its origin set.
6. Reserve a single AI/export boundary with deny-by-origin contract even though no AI runtime exists yet.

### Avoid in Gate 2

- broad provider refactor;
- destructive historical migration before necessity is proven;
- removal of Spotify operational capabilities;
- immediate rewrite of every JSON diagnostic;
- implementation of Pulse;
- retention/deletion cleanup;
- OAuth scope reduction.

Gate 2 should establish the minimum policy vocabulary first; later gates can migrate/enforce each consumer incrementally.

---

## 12. Affected issues

| Issue | Relationship found in Gate 1 | Gate consequence |
|---|---|---|
| #278 SPOTIFY-COMPLIANCE-01 | central gate | keep open; Gate 1 complete after review; Gate 2 not started |
| #277 MUSIC-06 | design expands skip/profile behavior from Spotify recent/history | **remain blocked** by #278 |
| #34 MUSIC-01 | Spotify Recently Played -> `TrackListeningState.lastPlayedAt` -> cooldown | must become origin-aware before compliant variant relies on it |
| #55 PODCAST-04 | Spotify episode progress/completion -> eligibility | capability decision required; no change in Gate 1 |
| #89 MUSIC-05 | active inferred skip uses cross-provider canonical anchors and affects planner | must tag/filter evidence origin before expansion |
| #90 HISTORY-01 | Last.fm + canonical history consumer/source | preserve Last.fm origin through aggregates; retention review later |
| #99 HISTORY-02 | Spotify Extended import/reconciliation | mixed-event lineage is a concrete Gate 2 requirement |
| #102 ALBUM-01 | opportunity ranking inherits history/affinity lineage | recommendation score must consume allowed evidence only |
| #103 DISCOVERY-01 | complete profile and scoring aggregate mixed history | major Gate 2 consumer |
| #146 HISTORY-03 / Sonoriza Pulse | planned first-party playback evidence | strategically compatible first-party source; not implemented now |
| #158 ALBUM-UI | exposes ALBUM-01 ranking; explicit add action is separate operational write | UI must not present restricted derived ranking in compliant mode; explicit writer can remain separate |
| #160 DISCOVERY-UI | exposes DISCOVERY-01 personalized ranking | must inherit provenance/capability filtering from service, not reimplement in UI |
| #184 LIKED-01 | Saved Tracks -> artist affinity | major origin/intent separation requirement |
| #185 HISTORY-04 | probable-like/history-derived UX and explicit like action | separate derived recommendation evidence from first-party confirmation |
| #186 SOURCE-LIKED | local/native projection is backed by Spotify Saved Tracks; controlled runtime pilot exists | do not equate local projection with FIRST_PARTY origin |
| #200 MUSIC-VERSION-01 | Spotify-resolved name/album metadata -> global LIVE x0.90 in controlled discovery path | inventory only now; Gate 2 classifies operational metadata vs recommendation use |
| #205 ONBOARDING-01 | proposes Spotify connection + discovery/repetition presets and permission explanation | onboarding must consume the future compliant capability matrix/scopes; not a blocker for Gate 1 |
| #207 PROVIDER-01 | already proposes provider boundary/provenance/capabilities | **strong architectural overlap; Gate 2 should reuse/align, not create competing abstractions** |
| #237 PODCAST-05 | show policy consumes `EpisodeListeningState` and replay state | policy remains functionally valid but source capability must be explicit |

### Should another issue enter #278 gate?

No additional issue outside the required reconciliation list was proven to be a new **hard blocker** by the static Gate 1 audit.

Two coordination notes:

- The Descobrir parent/container should inherit restrictions from #158/#160 rather than invent its own filtering.
- Any future external/provider discovery issue that resolves a recommendation through Spotify should preserve the distinction between **recommendation origin** and **Spotify operational catalog resolution**; #207 is the natural architecture owner for that separation.

---

## DISCOVERY-01 metric provenance matrix

The current complete-profile/scoring layer consumes canonical history and derived signals. At Gate 1 level:

| Metric/component | Can use Spotify today? | Can use Last.fm today? | Mixed possible? | Can current code centrally exclude Spotify? | Current provenance representation |
|---|---:|---:|---:|---:|---|
| `historicalPlayCount` | Yes | Yes | Yes | No central policy filter | event source before aggregation |
| `plays7d` | Yes | Yes | Yes | No central policy filter | event source before aggregation |
| `plays30d` | Yes | Yes | Yes | No central policy filter | event source before aggregation |
| `plays90d` | Yes | Yes | Yes | No central policy filter | event source before aggregation |
| `plays365d` | Yes | Yes | Yes | No central policy filter | event source before aggregation |
| `historicalAffinity` | Yes | Yes | Yes | Not centrally | derived profile fields/reasons |
| `recentAffinity` | Yes | Yes | Yes | Not centrally | derived profile fields/reasons |
| `momentum` | Yes | Yes | Yes | Not centrally | derived score/profile |
| `rediscoveryScore` | Yes | Yes | Yes | Not centrally | derived score/reasons |
| `skipCount` | Yes indirectly through mixed anchors/signals | Yes indirectly | Yes | No typed origin filter on signal | `MusicPreferenceSignal.evidence` JSON |
| `negativeSignalCount` | Yes indirectly | Yes indirectly | Yes | No typed origin filter on signal | signal type/evidence, not origin set |
| conversion metrics | May inherit Spotify-resolved/generated/listening evidence | Can inherit non-Spotify evidence | Yes | No central use-policy filter | generation/history evidence/reasons |

A technically correct “exclude Spotify” variant needs **recomputation from allowed roots/evidence**, not merely filtering final scores.

---

## ALBUM-01 component provenance

| Component | Current possible origins | Observation |
|---|---|---|
| `artistAffinity` | SPOTIFY Saved Tracks, explicit Sonoriza confirmation collapsed into liked state, potentially other future evidence | `ArtistAffinityState` lacks origin breakdown |
| `albumCoverage` / `knownTrackCount` | canonical history + Spotify catalog identity | history origin can be mixed; catalog resolution is operational metadata |
| recent momentum / rediscovery | MIXED canonical history | inherits DISCOVERY lineage gap |
| historical/recent plays | SPOTIFY, LASTFM, USER_IMPORT, MIXED | requires origin-aware aggregation |
| negative signals | MUSIC-05 mixed anchors | signal has no typed origin set |
| `albumOpportunityScore` | derived from the above | recommendation inherits all upstream origins |

Separate operational action:

`executeAlbumQueueWrite()` does not need to be conflated with the recommendation score. It rebuilds/revalidates the Spotify album/playlist preview, requires expected snapshot/fingerprint + confirmation, performs one explicit append, verifies it, and only then persists queue memory.

---

## MUSIC-VERSION-01 audit

Classifier:

```text
STUDIO_OR_STANDARD
LIVE
UNKNOWN
```

Inputs:

- `trackName`
- `albumName`

Current policy:

```text
LIVE -> x0.90
STUDIO_OR_STANDARD -> x1.00
UNKNOWN -> x1.00
```

Findings:

- In Spotify resolution paths, classifier metadata originates from Spotify catalog responses.
- The multiplier is a **global rule in the controlled discovery resolver/ranking path**, not a learned per-user preference.
- The standalone shadow reports do not affect the planner by themselves.
- `track-version-score-runtime.ts` can apply the multiplier to resolved discovery candidates and appends an explanation to `resolutionReason`.
- Gate 1 made no policy change.

---

## Source-level preservation summary

| Structure | Root source preserved? | Mixed evidence representable? | Policy-grade allowed-use info? |
|---|---:|---:|---:|
| `TrackListeningEvent.source` | Yes | **No, not by source alone** | No |
| `TrackListeningEvent.metadata` | Sometimes | Partially/untyped | No |
| `TrackListeningState` | No | No | No |
| `LikedTrackPreference.first/lastProvenance` | Lifecycle only | No | No |
| `ArtistAffinityEvidence.first/lastProvenance` | Lifecycle only | No | No |
| `ArtistAffinityState` | No | No | No |
| `MusicPreferenceSignal.evidence` | Untyped JSON | Potentially descriptive | No |
| `GenerationItem.sourceSpotifyType/sourceSpotifyId` | Collection source | Not full lineage | No |
| `GenerationRun.summary` / reasons | Diagnostic | Potentially | No |
| `EpisodeListeningState` | Implicitly Spotify-specific | No | No |
| `ArtistSimilarityEdge.provider` | Yes (`LASTFM`) | Not after downstream merge by itself | No |

### Direct answer to the key provenance question

> Can we answer today whether an `ArtistAffinityState` was produced exclusively by Last.fm, exclusively by Spotify, by explicit preference, or by a mixture?

**No.**

For the current LIKED implementation, `ArtistAffinityState` is specifically backed by active `ArtistAffinityEvidence(type=LIKED_TRACK)`, but:

- that evidence provenance only says `LIKED_TRACK_BACKFILL` or `LIKED_TRACK_SYNC`;
- the aggregate drops even that lifecycle provenance;
- an explicit Sonoriza probable-like confirmation is also materialized as `LIKED_TRACK_SYNC` after the provider write.

Therefore the final state cannot distinguish **Spotify mirror** from **explicit Sonoriza first-party intent** using a policy-grade field.

---

## NEEDS_RUNTIME_VALIDATION backlog

No runtime validation was required to establish the major static findings, but these questions cannot be closed from source alone:

1. **Deployed SHA parity** — confirm production is actually on `46ceedac...` or identify drift.
2. **Feature flag state** — which users/targets currently have DISCOVERY and liked pilot/reconciliation enabled.
3. **Durable retention** — oldest/current counts and cleanup behavior for listening events/states/likes/signals/podcast state.
4. **Disconnect behavior** — what durable Spotify-derived rows remain after provider account disconnect/deletion request.
5. **Actual mixed-event prevalence** — count canonical `TrackListeningEvent` rows where primary `source != SPOTIFY_EXTENDED_HISTORY` but `metadata.spotifyExtendedHistory` exists.
6. **Affinity provenance prevalence** — counts of active liked preferences/evidence by current lifecycle provenance and actions created via `HistoryLikeAction`.
7. **Runtime AI drift** — only if deployed services differ from repository main; verify process/env names and deployed repository SHA without exposing secrets or user payloads.

All of these can be answered with read-only SQL/repository reports in a later approved step. No diagnostic runtime access was performed in this Gate 1 execution.

---

## Gate 1 stop condition

Gate 1 inventory is complete at the source/schema level.

**Stopped before:**

- migrations;
- provenance model implementation;
- capability guard implementation;
- AI hard guard implementation;
- DISCOVERY/MUSIC-01/MUSIC-05 behavior changes;
- retention/deletion work;
- OAuth scope changes;
- provider refactor;
- merge;
- deploy.

**Gate 2 is proposed, not started.**

**#277 must remain blocked.**
