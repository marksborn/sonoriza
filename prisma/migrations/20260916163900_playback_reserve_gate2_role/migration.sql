-- PLAYBACK-RESERVE-01 Gate 2 — explicit plan-role persistence only.
-- Planner/publication behavior is unchanged in this gate.

CREATE TABLE "GenerationPlanItemRole" (
  "runId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "role" "GenerationPlanRole" NOT NULL DEFAULT 'PRIMARY',
  "reservePolicy" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GenerationPlanItemRole_pkey"
    PRIMARY KEY ("runId", "targetPlaylistId", "position"),

  CONSTRAINT "GenerationPlanItemRole_position_check"
    CHECK ("position" >= 0),

  CONSTRAINT "GenerationPlanItemRole_shape_check" CHECK (
    (
      "role" = 'PRIMARY'
      AND "reservePolicy" IS NULL
    )
    OR
    (
      "role" = 'RESERVE'
      AND "reservePolicy" IS NOT NULL
      AND jsonb_typeof("reservePolicy") = 'object'
    )
  )
);

CREATE INDEX "GenerationPlanItemRole_runId_targetPlaylistId_role_idx"
  ON "GenerationPlanItemRole"("runId", "targetPlaylistId", "role");
