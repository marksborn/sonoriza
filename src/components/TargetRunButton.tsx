"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { UiIcon } from "@/components/UiIcon";

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
  reason: string | null;
  spotifyBackoff: SpotifyBackoff | null;
};

type RunState = {
  status: "idle" | "running" | "done" | "error";
  message: string | null;
};

export function TargetRunButton({
  targetId,
  targetName,
}: {
  targetId: string;
  targetName: string;
}) {
  const router = useRouter();
  const [gate, setGate] = useState<GateState>({
    loading: true,
    realRunAllowed: false,
    reason: null,
    spotifyBackoff: null,
  });
  const [run, setRun] = useState<RunState>({ status: "idle", message: null });

  useEffect(() => {
    let active = true;

    async function loadGate() {
      try {
        const response = await fetch("/api/generate", { cache: "no-store" });
        const data = (await response.json()) as {
          realRunAllowed?: boolean;
          reason?: string | null;
          spotifyBackoff?: SpotifyBackoff | null;
          error?: string;
        };

        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!active) return;

        setGate({
          loading: false,
          realRunAllowed: Boolean(data.realRunAllowed),
          reason: data.reason ?? null,
          spotifyBackoff: data.spotifyBackoff ?? null,
        });
      } catch (error) {
        if (!active) return;
        setGate({
          loading: false,
          realRunAllowed: false,
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

  async function runTarget() {
    if (gate.spotifyBackoff) return;

    setRun({ status: "running", message: null });
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simulate: false,
          targetPlaylistIds: [targetId],
        }),
      });
      const data = (await response.json()) as {
        status?: string;
        runId?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setRun({
        status: "done",
        message: `Geração de ${targetName}: ${data.status ?? "concluída"}`,
      });
      router.refresh();
    } catch (error) {
      setRun({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const busy = run.status === "running";
  const disabled =
    busy || gate.loading || !gate.realRunAllowed || Boolean(gate.spotifyBackoff);

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled}
        onClick={runTarget}
        className="inline-flex w-fit items-center gap-2 rounded-2xl bg-accent px-4 py-2.5 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
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
          ? `Gerando ${targetName}…`
          : gate.loading
            ? "Verificando…"
            : gate.spotifyBackoff
              ? "Spotify temporariamente bloqueado"
              : `Gerar somente ${targetName}`}
      </button>

      {!gate.loading && !gate.realRunAllowed ? (
        <p className="max-w-sm text-xs leading-5 text-white/75">
          {gate.reason ?? "Revise e simule a configuração antes de uma geração real."}{" "}
          <Link
            href="/dashboard/configuracao/revisao"
            className="font-bold text-accent-400 underline-offset-2 hover:underline"
          >
            Revisar
          </Link>
        </p>
      ) : null}

      {run.message ? (
        <p
          role={run.status === "error" ? "alert" : "status"}
          className={`max-w-sm text-xs font-semibold ${
            run.status === "error" ? "text-danger" : "text-success"
          }`}
        >
          {run.message}
        </p>
      ) : null}
    </div>
  );
}
