"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type State = {
  status: "idle" | "running" | "done" | "error";
  message?: string;
};

export function RunControls() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function run(simulate: boolean) {
    setState({ status: "running" });

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulate }),
      });
      const data = (await response.json()) as { status?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setState({
        status: "done",
        message: `${simulate ? "Simulação" : "Execução"}: ${data.status}`,
      });
      router.refresh();
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const busy = state.status === "running";

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(false)}
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
          {busy ? "Gerando…" : "Gerar agora"}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => run(true)}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-400/50 bg-violet-950/40 px-5 py-3 font-bold text-violet-200 transition hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-900/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 sm:w-auto"
        >
          <span aria-hidden="true">◇</span>
          Simular primeiro
        </button>
      </div>

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
