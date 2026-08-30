"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProbableLikeLikeButton({
  spotifyTrackId,
  compact = false,
}: {
  spotifyTrackId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnectPath, setReconnectPath] = useState<string | null>(null);

  async function like() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReconnectPath(null);

    try {
      const response = await fetch("/api/history/probable-like/like", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spotifyTrackId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; code?: string; reconnectPath?: string }
        | null;

      if (!response.ok) {
        if (
          payload?.code === "SPOTIFY_RECONNECT_REQUIRED" &&
          payload.reconnectPath
        ) {
          setReconnectPath(payload.reconnectPath);
        }
        throw new Error(payload?.error || "Não foi possível curtir a faixa.");
      }

      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível curtir a faixa.",
      );
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "min-w-0" : undefined}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void like()}
        title="Salvar em Músicas Curtidas do Spotify e confirmar no Sonoriza"
        className={`inline-flex min-h-11 items-center justify-center rounded-xl border border-success/60 bg-success px-4 py-2 text-xs font-black text-canvas-dark shadow-sm transition hover:border-success hover:bg-success/90 disabled:cursor-wait disabled:opacity-60 ${
          compact ? "w-full" : ""
        }`}
      >
        {busy ? "Curtindo…" : "♥ Curtir"}
      </button>
      {!compact ? (
        <p className="mt-1.5 max-w-xs text-[10px] font-semibold leading-4 text-muted-inverse/75">
          Salva em Músicas Curtidas do Spotify e confirma a preferência no Sonoriza.
        </p>
      ) : null}
      {error ? (
        <div className="mt-2 text-[11px] font-bold text-rose-300" role="alert">
          <p>{error}</p>
          {reconnectPath ? (
            <Link
              href={reconnectPath}
              className="mt-1.5 inline-flex text-orange-200 underline decoration-orange-300/50 underline-offset-2 hover:text-orange-100"
            >
              Reconectar Spotify
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
