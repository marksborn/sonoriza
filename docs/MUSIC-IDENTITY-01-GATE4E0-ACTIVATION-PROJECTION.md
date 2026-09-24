# MUSIC-IDENTITY-01 — Gate 4E0 activation projection

## Status

`PRE-ACTIVATION / PERSISTENCE ONLY / NO PLANNER INFLUENCE`

Gate 4E0 creates a durable handoff between the validated Gate 4D representative decision and a future controlled runtime activation. It does **not** activate canonical dedupe.

## Canary scope

Production Gate 4D showed the same canonical collision profile for Trabalho, Carro and Avulsa: 48 selectable collisions, 48 hypothetical drops, 0 abstentions, 27 source-order decisions, 21 cache-position decisions and 0 provider-id tie-breaks per target.

The first canary is **Avulsa** (`cmt4dny9q056xji7hg2a0cj4x`) for pilot user `cmshwqbpw0000jipbjo70j5nq` because it provides the smallest operationally isolated target among the non-zero candidates:

- fixed duration;
- zero target-calendar links;
- `SEQUENCE [MUSIC]`;
- no overlap with the already ACTIVE Playback Reserve rollout on Carro.

Trabalho remains a later target because its calendar-driven duration, ten calendar links and MUSIC/PODCAST sequence add unrelated variables to the first canonical-dedupe activation experiment.

## Why a durable projection exists

Gate 4D validates same-recording components using provider evidence and chooses a deterministic representative with `LEGACY_FIRST_OCCURRENCE_V1`. Those provider calls belong outside the generation hot path.

The planner currently deduplicates operationally by Spotify URI. Gate 4E therefore cannot simply call Gate 4D during every generation, and it cannot silently reassociate existing `TrackProviderRef` rows or merge persisted `RecordingIdentity` rows.

Gate 4E0 materializes only the validated activation facts needed by a future runtime.

## Persistence contract

A projection header stores:

- `userId`;
- `targetPlaylistId`;
- monotonic `version` per user/target/policy;
- `policy = LEGACY_FIRST_OCCURRENCE_V1`;
- `status = READY | STALE | REVOKED`;
- Gate 4C snapshot fingerprint;
- Gate 4D ordered-input fingerprint;
- effective source IDs + source-scope fingerprint;
- deterministic projection fingerprint;
- `validatedAt`.

Each component row stores:

- `componentId`;
- exact member provider-track IDs;
- Gate 4D representative provider-track ID;
- preference state;
- explicit `containsExcludedPreference=false` contract.

`READY` means only that the evidence is eligible for a future activation gate. It does **not** mean runtime activation is ON.

## Write semantics

Projection generation always runs the complete Gate 4D validation first. Persistence requires an explicit `--write`.

For the same fingerprint, persistence is idempotent and only revalidates the existing row. For a changed fingerprint, the previous READY projection is marked STALE and a new monotonic version is created. A matching REVOKED projection is never automatically reactivated.

Immediately before persistence, Gate 4E0 recomputes the current target source scope. If the effective source IDs no longer match the Gate 4D evidence, the write fails closed.

## CLI

Preview only:

```bash
npx tsx scripts/report-music-identity-dedupe-activation-projection.ts \
  --user=cmshwqbpw0000jipbjo70j5nq \
  --target=cmt4dny9q056xji7hg2a0cj4x \
  --json
```

Persist the validated projection:

```bash
npx tsx scripts/report-music-identity-dedupe-activation-projection.ts \
  --user=cmshwqbpw0000jipbjo70j5nq \
  --target=cmt4dny9q056xji7hg2a0cj4x \
  --write \
  --json
```

Both commands may perform Gate 4D Spotify read calls and existing credential/backoff operational writes. Neither command changes planner output, playlists, canonical identity rows, provider-ref associations, preferences or source caches.

## Fail-closed rules

Projection creation/persistence fails when:

- Gate 4D abstains;
- representative policy is not `LEGACY_FIRST_OCCURRENCE_V1`;
- Gate 4D authority indicates productive influence;
- target has zero collisions or any collision abstention;
- detailed selection cardinality does not match the Gate 4D target summary;
- component contains `EXCLUDED` preference;
- representative is not a member;
- dropped aliases do not equal all non-representative members;
- one provider track appears in more than one activation component;
- effective source scope changed before persistence;
- a matching projection was explicitly REVOKED.

## Explicit non-goals of Gate 4E0

- no planner/runtime integration;
- no feature flag activation;
- no allowlist evaluation in the planner;
- no canonical dedupe in generation;
- no Spotify playlist write;
- no `RecordingIdentity` merge;
- no `TrackProviderRef` reassociation;
- no SongIdentity expansion;
- no cooldown/exposure/TARGET-SCOPE sharing migration.

## Next checkpoint

Gate 4E1 may only be designed after:

1. schema/migration reviewed;
2. projection tests and migration CI green;
3. migration deployed separately;
4. Avulsa projection generated in production and inspected;
5. runtime flag remains OFF while projection evidence is validated.

Activation ON is a separate explicit checkpoint.
