# #512 — acceptance audit and historical status display

## Delivered protection

- ACTIVE factual Last.fm cannot authorize a real generation with unavailable,
  incomplete or unconfigured evidence. The generator rejects it before Spotify
  collection/write. The old ACTIVE-to-SHADOW fallback is not write authority.
- Retry of malformed JSON is bounded and limited to transient HTTP 5xx.
- KEEP_FILLED checks retained music against the same factual Last.fm rule.
  Missing identities are not preserved; quarantined Spotify history does not
  override ACTIVE Last.fm. Snapshot and Reserve guards remain mandatory.
- Prewrite refresh checks the selected plan, rejects missing textual identity
  and provider unavailability, and uses bounded replanning for new vetoes.
- Candidate exclusion counters survive prewrite refreshes.

These behaviors already exist in production. This patch does not reimplement
them, read providers, change the six-month policy or perform playlist actions.

## Display gap addressed by this patch

The target's authenticated operational history already loads historical summaries
within the existing user/target scope. It now renders the recorded factual status
separately from the run result. SUCCESS alone cannot produce a verified label.

Verified requires the known v1 Last.fm contract, configured/effective ACTIVE,
READY_ACTIVE, productive influence allowed, complete provider coverage,
prewrite revalidation, zero remaining prewrite vetoes and a successful/partial
real run. Missing, malformed or future contracts remain unknown. SHADOW and
simulations cannot claim real protection. Unavailable/incomplete evidence is
shown explicitly. Raw failures, URLs, account identifiers and provider payloads
are never rendered by this component. No extra DB/provider reads are added.

The text describes the existing artist/title comparison and its limitation for
differently named versions. This is historical evidence, not an assurance that
the current configuration is active or that every version has been reconciled.
Pure decision and server-rendering tests cover false positives, legacy data,
fail-open historical summaries and sanitization; existing factual, retry,
KEEP_FILLED and canonical shadow regressions run alongside them.

## Acceptance still open

The user explicitly required original/remaster aliases with proven recording
equivalence to share cooldown. The current productive consumer still compares
normalized artist/title keys. Canonical comparisons and MBID/ISRC analyses are
shadow/review tools under #374, not productive eligibility authority.

Remaining work must connect factual observations to strongly evidenced recording
identity without inferring a merge from text, ISRC alone or removed version
suffixes. Live/acoustic/demo/remix/re-recording/cover remain distinct or abstain.
Preparation, shadow parity, bounded reads, prewrite freshness, retained-item
parity, targeted canary and rollback need evidence before an independently
approved rollout. Existing shadow modules must be reused rather than replaced.

The historical display fix does not complete #512. Keep the issue open until
the identity requirement and operational acceptance are satisfied. This audit
contains no private account, playlist or generation data.
