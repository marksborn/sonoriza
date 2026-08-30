"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProbableLikeDismissButton({
  spotifyTrackId,
}: {
  spotifyTrackId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/history/probable-like/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spotifyTrackId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Não foi possível ocultar a sugestão.");
      }
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível ocultar a sugestão.",
      );
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void dismiss()}
        className="inline-flex items-center justify-center rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-2 text-xs font-black text-warning transition hover:border-warning/70 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Ocultando…" : "Agora não"}
      </button>
      <p className="mt-1.5 max-w-xs text-[10px] font-semibold leading-4 text-muted-inverse/75">
        Oculta esta sugestão por 90 dias. Não é dislike.
      </p>
      {error ? (
        <p className="mt-2 text-[11px] font-bold text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
