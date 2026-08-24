"use client";

import { useEffect, useState } from "react";

import { UiIcon } from "@/components/UiIcon";
import { spotifyBackoffRemainingMs } from "@/services/spotify/backoff-ui";

type SpotifyBackoffBannerProps = {
  reason: "QUOTA_EXCEEDED" | "RATE_LIMITED";
  blockedUntil: string;
  retryAfterSecondsRemaining: number;
};

export function SpotifyBackoffBanner({
  reason,
  blockedUntil,
  retryAfterSecondsRemaining,
}: SpotifyBackoffBannerProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const remainingMs = spotifyBackoffRemainingMs(blockedUntil);
    if (remainingMs === null || remainingMs === 0) {
      setVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setVisible(false), remainingMs + 250);
    return () => window.clearTimeout(timer);
  }, [blockedUntil]);

  if (!visible) return null;

  return (
    <div className="sticky top-0 z-[70] border-b border-warning/30 bg-warning-soft/95 px-4 py-3 text-warning shadow-lg backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-5">
        <p className="flex items-center gap-2 font-black">
          <UiIcon name="warning" size={18} />
          Spotify temporariamente bloqueado · {reason === "QUOTA_EXCEEDED" ? "quota excedida" : "limite de requisições"}
        </p>
        <p className="font-semibold text-warning/80">
          Tente novamente após {formatBackoffDate(blockedUntil)} · {formatRemaining(retryAfterSecondsRemaining)}
        </p>
      </div>
    </div>
  );
}

function formatBackoffDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.ceil((safe % 3600) / 60);
  if (hours > 0) return `aprox. ${hours}h${String(minutes).padStart(2, "0")}`;
  if (minutes > 0) return `aprox. ${minutes} min`;
  return "menos de 1 min";
}
