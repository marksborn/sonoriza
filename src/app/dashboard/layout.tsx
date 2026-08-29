import Link from "next/link";

import { SpotifyBackoffBanner } from "@/components/SpotifyBackoffBanner";
import { UiIcon } from "@/components/UiIcon";
import {
  getActiveSpotifyBackoff,
  retryAfterSecondsRemaining,
} from "@/services/spotify/backoff";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const backoff = await getActiveSpotifyBackoff();

  return (
    <>
      {backoff ? (
        <SpotifyBackoffBanner
          reason={backoff.reason}
          blockedUntil={backoff.blockedUntil.toISOString()}
          retryAfterSecondsRemaining={retryAfterSecondsRemaining(backoff)}
        />
      ) : null}
      <div className="bg-canvas-dark pb-24 sm:bg-transparent sm:pb-0">{children}</div>
      <div className="fixed inset-x-3 bottom-3 z-50 flex flex-row items-center justify-end gap-1.5 sm:inset-x-auto sm:bottom-7 sm:right-7 sm:flex-col sm:items-end sm:gap-2">
        <Link
          href="/dashboard/descobrir"
          className="inline-flex items-center gap-1.5 rounded-xl border border-brand-400/40 bg-brand/95 px-3 py-2 text-xs font-black text-white shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-brand-400 sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm"
        >
          <UiIcon
            name="music"
            size={19}
            className="h-[17px] w-[17px] sm:h-[19px] sm:w-[19px]"
          />
          Descobrir
        </Link>
        <Link
          href="/dashboard/historico"
          className="inline-flex items-center gap-1.5 rounded-xl border border-line-dark/70 bg-surface-elevated/95 px-3 py-2 text-xs font-black text-ink-inverse shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-brand-400/55 hover:bg-surface-subtle sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm"
        >
          <UiIcon
            name="history"
            size={19}
            className="h-[17px] w-[17px] sm:h-[19px] sm:w-[19px]"
          />
          Histórico
        </Link>
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-1.5 rounded-xl border border-line-dark/70 bg-surface-elevated/95 px-3 py-2 text-xs font-black text-ink-inverse shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-brand-400/55 hover:bg-surface-subtle sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm"
        >
          <UiIcon
            name="settings"
            size={19}
            className="h-[17px] w-[17px] sm:h-[19px] sm:w-[19px]"
          />
          Configurar
        </Link>
      </div>
    </>
  );
}
