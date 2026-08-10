"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type SpotifyBackoff = {
  reason: "QUOTA_EXCEEDED" | "RATE_LIMITED";
  blockedUntil: string;
  retryAfterSecondsRemaining: number;
};

const SPOTIFY_ACTION_LABELS = new Set([
  "Criar regra",
  "Pré-visualizar",
  "Sincronizar agora",
  "Confirmar importação atual",
  "Adicionar",
]);

export default function MusicIngestionTemplate({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [backoff, setBackoff] = useState<SpotifyBackoff | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/generate", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { spotifyBackoff?: SpotifyBackoff | null }) => {
        if (active) setBackoff(data.spotifyBackoff ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const buttons = [...root.querySelectorAll("button")].filter((button) =>
      SPOTIFY_ACTION_LABELS.has(button.textContent?.trim() ?? ""),
    );
    for (const button of buttons) {
      button.disabled = Boolean(backoff);
      button.setAttribute("aria-disabled", backoff ? "true" : "false");
      if (backoff) button.title = `Spotify bloqueado até ${formatBackoffDate(backoff.blockedUntil)}`;
      else button.removeAttribute("title");
    }

    if (!backoff) return;
    const delay = Math.max(250, Date.parse(backoff.blockedUntil) - Date.now() + 250);
    const timer = window.setTimeout(() => window.location.reload(), delay);
    return () => window.clearTimeout(timer);
  }, [backoff]);

  function blockSpotifySubmit(event: FormEvent<HTMLDivElement>) {
    if (!backoff) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;
    if (!SPOTIFY_ACTION_LABELS.has(submitter.textContent?.trim() ?? "")) return;
    event.preventDefault();
    event.stopPropagation();
    (event.nativeEvent as SubmitEvent).stopImmediatePropagation();
  }

  return (
    <div ref={rootRef} onSubmitCapture={blockSpotifySubmit}>
      {backoff ? (
        <div className="mx-auto mt-4 max-w-5xl rounded-2xl border border-orange-400/30 bg-orange-950/30 px-4 py-3 text-sm text-orange-100">
          <p className="font-black">MUSIC-03 temporariamente bloqueada pelo Spotify</p>
          <p className="mt-1 font-semibold">
            Novas consultas e escritas ficam desabilitadas até {formatBackoffDate(backoff.blockedUntil)} ({formatRemaining(backoff.retryAfterSecondsRemaining)}).
          </p>
        </div>
      ) : null}
      {children}
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
  const safe = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.ceil((safe % 3600) / 60);
  if (hours > 0) return `aprox. ${hours}h${String(minutes).padStart(2, "0")}`;
  if (minutes > 0) return `aprox. ${minutes} min`;
  return "menos de 1 min";
}
