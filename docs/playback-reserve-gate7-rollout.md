# PLAYBACK-RESERVE-01 — Gate 7 rollout

Runtime controls:

- `PLAYBACK_RESERVE_RUNTIME_MODE=OFF|SHADOW|ACTIVE`
- `PLAYBACK_RESERVE_ACTIVE_TARGET_IDS=<comma-separated target ids>`

Safety contract:

- missing/invalid mode resolves to `SHADOW`;
- `ACTIVE` requires exactly one scoped target;
- the target must be explicitly allowlisted;
- the target must use `REBUILD_DAILY`;
- a real ACTIVE run requires a previous successful ACTIVE simulation for the same effective playback-reserve policy;
- `KEEP_FILLED` remains out of scope until Gate 8;
- no additional provider reads are introduced;
- PRIMARY quality/shortfall remains authoritative;
- explicit RESERVE roles are persisted after generation and MUSIC-06/MUSIC-07 abstain from an ACTIVE run if role persistence cannot be proven.

Production activation remains a separate operational gate after merge/deploy/validation.
