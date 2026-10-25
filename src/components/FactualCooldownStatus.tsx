import * as React from "react";
import { factualCooldownDisplay } from "@/services/factual-cooldown-status";

export function FactualCooldownStatus(props: Parameters<typeof factualCooldownDisplay>[0]) {
  const status = factualCooldownDisplay(props);
  const tone = status.state === "VERIFIED" ? "text-emerald-300"
    : status.state === "UNCONFIRMED" ? "text-amber-300" : "text-muted-inverse";
  return (
    <div aria-label="Proteção contra repetição" className="mt-3 rounded-xl border border-line-dark/55 p-3">
      <p className={`text-sm font-bold ${tone}`}>{status.label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-inverse">{status.description}</p>
    </div>
  );
}
