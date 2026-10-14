# Deployment (CloudPanel + PM2)

Sonoriza is a standard Next.js (App Router) app plus a PostgreSQL database. In
production it runs as a long-lived Node process managed by PM2, behind the
CloudPanel reverse proxy, and the daily generation is triggered by the server
cron.

## 0. PROCEDIMENTO OFICIAL — PRODUÇÃO EXISTENTE (srv914260)

**Fonte única para qualquer nova sessão/assistente/Codex:** este documento,
[`scripts/deploy-cloudpanel.sh`](../scripts/deploy-cloudpanel.sh) e
[`AGENTS.md`](../AGENTS.md). Não improvisar novos comandos de Node/PM2 a cada
sessão. **Validado operacionalmente no ambiente Sonoriza; registro do caminho
comprovado em 11/10/2026.**

| Configuração | Valor em produção |
| --- | --- |
| Host/gerenciador | `srv914260`, CloudPanel |
| Usuário do site (Git/npm/Prisma/PM2) | `itsoft-sonoriza` |
| Diretório de projeto | `/home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br` |
| Binários Node 24/npm/PM2 | `/home/itsoft-sonoriza/.nvm/versions/node/v24.19.0/bin` |
| Ambiente PM2 | `PM2_HOME=/home/itsoft-sonoriza/.pm2` |
| Processo PM2 | `sonoriza` |
| Serviço systemd (reiniciar como root) | `pm2-itsoft-sonoriza.service` |
| Porta interna Next.js | `3005` |
| Branch de deploy | `main` |

### Deploy em uma linha (a partir da SEGUNDA implantação do runbook)

No terminal **root** do CloudPanel:

```bash
bash /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br/scripts/deploy-cloudpanel.sh
```

Opcional: passe como argumento um **commit obrigatório que a main precisa
conter**; o script impede que uma branch errada seja implantada:

```bash
bash /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br/scripts/deploy-cloudpanel.sh 019c942a4115f2746936625245ffaae4fb99f734
```

O script executa **automaticamente**: valida Node do site, valida alterações
Git rastreadas, `git fetch` + `git merge --ff-only origin/main`, `npm ci`,
`npm run db:deploy`, `npm run typecheck`, `npm run build`, reinicia
`pm2-itsoft-sonoriza.service`, verifica PM2 e HTTP em `127.0.0.1:3005`.
É propositalmente conservador: sem `git reset --hard`, sem `stash` automático,
sem alteração de `.env`, sem trocar flags, sem limpeza de backups.

### Bootstrap UMA ÚNICA VEZ (servidor ainda não possui o script)

Executar como **root**. É necessário apenas para baixar a primeira versão deste
runbook. Depois, usar a linha acima. O `git fetch`/merge roda como o usuário
**itsoft-sonoriza**, nunca como root:

```bash
APP=/home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br
SITE_HOME=/home/itsoft-sonoriza
NODE_BIN="$SITE_HOME/.nvm/versions/node/v24.19.0/bin"
run_site() {
  runuser -u itsoft-sonoriza -- env -u NVM_DIR -u XDG_CONFIG_HOME -u XDG_CACHE_HOME \
    HOME="$SITE_HOME" PM2_HOME="$SITE_HOME/.pm2" \
    PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" "$@"
}

test -x "$NODE_BIN/node" || { echo "Node 24 do site ausente"; exit 1; }
run_site git -C "$APP" diff --quiet || { echo "Git com alterações rastreadas"; exit 1; }
run_site git -C "$APP" diff --cached --quiet || { echo "Git com staged"; exit 1; }
run_site git -C "$APP" fetch --no-tags origin main
run_site git -C "$APP" merge --ff-only origin/main
bash "$APP/scripts/deploy-cloudpanel.sh" 019c942a4115f2746936625245ffaae4fb99f734
```

O argumento `019c942a...` é o merge de #477; substituí-lo pelo SHA de
referência de uma release posterior (ou omiti-lo). **Não é obrigatório que esse
SHA seja exatamente o HEAD**: releases de documentação posteriores podem estar
à frente dele.

### Falhas já diagnosticadas — NÃO REPETIR

