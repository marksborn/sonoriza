-- Read-only: Spotify calls by operation for recent real runs of one target name
-- and the scheduler preflight of those runs.
-- Usage (site user): psql "$URL" -v target="'Carro'" -f scripts/report-spotify-usage-by-operation.sql
BEGIN READ ONLY;
WITH runs AS (
  SELECT r."id", r."startedAt", r."summary"
  FROM "GenerationRun" r
  WHERE r."simulation" = false
    AND r."trigger" = 'SCHEDULED'
    AND r."startedAt" >= now() - interval '10 days'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(r."summary"->'targets', '[]'::jsonb)) t
      WHERE t->>'name' = :target
    )
)
SELECT
  to_char("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando,
  COALESCE(("summary"->'spotifyApi'->>'totalCalls')::int, 0) AS total,
  COALESCE("summary"->'spotifyApi'->'callsByOperation', '{}'::jsonb) AS por_operacao,
  COALESCE(("summary"->'spotifyApi'->>'cacheHits')::int, 0) AS cache_hits,
  COALESCE(("summary"->'spotifyApi'->>'showCatalogCacheHits')::int, 0) AS show_cache_hits
FROM runs
ORDER BY "startedAt" DESC
LIMIT 8;

SELECT
  to_char(a."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando,
  a."details"->'spotifyPreflight' AS preflight
FROM "TargetScheduleAttempt" a
JOIN "TargetScheduleRun" s ON s."id" = a."targetScheduleRunId"
JOIN "TargetPlaylist" t ON t."id" = s."targetPlaylistId"
WHERE t."name" = :target
  AND a."startedAt" >= now() - interval '10 days'
ORDER BY a."startedAt" DESC
LIMIT 5;
COMMIT;
