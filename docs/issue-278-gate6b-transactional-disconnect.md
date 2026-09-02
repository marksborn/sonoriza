# #278 — Gate 6B — transactional Spotify disconnect

## Status

Implemented on `issue-278-gate6-retention-disconnect` after Gate 6A. This gate adds the destructive **local** executor, but does not expose it through a public UI/API and does not execute it for any production user.

No Prisma schema change or migration is part of Gate 6B.

## Goal

Turn the Gate 6A retention preview into an auditable, fail-closed disconnect operation that can remove local Spotify credentials and provider-derived data without deleting the Sonoriza account or laundering Spotify lineage into retained first-party state.

The operation is deliberately split into two phases:

1. `prepareSpotifyDisconnect(userId)` produces the current inventory, preview, SHA-256 fingerprint and exact confirmation phrase.
2. `executeSpotifyDisconnect(...)` re-inventories inside a serializable transaction and only mutates if the caller supplies the fingerprint and exact phrase for that still-current snapshot.

## Authorization boundary

The fingerprint includes:

- retention contract version;
- Sonoriza `userId`;
- every inventory count, sorted deterministically.

The confirmation phrase is:

```text
DISCONNECT SPOTIFY <FIRST_12_HEX_OF_FINGERPRINT>
```

Both are required.

If the database inventory changes between preview and execution, the executor throws `DATA_POLICY_SPOTIFY_DISCONNECT_PREVIEW_CHANGED` before the first mutation. A caller must generate a fresh preview and obtain a fresh confirmation phrase.

An integration test creates new configuration after preview and proves the stale request leaves both the Spotify OAuth row and the new configuration untouched.

## Concurrency and transaction

The real executor uses a Prisma interactive transaction at PostgreSQL `SERIALIZABLE` isolation.

Before re-inventorying, it obtains `SHARE ROW EXCLUSIVE` locks on every table that the disconnect can read/write for retention. This intentionally favors correctness over concurrency because disconnect is rare and destructive. The locks block concurrent provider/cron writers during snapshot, purge and postcheck while ordinary reads may continue.

Integration tests inject a no-op lock function so validating Gate 6B against a live database does not globally block production writers. The production executor keeps the real locks.

## Retention contract expansion discovered in 6B

The 6B audit found provider-bearing state that was not explicit in the initial 6A inventory. Contract version 3 now includes it.

### Runtime payload cleared

- Auth.js `User.name` / `User.image`: origin is not typed, so they are cleared conservatively. `User.id` and email remain because disconnect is not account deletion.
- `SourcePlaylist.name`, cached candidates, Spotify snapshot and cache timestamp.
- `MusicPlaybackPolicy.historyKnownSince`, `lastSyncAt`, `syncAfterCursor`.
- `PodcastShowPolicy.sequenceCursorEpisodeId`, completion flag, random round and consumed episode IDs.
- `MusicIngestionRule.sourceName`, runtime state, capability response and sync timestamps.

The user-authored policy/configuration rows themselves remain.

### Provider-derived rows deleted

- Spotify `Account` row, including local access/refresh token, **last in the mutation sequence**;
- `TrackListeningState`;
- pure `SPOTIFY_RECENTLY_PLAYED` / `SPOTIFY_EXTENDED_HISTORY` `TrackListeningEvent` rows;
- `SpotifyExtendedHistoryImportRun`;
- `EpisodeListeningState`;
- `LikedTrackPreference`;
- `ArtistAffinityEvidence`;
- `ArtistAffinityState`;
- Spotify-rooted `ArtistSimilaritySeedState` and `ArtistSimilarityEdge`;
- `MusicPreferenceSignal` (current `INFERRED_SKIP` lineage);
- `AlbumRecommendationMemory`.

### Mixed listening lineage sanitized

A non-Spotify listening row is retained when it is independently sourced, such as a Last.fm scrobble, but Spotify-bearing enrichment is removed:

