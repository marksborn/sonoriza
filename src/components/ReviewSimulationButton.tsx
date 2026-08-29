"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { UiIcon } from "@/components/UiIcon";
import { readJsonApiResponse } from "@/services/http-api-response";

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
  const searchParams = useSearchParams();
  const displayedRunId = searchParams.get("run");
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backoff, setBackoff] = useState<SpotifyBackoff | null>(null);

  useEffect(() => {
    setRunning(false);
  }, [displayedRunId]);

  useEffect(() => {
    let active = true;

    async function loadBackoff() {
      try {
        const response = await fetch("/api/generate", { cache: "no-store" });
        const data = await readJsonApiResponse<ApiResult>(
          response,
          "a verificação do Spotify",
        );
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

  useEffect(() => {
    const blockedUntil = backoff?.blockedUntil;
    if (!blockedUntil) return;
    const delay = Math.max(250, Date.parse(blockedUntil) - Date.now() + 250);
    const timer = window.setTimeout(() => window.location.reload(), delay);
    return () => window.clearTimeout(timer);
  }, [backoff?.blockedUntil]);

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
      const data = await readJsonApiResponse<ApiResult>(response, "a simulação");

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
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-5 py-3 font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 sm:w-auto"
      >
        {running || checking ? (
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-brand-900/30 border-t-brand-900"
          />
        ) : (
          <UiIcon name="play" size={18} fill="currentColor" strokeWidth={1.5} />
        )}
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
        <p role="alert" className="status-danger flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold">
          <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
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
    <div role="status" className="status-warning max-w-xl rounded-2xl border px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-black">
        <UiIcon name="warning" size={17} />
        {backoff.reason === "QUOTA_EXCEEDED"
          ? "Quota do Spotify temporariamente indisponível"
          : "Limite temporário de requisições do Spotify"}
      </p>
      <p className="mt-1 font-semibold">
        Tente novamente após <strong>{until}</strong> ({remaining}).
      </p>
      <p className="mt-1 opacity-75">
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
