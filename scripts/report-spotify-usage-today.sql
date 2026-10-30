-- Read-only: Spotify calls per generation run since midnight (America/Sao_Paulo).
-- Usage (site user): psql "$URL" -f scripts/report-spotify-usage-today.sql
BEGIN READ ONLY;
SELECT
  to_char("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS hora,
  CASE WHEN "simulation" THEN 'SIM' ELSE 'REAL' END AS tipo,
  "trigger",
  "status",
  COALESCE(("summary"->'spotifyApi'->>'totalCalls')::int, 0) AS chamadas,
  COALESCE(("summary"->'podcastCompletionReplan'->'spotifyApi'->>'totalCalls')::int, 0) AS releituras_podcast,
  COALESCE(("summary"->'spotifyApi'->>'rateLimitedCount')::int, 0) AS limitadas,
  COALESCE(("summary"->'spotifyApi'->>'quotaExceededCount')::int, 0) AS cota
FROM "GenerationRun"
WHERE "startedAt" >= ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC')
ORDER BY "startedAt";

SELECT
  CASE WHEN "simulation" THEN 'SIM' ELSE 'REAL' END AS tipo,
  count(*) AS execucoes,
  sum(COALESCE(("summary"->'spotifyApi'->>'totalCalls')::int, 0)) AS chamadas
FROM "GenerationRun"
WHERE "startedAt" >= ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC')
GROUP BY 1;
COMMIT;
