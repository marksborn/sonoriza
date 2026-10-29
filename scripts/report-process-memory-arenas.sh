#!/usr/bin/env bash
# Sonoriza #442 — relatório somente leitura da memória nativa do processo PM2.
# Como root ou itsoft-sonoriza: bash scripts/report-process-memory-arenas.sh [pid]
# Não lê .env, não reinicia nada, não chama banco nem providers.
set -Eeuo pipefail

SITE_HOME="/home/itsoft-sonoriza"
NODE_BIN="$SITE_HOME/.nvm/versions/node/v24.19.0/bin"

pid="${1:-}"
if [[ -z "$pid" ]]; then
  pid="$(runuser -u itsoft-sonoriza -- env HOME="$SITE_HOME" PM2_HOME="$SITE_HOME/.pm2" \
    PATH="$NODE_BIN:/usr/bin:/bin" pm2 pid sonoriza 2>/dev/null || true)"
fi
[[ -n "$pid" && -r "/proc/$pid/smaps" ]] || {
  printf >&2 'PID do sonoriza não encontrado ou ilegível.\n'
  exit 1
}

printf 'pid=%s threads=%s\n' "$pid" "$(ls "/proc/$pid/task" | wc -l)"
if tr '\0' '\n' < "/proc/$pid/environ" | grep -q '^MALLOC_ARENA_MAX='; then
  tr '\0' '\n' < "/proc/$pid/environ" | grep '^MALLOC_ARENA_MAX='
else
  printf 'MALLOC_ARENA_MAX=<ausente>\n'
fi
grep -E '^(Rss|Pss_Anon|Pss_File):' "/proc/$pid/smaps_rollup"

# glibc mapeia cada arena secundária em blocos de 64 MiB alinhados; o RSS dessas
# regiões é memória nativa (Prisma engine, libuv) fora do heap V8.
awk '
  /^[0-9a-f]+-[0-9a-f]+ / {
    split($1, a, "-"); s = strtonum("0x" a[1]); perm = $2; name = $6
  }
  /^Rss:/ {
    if (name == "" && perm == "rw-p" && s % 67108864 == 0) { n++; t += $2 }
  }
  END { printf "arenas_64mib=%d arena_rss_mib=%.1f\n", n, t / 1024 }
' "/proc/$pid/smaps"
