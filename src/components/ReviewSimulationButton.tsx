"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  disabled?: boolean;
  label?: string;
  runningLabel?: string;
};

type SpotifyBackoff = {
  code: "SPOTIFY_BACKOFF_ACTIVE";
  reason: "QUOTA_EXCEEDED" | "RATE_LIMITED";
  operation: string | null;
  blockedUntil: string;
  retryAfterSecondsRemaining: number;
};

type ApiResult = {
  runId?: string;
  status?: string;
  error?: string;
  code?: string;
  reason?: SpotifyBackoff["reason"];
  operation?: string | null;
  blockedUntil?: string;
  retryAfterSecondsRemaining?: number;
  spotifyBackoff?: SpotifyBackoff | null;
};

export function ReviewSimulationButton({
  disabled = false,
  label = "Simular configuração",
  runningLabel = "Simulando…",
}: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backoff, setBackoff] = useState<SpotifyBackoff | null>(null);

  useEffect(() => {
    let active = true;

    async function loadBackoff() {
      try {
        const response = await fetch("/api/generate", { cache: "no-store" });
        const data = (await response.json()) as ApiResult;
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!active) return;
        setBackoff(data.spotifyBackoff ?? null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setChecking(false);
      }
    }

    void loadBackoff();
    return () => {
      active = false;
    };
  }, []);

  async function simulate() {
    if (disabled || running || checking || backoff) return;

    setRunning(true);
    setError(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulate: true }),
      });
      const data = (await response.json()) as ApiResult;

      if (!response.ok) {
        if (
          data.code === "SPOTIFY_BACKOFF_ACTIVE" &&
          data.reason &&
          data.blockedUntil &&
          typeof data.retryAfterSecondsRemaining === "number"
        ) {
          setBackoff({
            code: "SPOTIFY_BACKOFF_ACTIVE",
            reason: data.reason,
            operation: data.operation ?? null,
            blockedUntil: data.blockedUntil,
            retryAfterSecondsRemaining: data.retryAfterSecondsRemaining,
          });
        }
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      if (!data.runId) {
        throw new Error("A simulação terminou sem identificar a execução.");
      }

      router.push(`/dashboard/configuracao/revisao?run=${encodeURIComponent(data.runId)}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  const blocked = disabled || running || checking || Boolean(backoff);

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={blocked}
        onClick={simulate}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 font-black text-white shadow-[0_16px_36px_-18px_rgba(255,107,0,0.95)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 sm:w-auto"
      >
        <span aria-hidden="true">{running || checking ? "…" : "◇"}</span>
        {running
          ? runningLabel
          : checking
            ? "Verificando Spotify…"
            : backoff
              ? "Simulação bloqueada pelo Spotify"
              : label}
      </button>

      {backoff ? <SpotifyBackoffNotice backoff={backoff} /> : null}

      {error && !backoff ? (
        <p role="alert" className="rounded-2xl border border-red-400/30 bg-red-950/40 px-4 py-3 text-sm font-semibold text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SpotifyBackoffNotice({ backoff }: { backoff: SpotifyBackoff }) {
  const until = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(backoff.blockedUntil));
  const remaining = formatRemaining(backoff.retryAfterSecondsRemaining);

  return (
    <div role="status" className="max-w-xl rounded-2xl border border-orange-400/30 bg-orange-950/30 px-4 py-3 text-sm text-orange-100">
      <p className="font-black">
        {backoff.reason === "QUOTA_EXCEEDED"
          ? "Quota do Spotify temporariamente indisponível"
          : "Limite temporário de requisições do Spotify"}
      </p>
      <p className="mt-1 font-semibold">
        Tente novamente após <strong>{until}</strong> ({remaining}).
      </p>
      <p className="mt-1 text-orange-100/70">
        Até esse horário a simulação permanece desabilitada e nenhuma nova chamada ao Spotify será iniciada.
      </p>
    </div>
  );
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.ceil((safe % 3600) / 60);
  if (hours > 0) return `aprox. ${hours}h${String(minutes).padStart(2, "0")}`;
  if (minutes > 0) return `aprox. ${minutes} min`;
  return "menos de 1 min";
}