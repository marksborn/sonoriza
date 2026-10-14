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
  | "SIMULATION_AVAILABLE_REAL_NOT_AUTHORIZED"
  | "PRODUCT_OPT_IN_PENDING_ROLLOUT"
  | "PRODUCT_AUTHORIZED_FOR_RUNTIME_VALIDATION"
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
  capabilitySimulationEnabled?: boolean;
  productOptInEnabled?: boolean;
  productAuthorizationEnabled?: boolean;
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
      explanation: "A margem está disponível, por enquanto, apenas para playlists que usam Manter completa ou Reconstrução diária.",
    };
  }

  const mode = input.requestedRuntimeMode?.trim().toUpperCase() || "SHADOW";
  if (mode === "OFF") {
    return {
      status: "ROLLOUT_OFF",
      title: "Margem temporariamente desativada",
      explanation: "Você pode salvar a regra, mas o sistema está com a aplicação da margem desligada.",
    };
  }
  if (mode !== "ACTIVE") {
    return {
      status: "ROLLOUT_SHADOW",
      title: "Margem em avaliação",
      explanation: "A margem pode ser configurada, mas ainda não está liberada para uso real nesta situação.",
    };
  }
  if (!input.allowedInPilot) {
    if (input.productOptInEnabled && input.productAuthorizationEnabled) {
      return {
        status: "PRODUCT_AUTHORIZED_FOR_RUNTIME_VALIDATION",
        title: "Autorização registrada",
        explanation: "Você autorizou esta playlist e o sistema permite avaliar a margem. Ainda é preciso uma simulação aprovada e verificações de segurança antes de aplicá-la. Isso não significa que já foi publicada.",
      };
    }
    if (input.productOptInEnabled) {
      return {
        status: "PRODUCT_OPT_IN_PENDING_ROLLOUT",
        title: "Autorização salva; aguardando liberação",
        explanation: "Você autorizou a margem, mas ela ainda não foi liberada para esta playlist. Nenhuma alteração será feita agora.",
      };
    }
    if (input.capabilitySimulationEnabled) {
      return {
        status: "SIMULATION_AVAILABLE_REAL_NOT_AUTHORIZED",
        title: "Prévia disponível na simulação",
        explanation: "A simulação mostra quantos itens a margem acrescentaria, mas a playlist simulada e publicada continua sem eles. Para incluir a margem de verdade, ainda será necessária a liberação do sistema e uma nova simulação aprovada.",
      };
    }
    return {
      status: "TARGET_NOT_IN_PILOT",
      title: "Aguardando liberação",
      explanation: "Esta playlist é compatível, mas a margem ainda não foi liberada para ela. Você pode salvar a configuração sem modificar a reprodução.",
    };
  }
  return {
    status: "ELIGIBLE_FOR_RUNTIME_VALIDATION",
    title: "Incluída no piloto da margem",
    explanation: "Esta playlist participa do piloto da margem. Ela só recebe conteúdo extra quando uma simulação e as verificações de segurança são aprovadas. Isso não significa que a margem já foi publicada.",
  };
}
