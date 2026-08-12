import { prisma } from "@/lib/prisma";

import {
  formatDurationCompact,
  formatElapsedCompact,
  isStalePushStatus,
  notificationPreferenceAllows,
  safePushErrorMessage,
  sanitizeNotificationReason,
  statusCodeFromPushError,
} from "./core";
import { PrismaNotificationDeliveryStore } from "./store";
import type {
  DeliveryAttempt,
  NotificationDeliveryStore,
  OperationalNotificationEvent,
  OperationalPushPayload,
  PushSender,
} from "./types";
import { sendOperationalWebPush } from "./web-push";

type DeliveryDependencies = {
  store?: NotificationDeliveryStore;
  sender?: PushSender;
  now?: () => Date;
};

export type NotificationDeliveryResult = {
  eligible: boolean;
  subscriptions: number;
  sent: number;
  stale: number;
  failed: number;
  skipped: number;
};

const defaultStore = new PrismaNotificationDeliveryStore();

export async function deliverOperationalNotification(
  event: OperationalNotificationEvent,
  deps: DeliveryDependencies = {},
): Promise<NotificationDeliveryResult> {
  const store = deps.store ?? defaultStore;
  const sender = deps.sender ?? sendOperationalWebPush;
  const now = deps.now ?? (() => new Date());
  const result: NotificationDeliveryResult = {
    eligible: false,
    subscriptions: 0,
    sent: 0,
    stale: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    const preferences = await store.getPreferences(event.userId);
    if (!notificationPreferenceAllows(event.category, preferences)) {
      result.skipped += 1;
      return result;
    }
    result.eligible = true;

    const subscriptions = await store.listActiveSubscriptions(event.userId);
    result.subscriptions = subscriptions.length;

    for (const subscription of subscriptions) {
      let delivery: DeliveryAttempt | null = null;
      try {
        delivery = await store.claimEventDelivery(event, subscription, now());
        if (!delivery) {
          result.skipped += 1;
          continue;
        }
        await sendClaimedDelivery(delivery, store, sender, now, result);
      } catch {
        // Notification infrastructure is intentionally isolated from the
        // generation/cleanup transaction that produced the event.
        result.failed += 1;
      }
    }
  } catch {
    // Reading preferences/subscriptions must also remain best-effort.
    result.failed += 1;
  }

  return result;
}

