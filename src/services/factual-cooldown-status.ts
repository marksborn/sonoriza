export type FactualCooldownDisplay = Readonly<{
  state: "VERIFIED" | "OBSERVED" | "UNCONFIRMED" | "NOT_APPLIED" | "UNKNOWN";
  label: string;
  description: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Historical presentation only. Never derives policy compliance from SUCCESS. */
export function factualCooldownDisplay(input: {
  summary: unknown;
  runStatus: string;
  simulation?: boolean;
}): FactualCooldownDisplay {
  const summary = record(input.summary);
  const factual = record(summary?.musicRepeatLastFmFactual);
  const unknown: FactualCooldownDisplay = {
    state: "UNKNOWN", label: "Sem registro da proteção",
    description: "Esta execução não tem evidência reconhecida da conferência do histórico Last.fm.",
  };
  if (!factual || factual.policyVersion !== "music-repeat-lastfm-factual-v1" ||
      factual.source !== "LASTFM_SCROBBLE") return unknown;

  if (["OFF", "USER_NOT_ALLOWLISTED", "POLICY_DISABLED"].includes(String(factual.status))) {
    return { state: "NOT_APPLIED", label: "Proteção não aplicada",
      description: "A regra factual do Last.fm não foi aplicada nesta execução." };
  }
  if (input.simulation || summary?.simulate === true) {
    return { state: "OBSERVED", label: "Conferência em simulação",
      description: "Esta conferência não comprova a proteção de uma atualização real." };
  }
  if (factual.configuredMode === "SHADOW" && factual.effectiveMode === "SHADOW" &&
      factual.status === "READY_SHADOW" && factual.providerComplete === true) {
    return { state: "OBSERVED", label: "Proteção somente observada",
      description: "A regra factual do Last.fm foi observada, sem excluir músicas por essa regra." };
  }
  if (factual.configuredMode !== "ACTIVE") return unknown;
  if (factual.effectiveMode === "ACTIVE" && factual.status === "READY_ACTIVE" &&
      factual.productiveInfluenceAllowed === true && factual.providerComplete === true &&
      factual.preWriteRevalidated === true && factual.preWriteBlockedCount === 0 &&
      ["SUCCESS", "PARTIAL"].includes(input.runStatus)) {
    return { state: "VERIFIED", label: "Proteção factual verificada",
      description: "O histórico Last.fm foi conferido antes da atualização. A comparação usa artista e título; versões com nomes diferentes ainda podem não ser reconhecidas." };
  }
  const label = factual.status === "PROVIDER_UNAVAILABLE" ? "Histórico Last.fm indisponível"
    : factual.status === "PROVIDER_INCOMPLETE" ? "Conferência Last.fm incompleta" : "Proteção não confirmada";
  return { state: "UNCONFIRMED", label,
    description: "Não há confirmação de cobertura completa e revalidação do Last.fm antes da atualização. O resultado geral da execução não comprova essa proteção." };
}
