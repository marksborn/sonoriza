/**
 * FEATURE-PARITY-B1 (#460): read-only explanation of Playback Reserve availability.
 *
 * This is deliberately NOT a runtime authorization decision. The authoritative
 * Gate 8 still resolves its effective mode per run, using simulation evidence,
 * target scope, approved snapshots and policy fingerprints.
 */
export type PlaybackReserveAvailabilityStatus =
  | "TARGET_DISABLED"
  | "DESTINATION_NOT_LINKED"
  | "DISABLED_BY_CHOICE"
  | "UNSUPPORTED_UPDATE_POLICY"
  | "ROLLOUT_OFF"
  | "ROLLOUT_SHADOW"
  | "TARGET_NOT_IN_PILOT"
  | "ELIGIBLE_FOR_RUNTIME_VALIDATION";

export type PlaybackReserveAvailability = Readonly<{
  status: PlaybackReserveAvailabilityStatus;
  title: string;
  explanation: string;
}>;

export function resolvePlaybackReserveAvailability(input: Readonly<{
  enabled: boolean;
  linkedToSpotify: boolean;
  updatePolicy: string;
  reserveMode: "NONE" | "DURATION" | "MUSIC_TRACKS" | "PODCAST_EPISODES";
  requestedRuntimeMode?: string | null;
  allowedInPilot: boolean;
}>): PlaybackReserveAvailability {
  if (!input.enabled) {
    return {
      status: "TARGET_DISABLED",
      title: "Destino desativado",
      explanation: "A configuração fica salva, mas este destino não participa das gerações.",
    };
  }
  if (!input.linkedToSpotify) {
    return {
      status: "DESTINATION_NOT_LINKED",
      title: "Destino sem Spotify",
      explanation: "A regra pode ser configurada, mas o destino precisa estar vinculado antes de uma geração real.",
    };
  }
  if (input.reserveMode === "NONE") {
    return {
      status: "DISABLED_BY_CHOICE",
      title: "Sem reserva por configuração",
      explanation: "A regra efetiva deste destino está em Sem reserva. Nenhum buffer adicional foi solicitado.",
    };
  }
  if (input.updatePolicy !== "KEEP_FILLED" && input.updatePolicy !== "REBUILD_DAILY") {
    return {
      status: "UNSUPPORTED_UPDATE_POLICY",
      title: "Não disponível para esta atualização",
      explanation: "O runtime atual de Reserva exige Manter completa ou Reconstrução diária; a geração manual ainda não tem esse contexto de manutenção.",
    };
  }

  const mode = input.requestedRuntimeMode?.trim().toUpperCase() || "SHADOW";
  if (mode === "OFF") {
    return {
      status: "ROLLOUT_OFF",
      title: "Reserva desabilitada no sistema",
      explanation: "A regra está salva, mas o runtime não pode aplicá-la enquanto o controle global estiver desligado.",
    };
  }
  if (mode !== "ACTIVE") {
    return {
      status: "ROLLOUT_SHADOW",
      title: "Reserva em observação",
      explanation: "A configuração existe, mas o runtime está em SHADOW ou em modo não reconhecido: nenhuma aplicação real é autorizada por este estado.",
    };
  }
  if (!input.allowedInPilot) {
    return {
      status: "TARGET_NOT_IN_PILOT",
      title: "Ainda fora do piloto",
      explanation: "A política é compatível, mas este destino não está autorizado no rollout atual. A configuração salva não ativa a Reserva.",
    };
  }
  return {
    status: "ELIGIBLE_FOR_RUNTIME_VALIDATION",
    title: "Elegível para validação do runtime",
    explanation: "O piloto permite avaliar este destino, mas a Reserva só influencia uma geração quando todos os gates por execução forem aprovados (escopo único, simulação, snapshot e persistência de papéis). Este aviso não comprova ACTIVE.",
  };
}
