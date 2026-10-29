# #442 — glibc malloc arenas and PM2 limit alignment

## Measured signal (2026-10-29, read-only)

- PM2 restarted `sonoriza` at 07:11 BRT for exceeding `max_memory_restart`
  (837 MiB > 768 MiB). It was the first memory restart since 08/10.
- At 07:32 the operator raised the live limit to 1 GiB and ran `pm2 save`;
  the repository still declared 768M.
- In the generation logs, `[DISCOVERY-01][memory]` shows RSS 600–675 MiB while
  `heapTotal` stays 225–340 MiB, so roughly 300 MiB lives outside the V8 heap.
- The idle process at 8 h uptime had RSS 388 MiB. `/proc/<pid>/smaps` showed
  20 anonymous `rw-p` mappings aligned to 64 MiB (glibc secondary arenas)
  holding **181.6 MiB** RSS. `MALLOC_ARENA_MAX` was not set; on 4 CPUs glibc
  allows up to 32 arenas. Native threads (Prisma library engine, libuv pool)
  allocate in different arenas and memory freed there is rarely returned.

This is evidence of native fragmentation, not proof that it causes the whole
generation peak. It doesn't measure the instantaneous 837 MiB peak.

## Change

- `ecosystem.config.cjs` sets `MALLOC_ARENA_MAX=2` (overridable from the
  shell) and declares `max_memory_restart: "1G"`, the value already live.
- `scripts/report-process-memory-arenas.sh [pid]` prints thread count, whether
  the variable reached the process, RSS and arena RSS. It is read-only: no
  `.env`, database, provider or PM2 mutation.

No planner, query or selection code changes, so plan parity is unaffected.

## Applying it in production

The official deploy (`deploy-cloudpanel.sh`) restarts through
`systemctl restart pm2-itsoft-sonoriza.service`, which runs `pm2 resurrect`
from `dump.pm2`. **Changes in `ecosystem.config.cjs` don't take effect through
the deploy alone.** After the deploy reports `DEPLOY OK`, the operator applies
the ecosystem once, as the site user:

```bash
pm2 env 0 | grep -E '^(ALBUM_OPPORTUNITY_SPOTIFY_REQUEST_BUDGET|NODE_ENV|PORT)'
```

`--update-env` rebuilds the environment from the current shell plus the
ecosystem `env`. Export every variable shown above that isn't in the ecosystem
(today: `ALBUM_OPPORTUNITY_SPOTIFY_REQUEST_BUDGET`) with its current value
before running:

```bash
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br && pm2 restart ecosystem.config.cjs --update-env && pm2 save
```

Then confirm with `bash scripts/report-process-memory-arenas.sh`:
`MALLOC_ARENA_MAX=2` and a small `arenas_64mib` count. Avoid restarting during
a scheduled slot.

## Acceptance still pending

- Record before/after peak RSS from `GenerationLog` `data.memory` checkpoints
  and `[DISCOVERY-01][memory]` for the Carro runs.
- Seven consecutive natural runs with no `max_memory_restart` event in
  `~/.pm2/pm2.log`.
- If the arena cap does not lower peaks, the next suspect is Prisma native
  result buffering on large reads; measure before changing queries.
