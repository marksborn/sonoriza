import Link from "next/link";
import { redirect } from "next/navigation";

import { NotificationSettings } from "@/components/NotificationSettings";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import {
  countActivePushSubscriptions,
  getNotificationPreferences,
  getWebPushPublicConfiguration,
} from "@/services/notifications";

export default async function NotificationConfigurationPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const [preferences, activeDeviceCount] = await Promise.all([
    getNotificationPreferences(session.user.id),
    countActivePushSubscriptions(session.user.id),
  ]);
  const webPush = getWebPushPublicConfiguration();

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />
      <div className="relative mx-auto max-w-3xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
        >
          <UiIcon name="arrow-left" size={18} />
          Central de configuração
        </Link>

        <div className="mt-7 max-w-2xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
            NOTIFY-01
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Notificações operacionais
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Receba no dispositivo o resultado das gerações, manutenções, limpezas e bloqueios sem precisar acompanhar o painel.
          </p>
        </div>

        <div className="mt-7">
          <NotificationSettings
            configured={webPush.configured}
            publicKey={webPush.publicKey}
            initialPreferences={preferences}
            initialActiveDeviceCount={activeDeviceCount}
          />
        </div>
      </div>
    </main>
  );
}