export async function retryDuePushDeliveries(
  limit = 50,
  deps: DeliveryDependencies = {},
): Promise<NotificationDeliveryResult> {
  const store = deps.store ?? defaultStore;
  const sender = deps.sender ?? sendOperationalWebPush;
  const now = deps.now ?? (() => new Date());
  const result: NotificationDeliveryResult = {
    eligible: true,
    subscriptions: 0,
    sent: 0,
    stale: 0,
    failed: 0,
    skipped: 0,
  };

  let ids: string[] = [];
  try {
    ids = await store.listDueDeliveryIds(now(), Math.max(1, Math.min(limit, 200)));
  } catch {
    result.failed += 1;
    return result;
  }

  for (const id of ids) {
    try {
      const delivery = await store.claimExistingDelivery(id, now());
      if (!delivery) {
        result.skipped += 1;
        continue;
      }
      result.subscriptions += 1;
      const preferences = await store.getPreferences(delivery.userId);
      if (!notificationPreferenceAllows(delivery.category, preferences)) {
        await store.suppressDelivery(
          delivery.id,
          "Preferência desativada antes do retry",
          now(),
        );
        result.skipped += 1;
        continue;
      }
      await sendClaimedDelivery(delivery, store, sender, now, result);
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

async function sendClaimedDelivery(
  delivery: DeliveryAttempt,
  store: NotificationDeliveryStore,
  sender: PushSender,
  now: () => Date,
  result: NotificationDeliveryResult,
): Promise<void> {
  try {
    await sender(delivery.subscription, delivery.payload, delivery.eventKey);
    await store.markSent(delivery, now());
    result.sent += 1;
  } catch (error) {
    const statusCode = statusCodeFromPushError(error);
    if (isStalePushStatus(statusCode)) {
      await store.markStale(delivery, statusCode, now());
      result.stale += 1;
      return;
    }
    await store.markFailed(
      delivery,
      statusCode,
      safePushErrorMessage(error),
      now(),
    );
    result.failed += 1;
  }
}

export async function dispatchTargetScheduleRunNotificationSafely(
  scheduleRunId: string,
): Promise<void> {
  try {
    const run = await prisma.targetScheduleRun.findUnique({
      where: { id: scheduleRunId },
      include: { target: { select: { id: true, name: true } } },
    });
    if (!run || run.status === "RUNNING" || !run.finishedAt) return;

    const details = objectRecord(run.details);
    const category =
      run.status === "BLOCKED" || run.status === "FAILED"
        ? "ERROR"
        : run.status === "NOOP"
          ? "NOOP"
          : "GENERATION";
    const payload = scheduleRunPayload({
      name: run.target.name,
      targetPlaylistId: run.target.id,
      status: run.status,
      targetDurationMs: run.targetDurationMs,
      preservedCount: run.preservedCount,
      removedCount: run.removedCount,
      addedCount: run.addedCount,
      addedMusicCount: numberFromRecord(details, "addedMusicCount"),
      addedPodcastCount: numberFromRecord(details, "addedPodcastCount"),
      addedMusicDurationMs: numberFromRecord(details, "addedMusicDurationMs"),
      addedPodcastDurationMs: numberFromRecord(details, "addedPodcastDurationMs"),
      reason: run.reason,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });

    await deliverOperationalNotification({
      userId: run.userId,
      eventKey: `target-schedule:${run.id}:${run.attempt}`,
      category,
      payload,
    });
  } catch {
    // Never let push observability mutate scheduler semantics.
  }
}

export async function dispatchGenerationRunNotificationSafely(
  generationRunId: string,
): Promise<void> {
  try {
    const run = await prisma.generationRun.findUnique({
      where: { id: generationRunId },
      include: {
        items: {
          select: { contentType: true, durationMs: true },
        },
      },
    });
    if (!run || run.simulation || run.trigger !== "MANUAL" || !run.finishedAt) return;

    const music = run.items.filter((item) => item.contentType === "MUSIC");
    const podcasts = run.items.filter((item) => item.contentType === "PODCAST");
    const totalDurationMs = run.items.reduce(
      (sum, item) => sum + Math.max(0, item.durationMs),
      0,
    );
    const category = run.status === "FAILED" ? "ERROR" : "GENERATION";
    const statusLabel =
      run.status === "FAILED"
        ? "falhou"
        : run.status === "PARTIAL"
          ? "concluída com alertas"
          : "concluída";
    const elapsed = formatElapsedCompact(run.startedAt, run.finishedAt);
    const reason = sanitizeNotificationReason(run.error);
    const body =
      run.status === "FAILED"
        ? reason ?? "A geração terminou com erro. Abra o Sonoriza para revisar."
        : compactJoin([
            `${run.items.length} itens`,
            `${music.length} músicas`,
            `${podcasts.length} podcasts`,
            formatDurationCompact(totalDurationMs),
            elapsed ? `em ${elapsed}` : null,
          ]);

    await deliverOperationalNotification({
      userId: run.userId,
      eventKey: `generation:${run.id}`,
      category,
      payload: {
        title: `Geração ${statusLabel}`,
        body,
        url: "/dashboard",
        tag: `generation-${run.id}`,
      },
    });
  } catch {
    // Main generation result is already final and remains authoritative.
  }
}

export async function dispatchMusicCleanupRunNotificationSafely(
  cleanupRunId: string,
): Promise<void> {
  try {
    const run = await prisma.musicSourceCleanupRun.findUnique({
      where: { id: cleanupRunId },
      include: { source: { select: { name: true } } },
    });
    if (!run || run.status === "PREVIEW" || !run.finishedAt) return;

    const removedCount = arrayLength(run.removedUris);
    const failedCount = arrayLength(run.failedUris);
    const category =
      run.status === "FAILED" || run.status === "STALE" ? "ERROR" : "CLEANUP";
    const elapsed = formatElapsedCompact(run.startedAt, run.finishedAt);
    const name = run.source.name ?? "Escutar";
    const title =
      run.status === "SUCCESS"
        ? `Limpeza concluída — ${name}`
        : run.status === "PARTIAL"
          ? `Limpeza parcial — ${name}`
          : `Limpeza falhou — ${name}`;
    const reason = sanitizeNotificationReason(run.error);
    const body =
      category === "ERROR"
        ? reason ?? "A limpeza não pôde ser concluída. Abra o Sonoriza para revisar."
        : compactJoin([
            `${removedCount} músicas removidas`,
            `${run.keptCount} mantidas`,
            `${failedCount} erros`,
            elapsed ? `em ${elapsed}` : null,
          ]);

    await deliverOperationalNotification({
      userId: run.userId,
      eventKey: `music-cleanup:${run.id}`,
      category,
      payload: {
        title,
        body,
        url: "/dashboard/configuracao/limpeza",
        tag: `cleanup-${run.id}`,
      },
    });
  } catch {
    // Cleanup audit is authoritative; push failure cannot rewrite it.
  }
}

function scheduleRunPayload(input: {
  name: string;
  targetPlaylistId: string;
  status: string;
  targetDurationMs: number | null;
  preservedCount: number;
  removedCount: number;
  addedCount: number;
  addedMusicCount: number | null;
  addedPodcastCount: number | null;
  addedMusicDurationMs: number | null;
  addedPodcastDurationMs: number | null;
  reason: string | null;
  startedAt: Date;
  finishedAt: Date;
}): OperationalPushPayload {
  const elapsed = formatElapsedCompact(input.startedAt, input.finishedAt);
  const reason = sanitizeNotificationReason(input.reason);

  if (input.status === "BLOCKED" || input.status === "FAILED") {
    return {
      title: `${input.name} — execução ${input.status === "BLOCKED" ? "bloqueada" : "falhou"}`,
      body: reason ?? "A manutenção não pôde ser concluída. Abra o destino para revisar.",
      url: `/dashboard/playlists/${input.targetPlaylistId}`,
      tag: `schedule-${input.targetPlaylistId}`,
    };
  }

  if (input.status === "NOOP") {
    return {
      title: `${input.name} já estava completa`,
      body: compactJoin([
        input.targetDurationMs ? formatDurationCompact(input.targetDurationMs) : null,
        `${input.preservedCount} mantidas`,
        reason,
        elapsed ? `verificado em ${elapsed}` : null,
      ]),
      url: `/dashboard/playlists/${input.targetPlaylistId}`,
      tag: `schedule-${input.targetPlaylistId}`,
    };
  }

  const addedBreakdown =
    input.addedMusicCount !== null || input.addedPodcastCount !== null
      ? compactJoin([
          input.addedMusicCount !== null ? `${input.addedMusicCount} músicas` : null,
          input.addedPodcastCount !== null ? `${input.addedPodcastCount} podcasts` : null,
        ])
      : null;
  const addedDurations =
    input.addedMusicDurationMs !== null || input.addedPodcastDurationMs !== null
      ? compactJoin([
          input.addedMusicDurationMs !== null
            ? `${formatDurationCompact(input.addedMusicDurationMs)} música`
            : null,
          input.addedPodcastDurationMs !== null
            ? `${formatDurationCompact(input.addedPodcastDurationMs)} podcast`
            : null,
        ])
      : null;

  return {
    title: `${input.name} ${input.status === "PARTIAL" ? "atualizada com alertas" : "atualizada"}`,
    body: compactJoin([
      input.targetDurationMs ? formatDurationCompact(input.targetDurationMs) : null,
      `${input.preservedCount} mantidas`,
      `${input.addedCount} adicionadas`,
      `${input.removedCount} removidas`,
      addedBreakdown,
      addedDurations,
      elapsed ? `em ${elapsed}` : null,
    ]),
    url: `/dashboard/playlists/${input.targetPlaylistId}`,
    tag: `schedule-${input.targetPlaylistId}`,
  };
}

function compactJoin(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberFromRecord(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  const item = value?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
