-- ProviderBackoff timestamps are absolute provider-control instants.
--
-- The original table used TIMESTAMP WITHOUT TIME ZONE while production runs
-- PostgreSQL in America/Sao_Paulo. Existing rows therefore contain Sao Paulo
-- wall-clock values. Prisma maps those columns to JavaScript Date values as if
-- they were UTC, which can make a Retry-After window expire three hours early.
--
-- Interpret the existing wall-clock values explicitly as America/Sao_Paulo
-- while converting them to timestamptz. Future Date writes then round-trip as
-- absolute instants independently of the database/session timezone.
ALTER TABLE "ProviderBackoff"
    ALTER COLUMN "blockedUntil" TYPE TIMESTAMPTZ(3)
        USING "blockedUntil" AT TIME ZONE 'America/Sao_Paulo',
    ALTER COLUMN "observedAt" TYPE TIMESTAMPTZ(3)
        USING "observedAt" AT TIME ZONE 'America/Sao_Paulo',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3)
        USING "updatedAt" AT TIME ZONE 'America/Sao_Paulo';
