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

The daily run is an authenticated HTTP call. Add a crontab entry (adjust the
time to your timezone):

```cron
# Every day at 04:30 — regenerate all allowed users' playlists
30 4 * * * curl -fsS -X POST https://<host>/api/cron/generate \
  -H "Authorization: Bearer <CRON_SECRET>" >> /home/<user>/logs/sonoriza-cron.log 2>&1
```

`<CRON_SECRET>` must match the value in `.env`. Alternatively, run the engine
directly as a Node process:

```cron
30 4 * * * cd /path/to/sonoriza && npm run generate:run -- --user <userId> >> ... 2>&1
```

## 5. Updating

```bash
git pull
npm ci
npm run db:deploy
npm run build
pm2 reload sonoriza
```
