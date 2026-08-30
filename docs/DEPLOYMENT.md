# Deployment (CloudPanel + PM2)

Sonoriza is a standard Next.js (App Router) app plus a PostgreSQL database. In
production it runs as a long-lived Node process managed by PM2, behind the
CloudPanel reverse proxy, and the daily generation is triggered by the server
cron.

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

Point the CloudPanel site's reverse proxy at `http://127.0.0.1:3000`.

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

`KEEP_FILLED` reads the current target under a stable Spotify snapshot, preserves
valid content, fills only the deficit and prefers append/remove mutations. It
falls back to a full replacement only when an incremental URI mutation would be
ambiguous. `REBUILD_DAILY` uses the normal generation pipeline and the same
current simulation/fingerprint/quality gate as a manual real run.

The direct `npm run generate:run` command remains a manual operator tool; it is
not a replacement for the SCHEDULE-01 dispatcher because it does not claim daily
per-target schedule slots.

## 5. Updating

```bash
git pull
npm ci
npm run db:deploy
npm run build
pm2 reload sonoriza
```


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
