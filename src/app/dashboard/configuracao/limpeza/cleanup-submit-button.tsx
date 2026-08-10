"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

type CleanupSubmitButtonProps = {
  removableTrackCount: number;
};

type SpotifyBackoff = {
  blockedUntil: string;
};

export function CleanupSubmitButton({
  removableTrackCount,
}: CleanupSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [checking, setChecking] = useState(true);
  const [backoff, setBackoff] = useState<SpotifyBackoff | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/generate", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { spotifyBackoff?: SpotifyBackoff | null }) => {
        if (active) setBackoff(data.spotifyBackoff ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!backoff?.blockedUntil) return;
    const delay = Math.max(250, Date.parse(backoff.blockedUntil) - Date.now() + 250);
    const timer = window.setTimeout(() => window.location.reload(), delay);
    return () => window.clearTimeout(timer);
  }, [backoff?.blockedUntil]);

  const blocked = pending || checking || Boolean(backoff);

  return (
    <button
      type="submit"
      disabled={blocked}
      aria-disabled={blocked}
      aria-live="polite"
      title={backoff ? `Spotify bloqueado até ${formatBackoffDate(backoff.blockedUntil)}` : undefined}
      className="rounded-xl border border-red-200/30 bg-red-500/20 px-4 py-2.5 text-sm font-black text-red-50 transition hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending
        ? `Removendo ${removableTrackCount} faixa(s)...`
        : checking
          ? "Verificando Spotify…"
          : backoff
            ? "Remoção bloqueada pelo Spotify"
            : `Confirmar remoção de ${removableTrackCount} faixa(s)`}
    </button>
  );
}

function formatBackoffDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}