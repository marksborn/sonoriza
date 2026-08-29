import { DashboardNav } from "@/components/DashboardNav";
import { SpotifyBackoffBanner } from "@/components/SpotifyBackoffBanner";
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
    <div className="min-h-dvh bg-canvas-dark sm:min-h-0 sm:bg-transparent">
      <div className="h-dvh overflow-y-auto overscroll-y-contain bg-canvas-dark pb-[calc(6.75rem+env(safe-area-inset-bottom))] sm:h-auto sm:overflow-visible sm:bg-transparent sm:pb-0">
        {backoff ? (
          <SpotifyBackoffBanner
            reason={backoff.reason}
            blockedUntil={backoff.blockedUntil.toISOString()}
            retryAfterSecondsRemaining={retryAfterSecondsRemaining(backoff)}
          />
        ) : null}
        {children}
      </div>
      <DashboardNav />
    </div>
  );
}
