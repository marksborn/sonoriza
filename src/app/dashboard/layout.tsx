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
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2 sm:bottom-7 sm:right-7">
        <Link
          href="/dashboard/descobrir"
          className="inline-flex items-center gap-2 rounded-2xl border border-brand-400/40 bg-brand/95 px-4 py-3 text-sm font-black text-white shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-brand-400"
        >
          <UiIcon name="music" size={19} />
          Descobrir
        </Link>
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 rounded-2xl border border-line-dark/70 bg-surface-elevated/95 px-4 py-3 text-sm font-black text-ink-inverse shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-brand-400/55 hover:bg-surface-subtle"
        >
          <UiIcon name="settings" size={19} />
          Configurar
        </Link>
      </div>
    </>
  );
}
