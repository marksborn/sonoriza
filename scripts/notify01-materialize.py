from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"expected block not found in {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# Prisma relations + notification persistence models.
schema = Path("prisma/schema.prisma")
text = schema.read_text(encoding="utf-8")
if "model NotificationPreference {" not in text:
    relation_old = "  targetScheduleRuns     TargetScheduleRun[]\n"
    relation_new = relation_old + (
        "  notificationPreference NotificationPreference?\n"
        "  pushSubscriptions       PushSubscription[]\n"
        "  pushDeliveries          PushDelivery[]\n"
    )
    if relation_old not in text:
        raise SystemExit("User relation anchor not found in prisma/schema.prisma")
    text = text.replace(relation_old, relation_new, 1)
    text += r'''

// ---------------------------------------------------------------------------
// NOTIFY-01 — Web Push subscriptions, preferences and idempotent delivery.
// ---------------------------------------------------------------------------

enum NotificationCategory {
  GENERATION
  CLEANUP
  ERROR
  NOOP
}

enum PushDeliveryStatus {
  PENDING
  SENT
  FAILED
  STALE
  SUPPRESSED
}

model NotificationPreference {
  id                String   @id @default(cuid())
  userId            String   @unique
  generationEnabled Boolean  @default(true)
  cleanupEnabled    Boolean  @default(true)
  errorEnabled      Boolean  @default(true)
  noopEnabled       Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model PushSubscription {
  id                String   @id @default(cuid())
  userId            String
  endpointHash      String   @unique
  endpoint          String   @db.Text
  p256dh            String   @db.Text
  auth              String   @db.Text
  expirationTime    DateTime?
  enabled           Boolean  @default(true)
  lastSuccessAt     DateTime?
  lastFailureAt     DateTime?
  lastFailureStatus Int?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user       User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  deliveries PushDelivery[]

  @@index([userId, enabled])
}

model PushDelivery {
  id             String               @id @default(cuid())
  userId         String
  subscriptionId String
  eventKey       String
  category       NotificationCategory
  payload        Json
  status         PushDeliveryStatus   @default(PENDING)
  attemptCount   Int                  @default(0)
  lastAttemptAt  DateTime?
  nextAttemptAt  DateTime?
  sentAt         DateTime?
  lastError      String?              @db.Text
  createdAt      DateTime             @default(now())
  updatedAt      DateTime             @updatedAt

  user         User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  subscription PushSubscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)

  @@unique([subscriptionId, eventKey])
  @@index([status, nextAttemptAt])
  @@index([userId, createdAt])
}
'''
    schema.write_text(text, encoding="utf-8")

# Scheduler: final audit first, push second.
replace_once(
    "src/jobs/scheduled-generation.ts",
    'import { prisma } from "@/lib/prisma";\n',
    'import { prisma } from "@/lib/prisma";\nimport { dispatchTargetScheduleRunNotificationSafely } from "@/services/notifications";\n',
)
replace_once(
    "src/jobs/scheduled-generation.ts",
    '''  await prisma.targetScheduleRun.updateMany({
    where: { id: { in: ids }, status: "RUNNING" },
    data: { status, reason, finishedAt },
  });
}''',
    '''  await prisma.targetScheduleRun.updateMany({
    where: { id: { in: ids }, status: "RUNNING" },
    data: { status, reason, finishedAt },
  });
  await Promise.all(ids.map((id) => dispatchTargetScheduleRunNotificationSafely(id)));
}''',
)
replace_once(
    "src/jobs/scheduled-generation.ts",
    '''  await prisma.targetScheduleRun.update({
    where: { id },
    data: {
      status,
      reason,
      finishedAt,
      ...data,
    },
  });
}''',
    '''  await prisma.targetScheduleRun.update({
    where: { id },
    data: {
      status,
      reason,
      finishedAt,
      ...data,
    },
  });
  await dispatchTargetScheduleRunNotificationSafely(id);
}''',
)

# Cleanup job: notify returned audits; on a write failure, look up only the audit
# created during this attempt. Preconditions without an audit stay silent.
replace_once(
    "src/jobs/cleanup-music-sources.ts",
    'import { prisma } from "@/lib/prisma";\n',
    'import { prisma } from "@/lib/prisma";\nimport { dispatchMusicCleanupRunNotificationSafely } from "@/services/notifications";\n',
)
replace_once(
    "src/jobs/cleanup-music-sources.ts",
    '''  for (const source of sources) {
    try {
      const result = await executeAutomaticMusicSourceCleanup(
        source.userId,
        source.id,
      );
      results.push({''',
    '''  for (const source of sources) {
    const attemptStartedAt = new Date();
    try {
      const result = await executeAutomaticMusicSourceCleanup(
        source.userId,
        source.id,
      );
      await dispatchMusicCleanupRunNotificationSafely(result.runId);
      results.push({''',
)
replace_once(
    "src/jobs/cleanup-music-sources.ts",
    '''    } catch (error) {
      results.push({
        sourcePlaylistId: source.id,''',
    '''    } catch (error) {
      const failedAudit = await prisma.musicSourceCleanupRun.findFirst({
        where: {
          userId: source.userId,
          sourcePlaylistId: source.id,
          startedAt: { gte: attemptStartedAt },
          finishedAt: { not: null },
          status: { in: ["FAILED", "PARTIAL", "SUCCESS"] },
        },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      });
      if (failedAudit) {
        await dispatchMusicCleanupRunNotificationSafely(failedAudit.id);
      }
      results.push({
        sourcePlaylistId: source.id,''',
)

