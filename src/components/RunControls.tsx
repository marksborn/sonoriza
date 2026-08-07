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
          className="primary-button w-full sm:w-auto"
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
          className="secondary-button w-full sm:w-auto"
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
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-brand/10 bg-brand-soft text-brand-dark"
          }`}
        >
          {state.message}
        </div>
      )}
    </div>
  );
}
