"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type State = { status: "idle" | "running" | "done" | "error"; message?: string };

/**
 * Manual and simulated generation triggers for the dashboard. Calls
 * POST /api/generate and refreshes so the new run appears in the history.
 */
export function RunControls() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function run(simulate: boolean) {
    setState({ status: "running" });
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulate }),
      });
      const data = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState({
        status: "done",
        message: `${simulate ? "Simulação" : "Execução"}: ${data.status}`,
      });
      router.refresh();
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const busy = state.status === "running";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => run(false)}
        className="rounded-full bg-brand px-5 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50"
      >
        {busy ? "Gerando…" : "Gerar agora"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => run(true)}
        className="rounded-full border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        Simular
      </button>
      {state.message && (
        <span
          className={
            state.status === "error" ? "text-sm text-red-600" : "text-sm text-neutral-500"
          }
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
