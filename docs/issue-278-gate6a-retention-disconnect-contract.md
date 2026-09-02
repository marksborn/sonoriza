# #278 — Gate 6A: retention / deletion / disconnect contract

## Status

Implemented on branch `issue-278-gate6-retention-disconnect` from Gate 5 production/main SHA `94f6a1dde9091037449e3911a4e7113dc2f2f571`.

Gate 6A is deliberately **read-only**. It defines the deletion contract and can inventory/preview the impact for one user, but it does not delete provider data, unlink an OAuth account, mutate configuration, call Spotify, or change schema.

## Goal

Gate 5 stopped prohibited Spotify-derived analytics/profile/recommendation consumption. Gate 6 now needs a durable privacy lifecycle for the provider data that remains persisted.

The first requirement is to avoid treating these as the same operation:

1. disconnect Spotify from Sonoriza;
2. delete Spotify-derived/provider payload;
3. delete the Sonoriza user account.

A Spotify disconnect must not silently destroy first-party Sonoriza preferences or unrelated providers such as Google Calendar/Last.fm.

## Inventory findings

### Credentials

Auth.js stores linked OAuth providers in `Account`. Spotify rows contain provider identity plus access token, refresh token, expiry, scope and other grant fields. All Spotify API access funnels through `getSpotifyAccessToken(userId)`, which reads the Spotify `Account` row and can refresh/persist the grant.

**Gate 6 rule:** the Spotify OAuth `Account` row is deleted on disconnect. A deleted grant cannot be refreshed by Sonoriza.

### Provider-derived behavioral/personal state

Current provider-derived state includes:

- `TrackListeningState`;
- Spotify-origin `TrackListeningEvent`;
- Spotify Extended History import audit;
- `EpisodeListeningState`;
- `LikedTrackPreference`;
- `ArtistAffinityEvidence`;
- `ArtistAffinityState`;
- Spotify-rooted `ArtistSimilaritySeedState` / `ArtistSimilarityEdge`;
- `MusicPreferenceSignal` (`INFERRED_SKIP` currently originates from Spotify Recently Played);
- `AlbumRecommendationMemory`.

These datasets are classified for deletion on disconnect/provider-data deletion.

### Mixed listening lineage

HISTORY-02 can enrich an independently sourced Last.fm event with a `metadata.spotifyExtendedHistory` object and Spotify identity fields.

Deleting the whole row would destroy independent Last.fm evidence. Keeping it unchanged would retain Spotify data and allow lineage laundering.

**Gate 6 rule:** mixed rows use `SANITIZE_SPOTIFY_LINEAGE`. Gate 6B must remove the Spotify enrichment/provider identity introduced by that enrichment while preserving independently sourced evidence.

### Provider payload/cache vs first-party configuration

`SourcePlaylist` and `MusicIngestionRule` contain both first-party configuration and runtime/provider payload.

Gate 6 separates them:

- cached source candidates/snapshots: clear provider payload;
- ingestion runtime state/cursors/capability result: clear provider payload;
- source/target/rule bindings selected by the user: retain first-party configuration for a future reconnect.

### Generation audit

Generation runs/items/logs are first-party operational audit, but can contain Spotify URI/id/provider payload.

Gate 6 does **not** classify the entire audit as delete. The contract requires `REDACT_PROVIDER_FIELDS` so Gate 6B/C can preserve useful Sonoriza audit without indefinite provider-content retention.

### First-party Sonoriza state

The following survive Spotify disconnect:

- `User`;
- `FirstPartyPlaybackPreference`;
- `NativeSourcePreference`;
- source/target/ingestion configuration bindings;
- unrelated provider/account state.

Provider disconnection is not account deletion.

## Implemented files

- `src/services/data-policy/spotify-retention-contract.ts`
  - exhaustive dataset/action contract;
  - duplicate/missing-rule assertion;
  - explicit reasons for every disposition.
- `src/services/data-policy/spotify-disconnect-preview.ts`
  - pure non-mutating disconnect preview;
  - distinguishes DELETE / SANITIZE / REDACT / CLEAR / RETAIN totals;
  - reports mixed listening rows separately.
- `src/services/data-policy/spotify-disconnect-prisma-inventory.ts`
  - one read-only PostgreSQL inventory query for a user;
  - no provider calls or mutations;
  - counts mixed `spotifyExtendedHistory` enrichment independently.
- `src/services/data-policy/spotify-retention-contract.test.ts`
  - contract completeness;
  - credentials deleted;
  - provider-derived profile/history deleted;
  - mixed history sanitized;
  - first-party state retained;
  - cache/runtime payload cleared;
  - generation audit redacted;
  - preview accounting.

## Actions in the contract

### `DELETE`

The dataset is provider-derived and should not remain after disconnect/provider-data deletion.

### `CLEAR_PROVIDER_PAYLOAD`

The containing record is first-party configuration, but provider cache/runtime material is cleared.

### `SANITIZE_SPOTIFY_LINEAGE`

The row has independent non-Spotify value but contains Spotify enrichment. Remove only Spotify lineage/payload.

### `REDACT_PROVIDER_FIELDS`

Retain the Sonoriza operational audit row while clearing provider-specific content/identity fields that do not need indefinite retention.

### `RETAIN_FIRST_PARTY`

The data belongs to Sonoriza/user configuration and is not deleted merely because Spotify is disconnected.

## Explicit non-goals of Gate 6A

Gate 6A does not:

- execute a disconnect;
- delete any production row;
- revoke a token at Spotify;
- add a UI/API endpoint;
- change OAuth scopes;
- change Prisma schema;
- add a migration;
- merge or deploy.

## Gate 6B — next

Implement the transaction-safe disconnect executor with preview hash/expected counts and postcheck:

1. require an explicit destructive command, never infer it from GET/preview;
2. inventory immediately before mutation;
3. delete Spotify OAuth credentials;
4. clear provider caches/runtime state;
5. delete provider-derived behavioral/profile rows;
6. sanitize mixed Last.fm + Spotify history rows;
7. redact provider fields from retained operational audit;
8. preserve first-party preferences/configuration;
9. run a postcheck proving credentials/provider-derived rows are gone;
10. return an auditable result with counts.

No production disconnect should be executed as part of development/tests.

## Gate 6C — after executor

- authenticated user-facing disconnect/delete-data action;
- confirmation UX;
- scope minimization review;
- reconnect behavior;
- end-to-end postcheck and privacy documentation.
