/**
 * PODCAST-08: reads the band evidence a run already persists
 * (`summary.podcast08ActiveGate`) so the review screen can say whether the
 * saved duration bands were applied to each target.
 */
export type Podcast08TargetReview = Readonly<{
  applied: boolean;
  fallbackCount: number;
  label: string;
}>;

const GATE_LABELS: Record<string, string> = {
  ABSTAIN_NO_EXPLICIT_ALLOWLIST: "nenhum destino liberado para faixas",
  ABSTAIN_TARGET_NOT_ALLOWLISTED: "destino não liberado para faixas",
  ABSTAIN_REAL_WRITE_NOT_APPROVED: "escrita real com faixas não aprovada",
  ABSTAIN_INVALID_BANDS: "nenhuma faixa específica salva",
  ABSTAIN_INVALID_LIMITS: "limites Curto/Médio inválidos",
  ABSTAIN_NOT_SEQUENCE: "destino não usa sequência",
  ABSTAIN_NOT_SINGLE_BLOCK: "destino por evento não suportado nesta versão",
  ABSTAIN_STATEFUL_ORDER: "programa com ordem estrita/sequencial",
};

export function readPodcast08TargetReviews(
  summary: unknown,
): ReadonlyMap<string, Podcast08TargetReview> {
  const reviews = new Map<string, Podcast08TargetReview>();
  const gate = record(record(summary)?.podcast08ActiveGate);
  if (!gate || !Array.isArray(gate.targets)) return reviews;

  for (const entry of gate.targets) {
    const target = record(entry);
    const targetId = typeof target?.targetPlaylistId === "string" ? target.targetPlaylistId : null;
    if (!target || !targetId) continue;
    const status = typeof target.status === "string" ? target.status : "";
    const runtime = record(target.runtime);
    const runtimeStatus = typeof runtime?.status === "string" ? runtime.status : null;
    const fallbackCount =
      typeof runtime?.fallbackCount === "number" && Number.isInteger(runtime.fallbackCount)
        ? Math.max(0, runtime.fallbackCount)
        : 0;

    if (status === "ACTIVE_ALLOWED" && runtimeStatus === "ACTIVE") {
      reviews.set(targetId, {
        applied: true,
        fallbackCount,
        label:
          fallbackCount === 0
            ? "aplicadas em todos os podcasts"
            : `aplicadas · ${fallbackCount} podcast${fallbackCount === 1 ? "" : "s"} em faixa vizinha`,
      });
      continue;
    }
    if (status === "ACTIVE_ALLOWED") {
      reviews.set(targetId, {
        applied: false,
        fallbackCount: 0,
        label:
          runtimeStatus === "ABSTAIN_UNSAFE_CONTEXT"
            ? "não aplicadas: programa com ordem estrita/sequencial"
            : "não aplicadas: composição por evento (CALENDAR-03/04) assumiu este destino",
      });
      continue;
    }
    if (status === "ABSTAIN_TARGET_NOT_ALLOWLISTED" || status === "ABSTAIN_INVALID_BANDS") {
      continue; // nothing configured for this target; stay silent
    }
    reviews.set(targetId, {
      applied: false,
      fallbackCount: 0,
      label: `não aplicadas: ${GATE_LABELS[status] ?? status}`,
    });
  }
  return reviews;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