- **`nvm use 24.19.0` relata N/A / `mkdir: /root: Permission denied`**:
  o shell herda variáveis do root. O Node está no caminho absoluto **do site**.
  Não usar `runuser ... bash -lc`, nem `source "$HOME/.nvm/nvm.sh"`, nem
  `nvm ls` sob `set -u` em uma sessão com ambiente herdado.
- **`node -v` mostra `v18.19.1`**: é o Node *system*, não o Node de produção.
  Executar com `PATH="$NODE_BIN:..."` e `HOME="$SITE_HOME"` explícitos.
- **`pm2` não está no PATH**: usar o PM2 em `$NODE_BIN/pm2` com
  `PM2_HOME=/home/itsoft-sonoriza/.pm2`. Reinício documentado:
  `systemctl restart pm2-itsoft-sonoriza.service` como root.
- **`git status --porcelain` mostra `.env.backup-*`**: estes arquivos são
  *untracked* e podem permanecer. Não os excluir ou mover. Somente alterações
  em arquivos Git **rastreados** (`git diff --quiet` e
  `git diff --cached --quiet`) devem bloquear um fast-forward.
- **Permissões em `node_modules` / `.next`**: não executar npm/Next.js como
  root; não usar `chown -R` sem diagnóstico.
- **Deploy versus publicação de playlist**: `npm run build` + reinício de
  PM2 apenas publica código. Nenhuma feature flag/opt-in da Reserva da
  Academia deve ser ligada por implicação de deploy.

### Verificação objetiva de resultado

O script imprime `DEPLOY OK — <SHA>` somente quando a `main` correta,
o PM2 e o HTTP local estiverem confirmados. Para verificar manualmente, no
terminal root:

```bash
systemctl is-active pm2-itsoft-sonoriza.service
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3005/
runuser -u itsoft-sonoriza -- env HOME=/home/itsoft-sonoriza \
  PM2_HOME=/home/itsoft-sonoriza/.pm2 \
  PATH=/home/itsoft-sonoriza/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin \
  /home/itsoft-sonoriza/.nvm/versions/node/v24.19.0/bin/pm2 status sonoriza
```

## 1. Database

Create a PostgreSQL database and user in CloudPanel, then set `DATABASE_URL` in
`.env`. Apply the schema:

```bash
npm ci
npm run db:deploy   # prisma migrate deploy
```

## 2. OAuth apps

- **Spotify** — create an app at https://developer.spotify.com/dashboard and add
  the redirect URI `https://<host>/api/auth/callback/spotify`.
- **Google** — create OAuth credentials at
  https://console.cloud.google.com/apis/credentials, enable the *Google Calendar
  API*, and add the redirect URI `https://<host>/api/auth/callback/google`.

Fill the corresponding values in `.env` (see `.env.example`).

### Restricted beta access (AUTH-01)

Production must define `SONORIZA_ALLOWED_EMAILS` **before starting/restarting
with AUTH-01 code**. The value accepts comma and/or line separated emails and is
normalized with `trim + lowercase`.

```env
SONORIZA_ALLOWED_EMAILS="owner@example.com,tester@example.com"
```

Production is fail-closed: an absent or empty allowlist authorizes nobody. The
gate applies to Google/Spotify sign-in and linking, existing product sessions,
protected application APIs, and scheduled jobs that would otherwise consume
Google/Spotify resources.

Safe rollout order:

1. confirm the canonical email of the current owner account;
2. add that email to `SONORIZA_ALLOWED_EMAILS` in production `.env`;
3. deploy/build/restart the AUTH-01 code;
4. prove the owner can sign in and open protected pages;
5. prove a non-listed email receives `AccessDenied`;
6. add/remove a tester only by changing `.env` and restarting the app — no code
   change or migration is required.

Never deploy AUTH-01 code first and plan to configure the allowlist later: the
intended production behavior in that state is to deny all user access and skip
all per-user scheduled provider work.

## 3. Build & start with PM2

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

On this production server, CloudPanel proxies to **`http://127.0.0.1:3005`**. Other installations may use a different port.

## 4. Scheduled generation (server cron)

SCHEDULE-01 turns the server cron into a **dispatcher**, not the authority for a
single global generation time. Each target owns its policy (`MANUAL`,
`KEEP_FILLED` or `REBUILD_DAILY`), daily local time and IANA timezone. Run the
dispatcher frequently enough to pick up due slots:

