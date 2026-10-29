# CALENDAR-04 (#532) — sequência por evento

## Product contract

For a target with `durationMode=CALENDAR` and `calendarDurationStrategy=PER_EVENT`,
the new policy `SEQUENCE_PER_EVENT` runs the target's own SEQUENCE pattern from
slot 0 at the start of **every** event, one attempt per slot, and then fills the
time left in that event with one of:

| Strategy | Remainder behavior |
|---|---|
| `MUSIC_ONLY` | only music |
| `PODCAST_ONLY` | whole episodes that fit |
| `MIX_RATIO` | duration target of `remainderPodcastPercent` podcast over the remainder only |
| `REPEAT_SEQUENCE` | restarts the pattern inside the same event until a slot cannot be filled |

`remainderFallback` decides what happens to time still empty: `FILL_WITH_MUSIC`
or `LEAVE_GAP` (reported as `EVENT_REMAINDER_GAP_LEFT`). An unfillable sequence
slot is skipped and reported (`EVENT_SEQUENCE_SLOT_UNFILLED_*`); it never moves to
the next event. No item crosses an event boundary and no podcast is cut.

There is no event cadence (`EVERY_N_EVENTS`, N, offset, "podcast só na ida"):
the new policy normalizes those fields to the canonical defaults. The legacy
`PODCAST_THEN_MUSIC` policy keeps working unchanged for targets that already use
it. Its controls appear only on targets that still use it, labeled as the old
configuration, until the user switches and saves.

## Implementation

- Persistence: same `CalendarEventCompositionPolicy` row; additive migration with
  `remainderFillStrategy`, `remainderPodcastPercent` (0..100 check) and
  `remainderFallback`. Saving a legacy policy leaves these columns untouched.
- Snapshot/fingerprint: `sequencePerEvent` is present only for
  `SEQUENCE_PER_EVENT`, so legacy snapshots and existing CONFIG-04 fingerprints
  are byte-identical.
- Planner: `projectCalendar04SequencePerEvent` (pure) only calls the canonical
  `planPlaylist` with `strictDurationBoundary`; podcast order, show caps,
  diversity and reservations are the existing ones. `planPlaylist` gained an
  optional `maxSequenceSlots` (undefined = unchanged behavior).
- Runtime: the CALENDAR-03 seam dispatches by policy. `CALENDAR_04_PLANNER_MODE`
  (default `SHADOW`) is an extra kill switch: CALENDAR-04 influences a plan only
  when CALENDAR-03 is `ACTIVE` for the user and target (allowlists) **and** this
  variable is `ACTIVE`. Manual, scheduled and onboarding simulation share it.
- UI: `Configuração → Destinos → Composição por evento` shows the new editor,
  the effective state per target (active / simulation-only / off) and the
  per-event preview (initial sequence, remainder, requested vs. obtained %,
  fallback, total and gap).

## Known limits of this gate

- With KEEP_FILLED preserved items, ACTIVE abstains (`ABSTAIN_PRESERVED_ITEMS`)
  and the legacy plan is used. SHADOW evidence projects from an empty playlist.
- Multi-target ACTIVE runs abstain like CALENDAR-03 does.
- MIX_RATIO is an approximation and is not a quality gate; the preview shows the
  deviation.

## Rollout

1. Deploy keeps `CALENDAR_04_PLANNER_MODE` unset (SHADOW). Nothing changes for
   any playlist, including targets that switch policy in the UI before activation.
   Note: a target switched from the old policy to `SEQUENCE_PER_EVENT` while
   CALENDAR-04 is SHADOW gets the **normal** composition in real runs.
2. Simulate the pilot target and review the per-event preview.
3. Set `CALENDAR_04_PLANNER_MODE=ACTIVE` only with operator approval; roll back by
   removing it.
