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

type Music06Explainability = {
  runId: string;
  startedAt: string;
  runStatus: string;
  policyVersion: string | null;
  status: string | null;
  policyEnabled: boolean;
  policyReason: string | null;
  approvalScope: string | null;
  boundedRerankAllowed: boolean;
  eligibilityChangeAllowed: boolean;
  sourceRunCount: number;
  selectedTargetCount: number;
  scrobbleCount: number | null;
  assessedOccurrenceCount: number;
  negativeOccurrenceCount: number;
  duplicateOccurrenceCount: number;
  conflictingOccurrenceCount: number;
  unprojectableOccurrenceCount: number;
  applicationCount: number;
  groupEvaluationCount: number;
  candidateOccurrenceCount: number;
  influencedCandidateOccurrenceCount: number;
  trackProjectionInfluenceCount: number;
  artistProjectionInfluenceCount: number;
  explicitPreferenceSuppressedCount: number;
  maxObservedMusicRankShift: number;
  applied: boolean;
  eligibilityChanged: boolean;
  applicationFailureCount: number;
  lastFailure: string | null;
  preparationFailure: string | null;
  evidenceKind: "INFERRED";
  evidenceMethod: "LASTFM_PLANNED_SEQUENCE_GAP";
  sourceLabel: "Last.fm + ordem publicada pelo Sonoriza";
  outcome:
    | "DISABLED"
    | "ABSTAINED"
    | "NO_RERANK"
    | "RERANK_APPLIED"
    | "FAILED_SAFE";
};

type GateState = {
  loading: boolean;
  realRunAllowed: boolean;
  requiresSimulation: boolean;
  reason: string | null;
  spotifyBackoff: SpotifyBackoff | null;
  music06Explainability: Music06Explainability | null;
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
    music06Explainability: null,
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
          music06Explainability?: Music06Explainability | null;
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
          music06Explainability: data.music06Explainability ?? null,
        });
      } catch (error) {
        if (!active) return;
        setGate({
          loading: false,
          realRunAllowed: false,
          requiresSimulation: true,
          reason: error instanceof Error ? error.message : String(error),
          spotifyBackoff: null,
          music06Explainability: null,
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
        music06Explainability?: Music06Explainability | null;
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
        music06Explainability:
          data.music06Explainability ?? current.music06Explainability,
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

      {gate.music06Explainability ? (
        <Music06ExplainabilityPanel value={gate.music06Explainability} />
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

function Music06ExplainabilityPanel({ value }: { value: Music06Explainability }) {
  const generatedAt = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value.startedAt));

  const outcome = music06Outcome(value);
  const tone =
    value.outcome === "FAILED_SAFE"
      ? "status-warning"
      : value.outcome === "RERANK_APPLIED"
        ? "status-success"
        : "border-brand-400/35 bg-brand/10 text-ink-inverse";

  return (
    <details className={`group rounded-2xl border px-4 py-3 text-sm ${tone}`}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-black">
            <span className="inline-flex items-center gap-1.5">
              <UiIcon name="music" size={16} />
              Curadoria inferida
            </span>
            <span className="rounded-full border border-current/20 px-2 py-0.5 text-[10px] uppercase tracking-wide opacity-80">
              não é fato
            </span>
          </p>
          <p className="mt-1 font-semibold">{outcome}</p>
          <p className="mt-1 text-xs opacity-70">
            Última geração com MUSIC-06: {generatedAt}
          </p>
        </div>
        <span className="shrink-0 pt-0.5 text-xs font-black opacity-75 transition group-open:rotate-180">
          ⌄
        </span>
      </summary>

      <div className="mt-4 space-y-4 border-t border-current/15 pt-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ExplainStat label="Avaliáveis" value={value.assessedOccurrenceCount} />
          <ExplainStat label="Sinais inferidos" value={value.negativeOccurrenceCount} />
          <ExplainStat label="Candidatas avaliadas" value={value.candidateOccurrenceCount} />
          <ExplainStat
            label="Reposicionadas"
            value={value.influencedCandidateOccurrenceCount}
          />
        </div>

        <div className="rounded-xl border border-current/15 bg-black/10 p-3 leading-6">
          <p className="font-black">Como o sinal é inferido</p>
          <p className="mt-1 opacity-85">
            O Sonoriza compara a ordem realmente publicada com os scrobbles do Last.fm. Um provável skip só entra no cálculo quando há faixas reconciliadas antes e depois da posição ausente e a cobertura daquela janela foi confirmada.
          </p>
          <p className="mt-2 opacity-75">
            Isso indica um <strong>gap observável</strong>, não o motivo psicológico do skip e nem que você deixou de gostar da música ou do artista.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <ExplainLine label="Tipo" value="INFERRED · inferência" />
          <ExplainLine label="Método" value={value.evidenceMethod} />
          <ExplainLine label="Origem" value={value.sourceLabel} />
          <ExplainLine
            label="Cobertura"
            value={`${value.selectedTargetCount} targets confirmados · ${value.sourceRunCount} runs-fonte`}
          />
        </div>

        <div className="rounded-xl border border-current/15 px-3 py-2.5 text-xs leading-5 opacity-85">
          <p>
            <strong>Proteções:</strong> o MUSIC-06 não usa Spotify como evidência comportamental de skip, não remove músicas e não muda elegibilidade. Preferências explícitas continuam mais fortes que a inferência.
          </p>
          {value.applied ? (
            <p className="mt-1.5">
              Nesta execução houve rerank limitado de {value.influencedCandidateOccurrenceCount} ocorrência(s), com deslocamento máximo de {value.maxObservedMusicRankShift} posição(ões) musicais.
            </p>
          ) : value.status === "READY" ? (
            <p className="mt-1.5">
              Nesta execução a evidência ficou abaixo dos thresholds produtivos; a ordem permaneceu inalterada.
            </p>
          ) : null}
          {value.explicitPreferenceSuppressedCount > 0 ? (
            <p className="mt-1.5">
              {value.explicitPreferenceSuppressedCount} influência(s) inferida(s) foram suprimidas por preferência explícita.
            </p>
          ) : null}
          <p className="mt-1.5 opacity-70">
            Elegibilidade alterada: {value.eligibilityChanged ? "sim" : "não"} · falhas de aplicação: {value.applicationFailureCount}
          </p>
        </div>
      </div>
    </details>
  );
}

function ExplainStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-current/15 bg-black/10 px-3 py-2">
      <p className="text-lg font-black">{value.toLocaleString("pt-BR")}</p>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-65">{label}</p>
    </div>
  );
}

function ExplainLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="rounded-xl border border-current/15 bg-black/10 px-3 py-2 text-xs leading-5">
      <span className="block font-black uppercase tracking-wide opacity-60">{label}</span>
      <span className="font-semibold">{value}</span>
    </p>
  );
}

function music06Outcome(value: Music06Explainability): string {
  switch (value.outcome) {
    case "RERANK_APPLIED":
      return `${value.influencedCandidateOccurrenceCount} ocorrência(s) reposicionada(s), no máximo ${value.maxObservedMusicRankShift} posição(ões).`;
    case "NO_RERANK":
      return `${value.negativeOccurrenceCount} sinal(is) inferido(s) em ${value.assessedOccurrenceCount} ocorrência(s) avaliáveis; nenhuma ordem alterada.`;
    case "ABSTAINED":
      return `Sem influência nesta execução: ${value.status ?? "evidência indisponível"}.`;
    case "DISABLED":
      return "MUSIC-06 estava desativado nesta execução.";
    case "FAILED_SAFE":
      return "A influência foi ignorada por segurança; a geração continuou sem aplicar o rerank.";
  }
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
