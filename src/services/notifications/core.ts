import { createHash } from "node:crypto";

import type {
  NotificationCategoryValue,
  NotificationPreferencesShape,
  OperationalPushPayload,
} from "./types";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesShape = {
  generationEnabled: true,
  cleanupEnabled: true,
  errorEnabled: true,
  noopEnabled: false,
};

export const MAX_PUSH_ATTEMPTS = 5;
export const DELIVERY_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

export function notificationPreferenceAllows(
  category: NotificationCategoryValue,
  preferences: NotificationPreferencesShape,
): boolean {
  if (category === "GENERATION") return preferences.generationEnabled;
  if (category === "CLEANUP") return preferences.cleanupEnabled;
  if (category === "ERROR") return preferences.errorEnabled;
  return preferences.noopEnabled;
}

export function hashPushEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function sanitizeNotificationUrl(url: string | null | undefined): string {
  const value = url?.trim() ?? "";
  if (value === "/dashboard" || value.startsWith("/dashboard/")) return value;
  return "/dashboard";
}

export function sanitizeNotificationReason(
  reason: string | null | undefined,
  maxLength = 150,
): string | null {
  if (!reason) return null;
  const clean = reason
    .replace(/Bearer\s+[^\s]+/gi, "credencial protegida")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`;
}

export function formatDurationCompact(valueMs: number | null | undefined): string {
  const ms = Math.max(0, valueMs ?? 0);
  if (ms < 60_000) return "<1min";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${String(minutes).padStart(2, "0")}min`;
}

export function formatElapsedCompact(
  startedAt: Date | null | undefined,
  finishedAt: Date | null | undefined,
): string | null {
  if (!startedAt || !finishedAt) return null;
  const seconds = Math.max(
    0,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}min` : `${minutes}min ${remainder}s`;
}

export function retryDelayMs(attemptCount: number): number {
  if (attemptCount <= 1) return 60_000;
  if (attemptCount === 2) return 5 * 60_000;
  return 30 * 60_000;
}

export function isStalePushStatus(statusCode: number | null | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

export function safePushErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeNotificationReason(message, 180) ?? "Falha ao entregar Web Push";
}

export function statusCodeFromPushError(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function normalizePushPayload(
  payload: OperationalPushPayload,
): OperationalPushPayload {
  return {
    title: sanitizeNotificationReason(payload.title, 80) ?? "Sonoriza",
    body: sanitizeNotificationReason(payload.body, 240) ?? "Atualização concluída.",
    url: sanitizeNotificationUrl(payload.url),
    tag: sanitizeNotificationReason(payload.tag, 80) ?? "sonoriza-operational",
  };
}

export function notificationTopic(eventKey: string): string {
  return createHash("sha256").update(eventKey).digest("base64url").slice(0, 28);
}
