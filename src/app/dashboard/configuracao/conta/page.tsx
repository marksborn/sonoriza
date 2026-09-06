import Link from "next/link";
import { redirect } from "next/navigation";

import { SpotifyDisconnectSettings } from "@/components/SpotifyDisconnectSettings";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import {
  buildSpotifyDisconnectPreparationUiState,
  prepareSpotifyDisconnect,
} from "@/services/data-policy";

export default async function AccountPrivacyConfigurationPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const preparation = await prepareSpotifyDisconnect(session.user.id);
  const initialState = buildSpotifyDisconnectPreparationUiState(preparation);

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-4xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
        >
          <UiIcon name="arrow-left" size={18} />
          Central de configuração
        </Link>

        <div className="mt-7 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
            PRIVACY-01
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Conta e privacidade
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Revise o impacto antes de desconectar o Spotify. A limpeza local exige fingerprint fresco e confirmação exata; a revogação do acesso no Spotify permanece uma ação manual do usuário.
          </p>
        </div>

        <div className="mt-7">
          <SpotifyDisconnectSettings initialState={initialState} />
        </div>
      </div>
    </main>
  );
}
