# #442 — bounded Gate 8 approval evidence

The Gate 8 approval reader previously materialized the complete JSON summaries
of the latest 30 successful/partial simulations in Node, even though approval
uses only a small part of each summary. Large catalog/diagnostic payloads are
irrelevant to this decision and add transfer and JSON materialization costs.

The reader now projects the existing eligibility and runtime fields in
PostgreSQL. It keeps the same user predicate, simulation flag, statuses,
descending start-time order and 30-run limit. The approval key and target are
still checked **after** that limit; moving them into the query could accidentally
admit an older simulation. The existing predicate and subsequent snapshot,
role-persistence, policy, consent and prewrite checks are unchanged.

All flags used to reject partial previews remain present, including podcast
and audiobook simulation-only markers. Source failure data and quality failures
remain available to the unchanged predicate. Missing/malformed evidence still
abstains. The query is parameterized; no schema/index change is introduced.

PostgreSQL regression tests compare projected versus legacy eligibility for
successful, partial, malformed and rejected summaries. They also verify user
isolation, status filtering, ordering, the historical boundary and a deliberately
hostile user-ID string. A synthetic oversized-summary fixture measures serialized
result bytes and requires at least a 95% reduction while retaining eligibility.
The existing Gate 8 tests still check snapshot-bound authorization.

The benchmark measures returned JSON size, not total generation RSS, database
CPU or end-to-end latency. It does not prove a memory leak or solve all of #442.
Unrelated payloads remain stored for diagnostics; only this reader stops loading
them. Existing summaries and catalog reads are not modified or reused as fresh
playback facts. Inline simulation remains mandatory under the existing rules.

Use the existing PLAYBACK-RESERVE-01 workflow with its disposable PostgreSQL
database and `PLAYBACK_RESERVE_DB_TEST=1`. No production account data or provider
traffic is a test fixture. After separate review and release, the issue still
requires RSS/heap before-and-after measurements, plan parity and seven natural
executions without memory-induced restart. No production memory limit or flag
is changed by this patch.
