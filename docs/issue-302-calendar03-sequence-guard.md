# #302 CALENDAR-03 pre-write sequence guard

This note captures the regression contract for the narrow integration fix related to #276.

- Legacy `SEQUENCE` divergence remains blocked.
- CALENDAR-03 `SHADOW` remains subject to the legacy sequence guard.
- `ACTIVE` without actual planner influence remains subject to the legacy guard.
- Only `ACTIVE` evidence for the exact allowlisted target with `READY_SHADOW` and `plannerInfluence=true` transfers composition ownership to CALENDAR-03.
- All later pre-write guards remain unchanged.

Productive evidence that motivated the fix: run `cmtu4duh80001jicvazd3jthw` was blocked before Spotify write because the valid CALENDAR-03 plan diverged from the persisted legacy sequence pattern.
