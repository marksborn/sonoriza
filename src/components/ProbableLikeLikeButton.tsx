"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProbableLikeLikeButton({
  spotifyTrackId,
}: {
  spotifyTrackId: string;
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
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void like()}
        className="inline-flex items-center justify-center rounded-xl border border-success/50 bg-success-soft px-3.5 py-2 text-xs font-black text-success transition hover:border-success/80 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Curtindo…" : "♥ Curtir"}
      </button>
      <p className="mt-1.5 max-w-xs text-[10px] font-semibold leading-4 text-muted-inverse/75">
        Salva em Músicas Curtidas do Spotify e confirma a preferência no Sonoriza.
      </p>
      {error ? (
        <div className="mt-2 text-[11px] font-bold text-rose-300">
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