# Manual real generation: notify only after GenerationRun and fingerprint are final.
replace_once(
    "src/app/api/generate/route.ts",
    'import { findReusableSimulationMusicOrderEvidence } from "@/services/music-order-simulation";\n',
    'import { findReusableSimulationMusicOrderEvidence } from "@/services/music-order-simulation";\nimport { dispatchGenerationRunNotificationSafely } from "@/services/notifications";\n',
)
replace_once(
    "src/app/api/generate/route.ts",
    '''  await prisma.generationRun.updateMany({
    where: {
      id: result.runId,
      userId: session.user.id,
      simulation: simulate,
    },
    data: {
      summary: {
        ...existingSummary,
        configurationFingerprint: assessment.fingerprint,
      } as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json(result);''',
    '''  await prisma.generationRun.updateMany({
    where: {
      id: result.runId,
      userId: session.user.id,
      simulation: simulate,
    },
    data: {
      summary: {
        ...existingSummary,
        configurationFingerprint: assessment.fingerprint,
      } as Prisma.InputJsonValue,
    },
  });

  if (!simulate) {
    await dispatchGenerationRunNotificationSafely(result.runId);
  }

  return NextResponse.json(result);''',
)

# Persist music/podcast breakdown in the canonical target summary used by
# scheduled notification bodies.
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''        ...stats,
        totalMinutes: Math.round(stats.totalDurationMs / 60_000),''',
    '''        ...stats,
        musicCount: items.filter((item) => item.type === "MUSIC").length,
        podcastCount: items.filter((item) => item.type === "PODCAST").length,
        musicDurationMs: items
          .filter((item) => item.type === "MUSIC")
          .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0),
        podcastDurationMs: items
          .filter((item) => item.type === "PODCAST")
          .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0),
        totalMinutes: Math.round(stats.totalDurationMs / 60_000),''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''              targetSummary.addedCount = items.length;
              targetSummary.maintenanceNoop = false;''',
    '''              targetSummary.addedCount = items.length;
              targetSummary.addedMusicCount = items.filter(
                (item) => item.type === "MUSIC",
              ).length;
              targetSummary.addedPodcastCount = items.filter(
                (item) => item.type === "PODCAST",
              ).length;
              targetSummary.addedMusicDurationMs = items
                .filter((item) => item.type === "MUSIC")
                .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
              targetSummary.addedPodcastDurationMs = items
                .filter((item) => item.type === "PODCAST")
                .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
              targetSummary.maintenanceNoop = false;''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''            targetSummary.addedCount = addedItems.length;
            targetSummary.unknownReplayPolicyCount = patch.unknownReplayPolicyCount;''',
    '''            targetSummary.addedCount = addedItems.length;
            targetSummary.addedMusicCount = addedItems.filter(
              (item) => item.type === "MUSIC",
            ).length;
            targetSummary.addedPodcastCount = addedItems.filter(
              (item) => item.type === "PODCAST",
            ).length;
            targetSummary.addedMusicDurationMs = addedItems
              .filter((item) => item.type === "MUSIC")
              .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
            targetSummary.addedPodcastDurationMs = addedItems
              .filter((item) => item.type === "PODCAST")
              .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
            targetSummary.unknownReplayPolicyCount = patch.unknownReplayPolicyCount;''',
)

# Configuration hub and bell icon.
replace_once(
    "src/components/UiIcon.tsx",
    '  | "calendar"\n',
    '  | "bell"\n  | "calendar"\n',
)
replace_once(
    "src/components/UiIcon.tsx",
    '''const ICON_PATHS: Record<UiIconName, ReactNode> = {
  "arrow-left": (''',
    '''const ICON_PATHS: Record<UiIconName, ReactNode> = {
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  "arrow-left": (''',
)
replace_once(
    "src/app/dashboard/configuracao/page.tsx",
    'import { prisma } from "@/lib/prisma";\n',
    'import { prisma } from "@/lib/prisma";\nimport { countActivePushSubscriptions } from "@/services/notifications";\n',
)
replace_once(
    "src/app/dashboard/configuracao/page.tsx",
    '''    cleanupInboxCount,
    ingestionRuleCount,
  ] = await Promise.all([''',
    '''    cleanupInboxCount,
    ingestionRuleCount,
    notificationDeviceCount,
  ] = await Promise.all([''',
)
replace_once(
    "src/app/dashboard/configuracao/page.tsx",
    '''    prisma.musicIngestionRule.count({
      where: { userId: session.user.id, enabled: true },
    }),
  ]);''',
    '''    prisma.musicIngestionRule.count({
      where: { userId: session.user.id, enabled: true },
    }),
    countActivePushSubscriptions(session.user.id),
  ]);''',
)
replace_once(
    "src/app/dashboard/configuracao/page.tsx",
    '''          <ConfigCard
            href="/dashboard/configuracao/revisao"
            icon="check"''',
    '''          <ConfigCard
            href="/dashboard/configuracao/notificacoes"
            icon="bell"
            badge={`${notificationDeviceCount} dispositivos`}
            code="NOTIFY-01"
            title="Notificações"
            description="Receba no PWA o resultado das gerações, manutenções, limpezas e bloqueios."
            action="Configurar notificações"
          />

          <ConfigCard
            href="/dashboard/configuracao/revisao"
            icon="check"''',
)

# Fix the concrete store method signature to match the interface and internal call.
store = Path("src/services/notifications/store.ts")
store_text = store.read_text(encoding="utf-8")
store_text = store_text.replace(
    "  async suppressDelivery(id: string, reason: string): Promise<void> {",
    "  async suppressDelivery(id: string, reason: string, _now: Date): Promise<void> {",
)
store.write_text(store_text, encoding="utf-8")

print("NOTIFY-01 materialization complete")