```cron
# Every 5 minutes — dispatch only due automatic targets
*/5 * * * * curl -fsS -X POST https://<host>/api/cron/generate \
  -H "Authorization: Bearer <CRON_SECRET>" >> /home/<user>/logs/sonoriza-cron.log 2>&1
```

`<CRON_SECRET>` must match the value in `.env`. A unique target/local-date audit
slot makes successful/no-op maintenance idempotent: repeated dispatcher calls do
not run the same daily slot twice. A missed exact minute remains due later on the
same local day. `MANUAL` targets are ignored by this endpoint.

Retries (#435): each slot gets at most three attempts. A provider read that
exceeds its deadline (`SPOTIFY_READ_TIMEOUT_MS` / `GOOGLE_CALENDAR_READ_TIMEOUT_MS`,
default 10 s) before any Spotify write ends the attempt as `FAILED`, and the slot
is retried after `SCHEDULE_FAILED_RETRY_AFTER_MS` (default 5 min, i.e. the next
dispatcher tick). Other generation failures end as `BLOCKED` and are not retried
the same day. Spotify playlist writes have their own deadline
(`SPOTIFY_WRITE_TIMEOUT_MS`, default 30 s); a write that times out has an
unknown outcome, is never retried in-process, and leaves the slot `FAILED` so
the next attempt (after the same retry delay) re-reads the live playlist before
planning. An attempt still `RUNNING` is only taken over after 30 minutes. After a PM2 restart (for
example `max_memory_restart`), the next dispatcher tick takes over immediately
when the dead run's persisted checkpoints show it never reached
`PROVIDER_WRITE_START`; otherwise the 30 minute window still applies. Each
checkpoint also records process memory (`rssMb`, `heapUsedMb`, ...) to locate
the stage that pushes the run past the PM2 memory limit (#442).

`KEEP_FILLED` reads the current target under a stable Spotify snapshot, preserves
valid content, fills only the deficit and prefers append/remove mutations. It
falls back to a full replacement only when an incremental URI mutation would be
ambiguous. `REBUILD_DAILY` uses the normal generation pipeline and the same
current simulation/fingerprint/quality gate as a manual real run.

The direct `npm run generate:run` command remains a manual operator tool; it is
not a replacement for the SCHEDULE-01 dispatcher because it does not claim daily
per-target schedule slots.

## 5. Updating

**Use the [production runbook in section 0](#0-procedimento-oficial--produção-existente-srv914260) instead of copying generic `git pull`/`pm2 reload` commands.**

```bash
bash /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br/scripts/deploy-cloudpanel.sh
```

Do not run deployment with root-owned Git/npm or switch to system Node 18.


## 6. Read-only production SQL diagnostics

For production diagnostics that must return rows, use the PostgreSQL `psql`
client. Do not use `prisma db execute` for `SELECT` diagnostics: it executes
the statement but only reports `Script executed successfully`, without printing
the result set.

Prefer a temporary SQL file over nested shell heredocs. This avoids broken quotes
and truncated SQL when commands are pasted from a mobile terminal.

```bash
cat > /tmp/sonoriza-diagnostic.sql <<'SQL'
\\pset pager off
\\x on

SELECT now() AS database_time;
SQL

chmod 644 /tmp/sonoriza-diagnostic.sql

sudo -u itsoft-sonoriza -H bash -lc '
set -Eeuo pipefail
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br
set -a
source .env
set +a
DB_URL="${DATABASE_URL%%\\?*}"
psql "$DB_URL" -f /tmp/sonoriza-diagnostic.sql
'
```

Operational rules:

- run the command as the CloudPanel site user, not as `root`;
- never print `DATABASE_URL` or embed credentials in the SQL file;
- remove the Prisma-only `?schema=...` query string before passing the URL to
  `psql`;
- use `\\pset pager off` so unattended output does not stop in a pager;
- use `\\x on` for readable wide diagnostic records;
- keep diagnostic SQL read-only unless a separately reviewed operation explicitly
  requires a write;
- use a task-specific filename under `/tmp`, then replace or remove it after the
  investigation when appropriate.

If `psql` is unavailable, install/use the matching PostgreSQL client through the
server's normal administration process. Do not fall back to exposing database
credentials on the command line or in shell history.
