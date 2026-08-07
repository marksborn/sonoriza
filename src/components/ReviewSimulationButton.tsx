"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  disabled?: boolean;
};

type ApiResult = {
  runId?: string;
  status?: string;
  error?: string;
};

export function ReviewSimulationButton({ disabled = false }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function simulate() {
    if (disabled || running) return;

    setRunning(true);
    setError(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulate: true }),
      });
      const data = (await response.json()) as ApiResult;

      if (!response.ok) {
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

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={disabled || running}
        onClick={simulate}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 font-black text-white shadow-[0_16px_36px_-18px_rgba(255,107,0,0.95)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 sm:w-auto"
      >
        <span aria-hidden="true">{running ? "…" : "◇"}</span>
        {running ? "Simulando…" : "Simular configuração"}
      </button>

      {error && (
        <p role="alert" className="rounded-2xl border border-red-400/30 bg-red-950/40 px-4 py-3 text-sm font-semibold text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
