import type { ComponentProps } from "react";

import { canEnableTargetReserveActivation } from "@/services/playback-reserve-product-activation";

/**
 * B1.7 — pure server-renderable consent UI.
 *
 * This is a display/form component only. The backend action must still verify
 * ownership, eligibility and all independent runtime/Spotify write gates.
 */
export function PlaybackReserveTargetConsentForm({
  targetPlaylistId,
  enabled,
  spotifyPlaylistId,
  updatePolicy,
  reserveMode,
  activation,
  productAuthorizationEnabled,
  action,
}: Readonly<{
  targetPlaylistId: string;
  enabled: boolean;
  spotifyPlaylistId: string | null;
  updatePolicy: string;
  reserveMode: "NONE" | "DURATION" | "MUSIC_TRACKS" | "PODCAST_EPISODES";
  activation: Readonly<{ enabled: boolean; confirmedAt: Date | null }>;
  productAuthorizationEnabled: boolean;
  action: ComponentProps<"form">["action"];
}>) {
  const optInEligible = canEnableTargetReserveActivation({
    enabled,
    spotifyPlaylistId,
    updatePolicy,
    effectivePolicy: { reserveMode },
  });

  return (
    <div className="mt-4 rounded-xl border border-line-dark/70 bg-surface-dark/45 p-4">
      <p className="text-sm font-black text-ink-inverse">
        Autorização de Reserva por destino
      </p>
      <p className="mt-1 text-sm leading-6 text-muted-inverse">
        {activation.enabled
          ? productAuthorizationEnabled
            ? "Autorizada por você. A execução real continua dependendo da simulação aprovada e das verificações de segurança."
            : "Autorizada por você, mas ainda aguardando liberação do sistema. Nenhuma ativação produtiva é permitida por esta preferência isoladamente."
          : "Não autorizada. Esta opção não interfere na configuração da margem nem no piloto já existente."}
      </p>
      <form action={action} className="mt-3">
        <input type="hidden" name="targetPlaylistId" value={targetPlaylistId} />
        <input type="hidden" name="activationAction" value={activation.enabled ? "disable" : "enable"} />
        <button
          type="submit"
          disabled={!activation.enabled && !optInEligible}
          className="rounded-lg border border-line-dark px-4 py-2 text-sm font-bold text-ink-inverse disabled:cursor-not-allowed disabled:opacity-50"
        >
          {activation.enabled ? "Revogar autorização" : "Autorizar Reserva neste destino"}
        </button>
      </form>
      {!activation.enabled && !optInEligible ? (
        <p className="mt-2 text-xs text-muted-inverse">
          Para autorizar: habilite e vincule o destino, use Manter completa ou Reconstrução diária e configure uma regra diferente de Sem reserva.
        </p>
      ) : null}
    </div>
  );
}
