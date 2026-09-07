# #279 MUSIC-07 — Gate 3: eligibility anchor

## Goal

Integrate repeated first-party exposure into music cooldown eligibility without ever
claiming that exposure is playback.

## Canonical truth

Gate 3 deliberately does **not** add a second `TrackExposure` table. The canonical
exposure ledger remains:

```text
GenerationRun
+ GenerationItem
+ summary.targets[].applied
```

This already proves which music identity Sonoriza published, to which target, in
which run, at which position. Keeping this as the source of truth avoids a second
persisted history that could diverge.

## Eligibility anchor

When Gate 2 finds at least N=4 valid consecutive exposures for the same track and
target without factual consumption, Gate 3 can derive:

```text
eligibilityAnchorAt = last unconfirmed exposure
eligibilityAnchorSource = SONORIZA_EXPOSURE
cooldownUntil = eligibilityAnchorAt + configured MUSIC-01 window
```

This is an operational cooldown anchor only.

It never writes or fabricates:

```text
lastPlayedAt
INFERRED_SKIP
INFERRED_IGNORED
negative preference
```

## Consumption reconciliation

Last.fm is the factual consumption source used by MUSIC-07. A matching scrobble
resets the consecutive unconfirmed exposure streak, including a later scrobble
that appears after the original per-publication observation window.

Incomplete Last.fm coverage is fail-closed for negative inference: Gate 3 abstains
instead of treating absence as evidence.

## Runtime modes

Gate 3 introduces three modes:

```text
OFF     -> no MUSIC-07 database/provider preparation; no planner influence
SHADOW  -> compute anchors and diagnostics; no candidate removal
ACTIVE  -> candidate removal allowed only when all rollout guards pass
```

`ACTIVE` additionally requires:

- user in `MUSIC_07_ELIGIBILITY_EMAIL_ALLOWLIST`;
- an explicit scoped generation (`targetPlaylistIds` must be present);
- every scoped target in `MUSIC_07_ELIGIBILITY_TARGET_IDS`.

Therefore an unscoped/manual all-target run cannot accidentally activate the Gate
4 pilot.

Default is `OFF`.

## Planner integration

The existing MUSIC-01 Spotify Recently Played path remains quarantined by its
central capability decision. MUSIC-07 is independent first-party state.

The candidate flow becomes conceptually:

```text
Spotify source candidates (operational catalog)
        ↓
legacy Spotify Recently Played filter only if compliance ALLOW
        ↓
MUSIC-07 SONORIZA_EXPOSURE eligibility filter when controlled ACTIVE
        ↓
explicit first-party preferences
        ↓
planner
```

Explicit `EXCLUDED` preferences continue to prevail; MUSIC-07 never converts an
exposure into a taste profile signal.

## No persistence migration in Gate 3

No Prisma migration is required. The eligibility projection is derived from the
existing Sonoriza-owned generation ledger plus independent Last.fm evidence. This
keeps the minimum number of truth stores while preserving auditability.

## Gate 3 validation

Required checks:

1. N-1 valid exposures do not create an anchor.
2. N=4 creates `SONORIZA_EXPOSURE` anchor, not `lastPlayedAt`.
3. Later Last.fm consumption resets the streak.
4. Incomplete Last.fm coverage abstains.
5. Expired cooldown stops blocking.
6. OFF and SHADOW modes never remove candidates.
7. ACTIVE can remove only the exact blocked track IDs.
8. Typecheck passes.
9. Production validation uses an isolated worktree and read-only report; no deploy.

## Gate 4 boundary

Gate 3 ships the authority model and guarded integration path. It does not activate
production eligibility.

Gate 4 is responsible for choosing one pilot target, enabling the scoped allowlist,
performing simulation/postcheck, and defining rollback before any productive
candidate removal.