- `spotifyTrackId` / `spotifyUri`;
- `primaryArtistId` / Spotify `albumId`;
- Spotify context URI/type;
- `metadata.spotifyExtendedHistory`;
- `albumName` when an Extended History marker proves the field may have been introduced by Spotify enrichment.

Other metadata keys remain. The executor does not invent a pre-enrichment album name that the schema never recorded.

### Audit rows preserved after redaction

The following rows keep structural/timing/explicit-user information but lose provider payload:

- `MusicSourceCleanupRun`;
- `MusicIngestionRun`;
- `TargetScheduleRun` / `TargetScheduleAttempt`;
- `GenerationRun` / `GenerationItem` / `GenerationLog`;
- `ProbableLikePilotFeedback`;
- `HistoryLikeAction`;
- `HistoryProbableLikeDismissal`.

For History rows, explicit verdict/confirmation/dismissal timing survives. Spotify track/artist identity, catalog text and ranking score/reasons are replaced with deterministic redacted placeholders or neutral values.

For `GenerationItem`, the structural run/target/position/content type survives, while URI, catalog text, provider identities, source IDs, resume/original duration and `durationMs` are redacted/zeroed.

## First-party configuration preserved

The postcheck protects row counts for:

- `User`;
- `SourcePlaylist`;
- `TargetPlaylist`;
- `MusicPlaybackPolicy`;
- `PodcastShowPolicy`;
- `MusicIngestionRule`;
- cleanup/ingestion/schedule/generation audit rows;
- History explicit feedback/action/dismissal rows;
- `FirstPartyPlaybackPreference`;
- `NativeSourcePreference`.

Stable Spotify IDs that are deliberately part of a user-authored binding may remain for reconnect, including source/target/rule bindings and explicit podcast start selection. Retaining the binding does not authorize provider access while the OAuth account is absent.

## Postcheck

Before commit, the executor re-runs the same inventory and requires every dataset whose retention action is not `RETAIN_FIRST_PARTY` to have zero remaining affected rows.

It also compares the preservation snapshot before/after. Any unexpected loss of retained row count throws `DATA_POLICY_SPOTIFY_DISCONNECT_POSTCHECK_FAILED`, causing the transaction to roll back.

Expected final state after a successful local disconnect:

- no local Spotify OAuth account/token;
- no provider-derived behavioral/profile rows covered by the contract;
- no Spotify enrichment on independently sourced history;
- no provider payload in retained audit/runtime fields covered by the inventory;
- Sonoriza user and preserved configuration still present.

## What Gate 6B does not do

- no public disconnect button or route;
- no automatic execution for the current production user;
- no Spotify-side token revocation HTTP call;
- no full Sonoriza account deletion flow;
- no deletion of preserved first-party preferences/configuration;
- no schema/migration change;
- no merge/deploy in this gate without separate authorization.

## Validation

Added pure tests for:

- deterministic fingerprint;
- fingerprint changes with inventory;
- stale preview rejection;
- exact confirmation requirement;
- provider-residue postcheck;
- first-party row-count preservation postcheck.

Added integration coverage with synthetic users for:

- wrong confirmation leaves credentials intact;
- successful local disconnect across representative provider datasets;
- mixed Last.fm + Spotify Extended History sanitation;
- first-party configuration survival;
- redacted History/generation audit survival;
- optional Auth profile cleanup and generation duration redaction;
- stale preview rejection before mutation.

The integration tests intentionally operate only on synthetic users created inside the test and clean them up afterwards.

Full repository validation still needs to be run from an isolated worktree on the final Gate 6B SHA before merge/deploy.

## Next boundary

A later Gate 6C can add an operator/user-facing prepare/confirm flow, decide whether provider-side revocation is required/available, and exercise a real disconnect only after the exact production preview is explicitly authorized. Full Sonoriza account deletion remains a separate product/legal operation from provider disconnect.
