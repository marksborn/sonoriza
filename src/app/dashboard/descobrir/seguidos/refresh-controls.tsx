"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFormStatus } from "react-dom";

export function FollowedRefreshButton({ running }: { running: boolean }) {
  const { pending } = useFormStatus();
  const busy = pending || running;
  return (
    <button
      type="submit"
      disabled={busy}
      aria-disabled={busy}
      aria-live="polite"
      className="primary-button inline-flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
    >
      {busy && (
        <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
      )}
      {busy ? "Lendo artistas…" : "Atualizar agora"}
    </button>
  );
}

/** While a background read runs, re-render the page every few seconds. */
export function FollowedRefreshPoller({ active, intervalMs = 8000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
