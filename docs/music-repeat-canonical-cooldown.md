# #512 — canonical factual cooldown integration

This slice adds an opt-in consumer of existing recording associations to the
Last.fm factual cooldown. It does not resolve, create or merge identities.
The configured factual window (including six calendar months) is unchanged.

## Evidence required

- A local, in-window `LASTFM_SCROBBLE` explicitly contains a Spotify track ID.
- That ID and each blocked alias belong to the same user's persisted recording
  and the global Spotify namespace. Both require confidence 9000–10000,
  `EXACT_PROVIDER_ALIAS` or `SAME_RECORDING_HIGH_CONFIDENCE`, known provenance,
  and a valid ISRC or recording MBID. Conflicting identifiers abstain.
- Parent recording and observed metadata must describe the same artist and
  base title, with a STANDARD/REMASTER classification. Live, acoustic, demo,
  remix, re-recording and conflicting metadata abstain.
- A shared ISRC/MBID alone, singleton bootstrap, textual alias or missing link
  does not authorize a new association. Dragon Fly/Dragonfly REVIEW decisions
  and Flyleaf's divergent/missing Last.fm MBID retain their existing behavior.
- Spotify Recently Played and Extended History remain quarantined as factual
  sources. Unknown/imported or mixed factual provenance cannot bridge IDs.

## Three consumers and failure handling

The candidate filter, KEEP_FILLED preservation and final pre-write veto consume
the same evidence. Preparation uses a read-only, repeatable-read transaction,
selects only relevant fields, and caps linked facts at 20,000 and provider refs
at 10,000. Overflow, missing target, policy denial or query failure blocks ACTIVE
real runs; it never becomes a successful empty snapshot. OFF does no canonical
queries. SHADOW measures matches without removing candidates or preserved items.

The fingerprint covers the relevant graph and linked factual events. A changed
association, provenance, event or rollout invalidates a pending real write.
KEEP_FILLED carries its fingerprint into generation, covering the gap between
preservation and planning. The final refresh repeats this check; ordinary legacy
Last.fm vetoes retain their bounded replan behavior.

## Separate activation checkpoint

Defaults are `MUSIC_REPEAT_CANONICAL_MODE=OFF`, empty allowlist and empty approval.
The allowlist contains exact `user-id:target-id` pairs. An opted-in ACTIVE target
cannot bypass its evidence guard through an unscoped/multiple-target run.
ACTIVE also requires the existing factual Last.fm rule to be ACTIVE/complete
and `MUSIC_REPEAT_CANONICAL_APPROVED_USE=PERSONAL_FACTUAL_RECORDING_COOLDOWN_V1`.
This narrow deployment setting records a separate reviewed personal factual use;
it does not approve new global data-policy uses or authorize AI/training uses.
Do not set it without that review. SHADOW requires no productive approval token.

Deploying this code alone does not activate it. Before activation, demonstrate
eligible local facts and strong associations, inspect SHADOW results for one
target, approve the scoped use, and validate original/remaster exclusion plus
unrelated-song preservation in a controlled run. Rollback sets mode OFF and
clears the pair/approval, then starts a fresh run. In-flight ACTIVE runs whose
rollout changes abort.

## Validation and remaining limits

Pure regressions cover scope, evidence conflicts, version/artist guards,
quarantined origins, OFF/SHADOW parity and stale preservation evidence. The
PostgreSQL integration suite uses disposable synthetic data and intercepts all
HTTP: original/remaster filtering, actual pre-write refresh, association/rollout
revocation, KEEP_FILLED preservation and bounded evidence are exercised without
provider queries or HTTP mutations. The dedicated CI provisions PostgreSQL 16
and applies only existing migrations to that disposable test database.

This slice adds no schema migration, production flag, provider lookup, playlist
mutation or canonical backfill. Missing strong associations or missing factual
Spotify IDs remain an evidence gap; deployment cannot repair them. A fresh
pre-write snapshot narrows the race window but cannot make a subsequent remote
Spotify write atomic with a local graph update. Issue #512 remains open until
the scoped productive acceptance and evidence-coverage gaps are addressed.
