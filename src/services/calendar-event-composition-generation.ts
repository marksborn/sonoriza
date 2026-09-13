import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import type {
  CalendarEventCompositionPolicySnapshot,
} from "@/services/calendar-event-composition-policy";
import {
  defaultCalendarEventCompositionPolicy,
  normalizeCalendarEventCompositionPolicy,
} from "@/services/calendar-event-composition-policy";
import type {
  ConfigurationAssessment,
  ConfigurationIssue,
} from "@/services/configuration-readiness";
import { assessPodcast07GenerationConfiguration } from "@/services/spotify/podcast-07-generation-configuration";

export type Calendar03GenerationConfiguration = Readonly<{
  assessment: ConfigurationAssessment;
  policies: ReadonlyMap<string, CalendarEventCompositionPolicySnapshot>;
  fingerprintPolicies: CalendarEventCompositionPolicySnapshot[];
}>;

/**
 * Gate 3: decorates the existing CONFIG-04 assessment with the effective
 * CALENDAR-03 policy of every enabled target. Missing rows are represented by
 * the backward-compatible defaults, so merely inserting an equivalent default
 * row does not churn the fingerprint.
 *
 * PODCAST-07 Gate 6 is composed before CALENDAR-03 so every existing caller of
 * this canonical generation assessment automatically gets the podcast policy
 * fingerprint without creating a second manual/scheduler path.
 */
export async function assessCalendar03GenerationConfiguration(
  userId: string,
  baseAssessment: ConfigurationAssessment,
): Promise<Calendar03GenerationConfiguration> {
  const podcast07Configuration = await assessPodcast07GenerationConfiguration(
    userId,
    baseAssessment,
  );
  const effectiveBaseAssessment = podcast07Configuration.assessment;
  const targetIds = effectiveBaseAssessment.targets.map((target) => target.id);
  const rows = targetIds.length === 0
    ? []
    : await prisma.calendarEventCompositionPolicy.findMany({
        where: {
          userId,
          targetPlaylistId: { in: targetIds },
        },
        orderBy: { targetPlaylistId: "asc" },
      });

  const rowByTargetId = new Map(
    rows.map((row) => [row.targetPlaylistId, row] as const),
  );
  const policies = new Map<string, CalendarEventCompositionPolicySnapshot>();
  const issues = [...effectiveBaseAssessment.issues];
  const hasMusicSource = effectiveBaseAssessment.sources.some(
    (source) => source.kind === "MUSIC",
  );
  const hasPodcastSource = effectiveBaseAssessment.sources.some(
    (source) => source.kind === "PODCAST",
  );

  for (const target of effectiveBaseAssessment.targets) {
    const row = rowByTargetId.get(target.id);
    const policy = row
      ? normalizeCalendarEventCompositionPolicy(target.id, {
          eventCompositionPolicy: row.eventCompositionPolicy,
          maxPodcastsPerEvent: row.maxPodcastsPerEvent,
          podcastEventSafetyMarginSeconds:
            row.podcastEventSafetyMarginSeconds,
          podcastEventDistribution: row.podcastEventDistribution,
          podcastEveryNEvents: row.podcastEveryNEvents,
          podcastEventOffset: row.podcastEventOffset,
        })
      : defaultCalendarEventCompositionPolicy(target.id);
    policies.set(target.id, policy);

    if (policy.eventCompositionPolicy !== "PODCAST_THEN_MUSIC") continue;

    if (
      target.durationMode !== "CALENDAR" ||
      target.calendarDurationStrategy !== "PER_EVENT"
    ) {
      pushUniqueIssue(issues, {
        code: `CALENDAR03_PER_EVENT_REQUIRED:${target.id}`,
        message: `Destino "${target.name}": PODCAST_THEN_MUSIC exige duração por calendário com composição PER_EVENT.`,
        href: "/dashboard/configuracao/destinos",
      });
    }
    if (!hasPodcastSource) {
      pushUniqueIssue(issues, {
        code: `CALENDAR03_PODCAST_SOURCE_REQUIRED:${target.id}`,
        message: `Destino "${target.name}": adicione uma fonte de podcast para usar PODCAST_THEN_MUSIC.`,
        href: "/dashboard/configuracao/fontes",
      });
    }
    if (!hasMusicSource) {
      pushUniqueIssue(issues, {
        code: `CALENDAR03_MUSIC_SOURCE_REQUIRED:${target.id}`,
        message: `Destino "${target.name}": adicione uma fonte de música para preencher o restante das janelas.`,
        href: "/dashboard/configuracao/fontes",
      });
    }
  }

  const fingerprintPolicies = [...policies.values()].sort((left, right) =>
    left.targetPlaylistId.localeCompare(right.targetPlaylistId),
  );
  const fingerprint = sha256({
    baseFingerprint: effectiveBaseAssessment.fingerprint,
    calendar03Policies: fingerprintPolicies,
  });

  return {
    assessment: {
      ...effectiveBaseAssessment,
      issues,
      fingerprint,
    },
    policies,
    fingerprintPolicies,
  };
}

function pushUniqueIssue(
  issues: ConfigurationIssue[],
  issue: ConfigurationIssue,
): void {
  if (!issues.some((current) => current.code === issue.code)) {
    issues.push(issue);
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
