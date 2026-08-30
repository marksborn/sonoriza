import { MusicSourceRetentionMode } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";

import { UiIcon, type UiIconName } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { isPrelaunchAdmin } from "@/lib/prelaunch-admin";
import { prisma } from "@/lib/prisma";
import { countActivePushSubscriptions } from "@/services/notifications";

type ConfigCardProps = {
  href: string;
  icon: UiIconName;
  badge: string;
  code: string;
  title: string;
  description: string;
  action: string;
};

function ConfigCard({
  href,
  icon,
  badge,
  code,
  title,
  description,
  action,
}: ConfigCardProps) {
  return (
    <Link href={href} className="product-panel group p-6 transition hover:-translate-y-0.5 hover:border-brand-400/45">
      <div className="flex items-start justify-between gap-4">
        <span className="product-icon-tile">
          <UiIcon name={icon} size={22} />
        </span>
        <span className="product-badge">{badge}</span>
      </div>
      <p className="mt-5 text-xs font-black uppercase tracking-[0.15em] text-brand-400">
        {code}
      </p>
      <h2 className="mt-1 text-xl font-black text-ink-inverse">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-inverse">{description}</p>
      <span className="product-link mt-5">
        {action}
        <UiIcon name="arrow-right" size={18} />
      </span>
    </Link>
  );
}

export default async function ConfigurationHubPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const [
    calendarCount,
    sourceCount,
    targetCount,
    musicPolicy,
    cleanupInboxCount,
    ingestionRuleCount,
    notificationDeviceCount,
  ] = await Promise.all([
    prisma.calendarSelection.count({
      where: { userId: session.user.id, selected: true },
    }),
    prisma.sourcePlaylist.count({
      where: { userId: session.user.id, enabled: true },
    }),
    prisma.targetPlaylist.count({
      where: { userId: session.user.id, enabled: true },
    }),
    prisma.musicPlaybackPolicy.findUnique({
      where: { userId: session.user.id },
      select: { enabled: true, windowValue: true, windowUnit: true },
    }),
    prisma.sourcePlaylist.count({
      where: {
        userId: session.user.id,
        musicRetentionMode: MusicSourceRetentionMode.REMOVE_AFTER_PLAYED,
      },
    }),
    prisma.musicIngestionRule.count({
      where: { userId: session.user.id, enabled: true },
    }),
    countActivePushSubscriptions(session.user.id),
  ]);

  const musicPolicyLabel = musicPolicy?.enabled
    ? `${musicPolicy.windowValue ?? "?"} ${
        musicPolicy.windowUnit === "DAYS"
          ? "dias"
          : musicPolicy.windowUnit === "MONTHS"
            ? "meses"
            : "anos"
      }`
    : "Desativada";

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
        >
          <UiIcon name="arrow-left" size={18} />
          Voltar ao painel
        </Link>

        <div className="mt-7 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
            Configuração
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Prepare o Sonoriza para o seu dia.
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Escolha de onde o conteúdo vem, quais eventos entram no cálculo de tempo e como cada playlist de destino deve ser montada.
          </p>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <ConfigCard
            href="/dashboard/configuracao/calendarios"
            icon="calendar"
            badge={`${calendarCount} ativos`}
            code="CONFIG-01"
            title="Calendários do Google"
            description="Defina os calendários consultados e quais eventos representam viagens."
            action="Configurar calendários"
          />

          <ConfigCard
            href="/dashboard/configuracao/fontes"
            icon="music"
            badge={`${sourceCount} ativas`}
            code="CONFIG-02"
            title="Fontes do Spotify"
            description="Escolha playlists de músicas e programas de podcast que alimentam o motor."
            action="Configurar fontes"
          />

          <ConfigCard
            href="/dashboard/configuracao/musica"
            icon="repeat"
            badge={musicPolicyLabel}
            code="MUSIC-01"
            title="Repetição de músicas"
            description="Evite faixas tocadas recentemente usando o histórico nativo do Spotify."
            action="Configurar repetição"
          />

          <ConfigCard
            href="/dashboard/configuracao/limpeza"
            icon="trash"
            badge={`${cleanupInboxCount} inbox`}
            code="MUSIC-02"
            title="Limpeza de fontes"
            description="Trate playlists de entrada como filas e remova somente músicas com reprodução confirmada."
            action="Configurar limpeza"
          />

          <ConfigCard
            href="/dashboard/configuracao/alimentacao"
            icon="plus"
            badge={`${ingestionRuleCount} ativas`}
            code="MUSIC-03"
            title="Alimentação da inbox"
            description="Traga novidades, músicas curtidas e álbuns para a Escutar sem depender de IFTTT."
            action="Configurar alimentação"
          />

          <ConfigCard
            href="/dashboard/configuracao/destinos"
            icon="list"
            badge={`${targetCount} ativas`}
            code="CONFIG-03"
            title="Destinos e regras"
            description="Escolha as playlists gerenciadas, duração, mistura, sequência e ordem de geração."
            action="Configurar destinos"
          />

          <ConfigCard
            href="/dashboard/configuracao/notificacoes"
            icon="bell"
            badge={`${notificationDeviceCount} dispositivos`}
            code="NOTIFY-01"
            title="Notificações"
            description="Receba no PWA o resultado das gerações, manutenções, limpezas e bloqueios."
            action="Configurar notificações"
          />

          {isPrelaunchAdmin(session.user.email) ? (
            <ConfigCard
              href="/dashboard/configuracao/prelaunch"
              icon="mail"
              badge="Acesso interno"
              code="PRELAUNCH-01"
              title="Lista de pré-lançamento"
              description="Consulte interessados e controle a passagem segura para a etapa de convite."
              action="Gerenciar interessados"
            />
          ) : null}

          <ConfigCard
            href="/dashboard/configuracao/revisao"
            icon="check"
            badge="Etapa final"
            code="CONFIG-04"
            title="Revisar e testar"
            description="Confira conexões e regras, corrija pendências e simule antes da geração real."
            action="Revisar configuração"
          />
        </div>
      </div>
    </main>
  );
}
