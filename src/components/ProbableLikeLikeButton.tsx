"use client";

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

  async function like() {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/history/probable-like/like", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spotifyTrackId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
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
    <div className="mt-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void like()}
        className="inline-flex items-center justify-center rounded-xl border border-success/50 bg-success-soft px-3.5 py-2 text-xs font-black text-success transition hover:border-success/80 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Curtindo…" : "♥ Curtir no Sonoriza"}
      </button>
      <p className="mt-1.5 text-[10px] font-semibold leading-4 text-muted-inverse/75">
        Preferência explícita e produtiva no Sonoriza. O Spotify não é alterado neste gate.
      </p>
      {error ? (
        <p className="mt-2 text-[11px] font-bold text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
