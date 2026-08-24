"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { UiIcon } from "@/components/UiIcon";
import { spotifyBackoffRemainingMs } from "@/services/spotify/backoff-ui";

type State = {
  status: "idle" | "running" | "done" | "error";
  message?: string;
};

type SpotifyBackoff = {
  code: "SPOTIFY_BACKOFF_ACTIVE";
  reason: "QUOTA_EXCEEDED" | "RATE_LIMITED";
  operation: string | null;
  blockedUntil: string;
  retryAfterSecondsRemaining: number;
};

type GateState = {
  loading: boolean;
  realRunAllowed: boolean;
  requiresSimulation: boolean;
  reason: string | null;
  spotifyBackoff: SpotifyBackoff | null;
};

export function RunControls() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const [gate, setGate] = useState<GateState>({
    loading: true,
    realRunAllowed: false,
    requiresSimulation: true,
    reason: null,
    spotifyBackoff: null,
  });

  useEffect(() => {
    let active = true;

    async function loadGate() {
      try {
        const response = await fetch("/api/generate", { cache: "no-store" });
        const data = (await response.json()) as {
          realRunAllowed?: boolean;
          requiresSimulation?: boolean;
          reason?: string | null;
          spotifyBackoff?: SpotifyBackoff | null;
          error?: string;
        };

        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!active) return;

        setGate({
          loading: false,
          realRunAllowed: Boolean(data.realRunAllowed),
          requiresSimulation: Boolean(data.requiresSimulation),
          reason: data.reason ?? null,
          spotifyBackoff: data.spotifyBackoff ?? null,
        });
      } catch (error) {
        if (!active) return;
        setGate({
          loading: false,
          realRunAllowed: false,
          requiresSimulation: true,
          reason: error instanceof Error ? error.message : String(error),
          spotifyBackoff: null,
        });
      }
    }

    void loadGate();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const blockedUntil = gate.spotifyBackoff?.blockedUntil;
    if (!blockedUntil) return;

    const remainingMs = spotifyBackoffRemainingMs(blockedUntil);
    const clearExpiredBackoff = () => {
      setGate((current) => {
        if (current.spotifyBackoff?.blockedUntil !== blockedUntil) return current;
        return { ...current, spotifyBackoff: null };
      });
    };

    if (remainingMs === null || remainingMs === 0) {
      clearExpiredBackoff();
      return;
    }

    const timer = window.setTimeout(clearExpiredBackoff, remainingMs + 250);
    return () => window.clearTimeout(timer);
  }, [gate.spotifyBackoff?.blockedUntil]);

  async function runReal() {
    if (gate.spotifyBackoff) return;
    setState({ status: "running" });

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulate: false }),
      });
      const data = (await response.json()) as {
        status?: string;
        error?: string;
        code?: string;
        reason?: SpotifyBackoff["reason"];
        operation?: string | null;
        blockedUntil?: string;
        retryAfterSecondsRemaining?: number;
      };

      if (!response.ok) {
        if (
          data.code === "SPOTIFY_BACKOFF_ACTIVE" &&
          data.reason &&
          data.blockedUntil &&
          typeof data.retryAfterSecondsRemaining === "number"
        ) {
          setGate((current) => ({
            ...current,
            spotifyBackoff: {
              code: "SPOTIFY_BACKOFF_ACTIVE",
              reason: data.reason!,
              operation: data.operation ?? null,
              blockedUntil: data.blockedUntil!,
              retryAfterSecondsRemaining: data.retryAfterSecondsRemaining!,
            },
          }));
        }
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setState({
        status: "done",
        message: `Execução: ${data.status}`,
      });
      setGate((current) => ({
        ...current,
        realRunAllowed: true,
        requiresSimulation: false,
        reason: null,
      }));
      router.refresh();
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const busy = state.status === "running";
  const realDisabled =
    busy || gate.loading || !gate.realRunAllowed || Boolean(gate.spotifyBackoff);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={realDisabled}
          onClick={runReal}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-5 py-3 font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 sm:w-auto"
        >
          {busy ? (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-brand-900/30 border-t-brand-900"
            />
          ) : (
            <UiIcon name="play" size={18} fill="currentColor" strokeWidth={1.5} />
          )}
          {busy
            ? "Gerando…"
            : gate.loading
              ? "Verificando…"
              : gate.spotifyBackoff
                ? "Spotify temporariamente bloqueado"
                : "Gerar agora"}
        </button>

        <Link
          href="/dashboard/configuracao/revisao"
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-line-dark/70 bg-surface-elevated/70 px-5 py-3 font-bold text-ink-inverse transition hover:-translate-y-0.5 hover:border-brand-400/60 hover:bg-surface-elevated sm:w-auto"
        >
          <UiIcon name="check" size={18} />
          Revisar e simular
        </Link>
      </div>

      {gate.spotifyBackoff ? (
        <SpotifyBackoffNotice backoff={gate.spotifyBackoff} />
      ) : !gate.loading && !gate.realRunAllowed ? (
        <div className="status-warning rounded-2xl border px-4 py-3 text-sm">
          <p className="font-semibold">{gate.reason ?? "Revise e simule a configuração antes da primeira geração real."}</p>
          <Link href="/dashboard/configuracao/revisao" className="product-link mt-2">
            Abrir CONFIG-04
            <UiIcon name="arrow-right" size={17} />
          </Link>
        </div>
      ) : null}

      {state.message && (
        <div
          role={state.status === "error" ? "alert" : "status"}
          className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${
            state.status === "error" ? "status-danger" : "status-success"
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <UiIcon name={state.status === "error" ? "warning" : "check"} size={17} />
            {state.message}
          </span>
        </div>
      )}
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
  const reason =
    backoff.reason === "QUOTA_EXCEEDED"
      ? "quota do Spotify excedida"
      : "limite temporário de requisições do Spotify";

  return (
    <div className="status-warning rounded-2xl border px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-black">
        <UiIcon name="warning" size={17} />
        Ações do Spotify bloqueadas temporariamente
      </p>
      <p className="mt-1 font-semibold">
        Motivo: {reason}. Tente novamente após <strong>{until}</strong>
        {remaining ? ` (${remaining})` : ""}.
      </p>
      <p className="mt-1 opacity-75">
        Até esse horário o Sonoriza não iniciará novas chamadas ao Spotify.
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
