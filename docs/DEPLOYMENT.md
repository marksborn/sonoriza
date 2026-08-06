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
# Every day at 04:30 — regenerate all users' playlists
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
