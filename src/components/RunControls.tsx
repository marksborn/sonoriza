"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 font-black text-white shadow-[0_16px_36px_-18px_rgba(255,107,0,0.95)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 sm:w-auto"
        >
          <span
            aria-hidden="true"
            className={`flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs ${
              busy ? "animate-pulse" : ""
            }`}
          >
            {busy ? "…" : "▶"}
          </span>
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
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-400/50 bg-violet-950/40 px-5 py-3 font-bold text-violet-200 transition hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-900/60 hover:text-white sm:w-auto"
        >
          <span aria-hidden="true">◇</span>
          Revisar e simular
        </Link>
      </div>

      {gate.spotifyBackoff ? (
        <SpotifyBackoffNotice backoff={gate.spotifyBackoff} />
      ) : !gate.loading && !gate.realRunAllowed ? (
        <div className="rounded-2xl border border-orange-400/25 bg-orange-950/20 px-4 py-3 text-sm text-orange-100/85">
          <p className="font-semibold">{gate.reason ?? "Revise e simule a configuração antes da primeira geração real."}</p>
          <Link href="/dashboard/configuracao/revisao" className="mt-2 inline-flex font-black text-orange-300 hover:text-orange-200">
            Abrir CONFIG-04 →
          </Link>
        </div>
      ) : null}

      {state.message && (
        <div
          role={state.status === "error" ? "alert" : "status"}
          className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${
            state.status === "error"
              ? "border-red-400/35 bg-red-950/45 text-red-200"
              : "border-violet-400/25 bg-violet-950/50 text-violet-100"
          }`}
        >
          {state.message}
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
    <div className="rounded-2xl border border-orange-400/30 bg-orange-950/25 px-4 py-3 text-sm text-orange-100/90">
      <p className="font-black">Ações do Spotify bloqueadas temporariamente</p>
      <p className="mt-1 font-semibold">
        Motivo: {reason}. Tente novamente após <strong>{until}</strong>
        {remaining ? ` (${remaining})` : ""}.
      </p>
      <p className="mt-1 text-orange-100/70">
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