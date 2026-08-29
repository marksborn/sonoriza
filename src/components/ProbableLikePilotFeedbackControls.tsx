"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type PilotVerdict = "LIKED" | "INDIFFERENT" | "DISLIKED";

const OPTIONS: Array<{
  verdict: PilotVerdict;
  label: string;
  idleClass: string;
  selectedClass: string;
}> = [
  {
    verdict: "LIKED",
    label: "👍 Gostei mesmo",
    idleClass:
      "border-success/30 bg-success-soft/60 text-success hover:border-success/60",
    selectedClass:
      "border-success/70 bg-success-soft text-success ring-1 ring-success/40",
  },
  {
    verdict: "INDIFFERENT",
    label: "➖ Indiferente",
    idleClass:
      "border-warning/30 bg-warning-soft/60 text-warning hover:border-warning/60",
    selectedClass:
      "border-warning/70 bg-warning-soft text-warning ring-1 ring-warning/40",
  },
  {
    verdict: "DISLIKED",
    label: "👎 Não gostei",
    idleClass:
      "border-rose-400/30 bg-rose-400/10 text-rose-300 hover:border-rose-400/60",
    selectedClass:
      "border-rose-400/70 bg-rose-400/15 text-rose-200 ring-1 ring-rose-400/40",
  },
];

export function ProbableLikePilotFeedbackControls({
  spotifyTrackId,
  initialVerdict,
}: {
  spotifyTrackId: string;
  initialVerdict: PilotVerdict | null;
}) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<PilotVerdict | null>(initialVerdict);
  const [busy, setBusy] = useState<PilotVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(nextVerdict: PilotVerdict) {
    if (busy) return;
    setBusy(nextVerdict);
    setError(null);

    try {
      const response = await fetch("/api/history/probable-like-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spotifyTrackId, verdict: nextVerdict }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error || "Não foi possível registrar a avaliação.");
      }

      setVerdict(nextVerdict);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível registrar a avaliação.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 border-t border-line-dark/45 pt-3">
      <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-muted-inverse/85">
        Sua avaliação do ranking
      </p>
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((option) => {
          const selected = verdict === option.verdict;
          return (
            <button
              key={option.verdict}
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={selected}
              onClick={() => void submit(option.verdict)}
              className={`rounded-xl border px-3 py-2 text-xs font-black transition disabled:cursor-wait disabled:opacity-60 ${
                selected ? option.selectedClass : option.idleClass
              }`}
            >
              {busy === option.verdict ? "Salvando…" : option.label}
            </button>
          );
        })}
      </div>
      {verdict ? (
        <p className="mt-2 text-[11px] font-semibold text-muted-inverse/85">
          Registrado apenas para validar a qualidade do piloto. Não cria LIKE, dislike ou cooldown.
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] font-bold text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
