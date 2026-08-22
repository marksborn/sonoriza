# DISCOVERY-01 — Gate 5H productive rollout

Gate 5H is the first production integration of DESCOBERTA into the normal generator.

## Rollout

It is fail-closed behind both the existing DISCOVERY runtime and a dedicated rollout:

- `DISCOVERY_RUNTIME_ENABLED=true`
- user present in `DISCOVERY_RUNTIME_USER_EMAILS`
- `DISCOVERY_GATE5H_ENABLED=true`
- user present in `DISCOVERY_GATE5H_USER_EMAILS`

Without all four conditions, generation behavior is unchanged.

## Production contract

1. The existing planner builds the authoritative baseline.
2. ORDER-01 applies the configured final music ordering.
3. Gate 5H acquires external candidates through the same Gate 5C/5D/5E semantics already validated in read-only production.
4. Gate 5G surgical replacement is applied to the final ordered baseline.
5. KEEP_FILLED targets abstain in v1 so preserved remote prefixes never churn because of discovery.
6. Provider/acquisition failure abstains DESCOBERTA and keeps the valid baseline.
7. Surgical invariant failure also abstains and keeps the valid baseline.
8. ORDER-01 hash is recomputed after discovery, so a real publish still has to match its approved simulation.
9. MUSIC-01 is revalidated after external acquisition and once more immediately before any Spotify write when Gate 5H was attempted.
10. Existing sequence, podcast authority, podcast duration, diversity, snapshot and podcast pre-write barriers validate the final plan.

## Surgical invariants

- baseline remains authoritative;
- MUSIC replaces MUSIC one-for-one;
- podcast identities/order/count are unchanged;
- final discovery share ceiling is 20% of MUSIC;
- eligible discovery slots are every fifth MUSIC position;
- per replacement, target and calendar block duration delta stays within ±30 seconds;
- MUSIC-05 and diversity limits are preserved;
- composition quality cannot regress;
- no force fill.

## Market / Spotify identity

Spotify catalog resolution uses the user's token-scoped playable catalog. Market determines which Spotify variant is playable; recording identity/history remain cross-release and use the conservative recording equivalence already corrected after the `Clouds Over California` regression.

## Writes

Gate 5H itself adds no new persistence model or migration. It does not write MUSIC-03, history, preference or discovery scores. When enabled and safe, the existing playlist writer persists the final plan exactly as it already does for normal generation.
