import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function ConfigurationHubPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const [calendarCount, sourceCount, targetCount] = await Promise.all([
    prisma.calendarSelection.count({
      where: { userId: session.user.id, selected: true },
    }),
    prisma.sourcePlaylist.count({
      where: { userId: session.user.id, enabled: true },
    }),
    prisma.targetPlaylist.count({
      where: { userId: session.user.id, enabled: true },
    }),
  ]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />

      <div className="relative mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white"
        >
          <span aria-hidden="true">←</span>
          Voltar ao painel
        </Link>

        <div className="mt-7 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-orange-400">
            Configuração
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
            Prepare o Sonoriza para o seu dia.
          </h1>
          <p className="mt-3 text-sm leading-6 text-violet-200/75 sm:text-base">
            Escolha de onde o conteúdo vem, quais eventos entram no cálculo de tempo e como cada playlist de destino deve ser montada.
          </p>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Link
            href="/dashboard/configuracao/calendarios"
            className="group rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-6 shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)] transition hover:-translate-y-0.5 hover:border-violet-300/40"
          >
            <div className="flex items-start justify-between gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-300/20 bg-violet-500/15 text-xl text-violet-100">
                ◷
              </span>
              <span className="rounded-full border border-violet-300/20 bg-violet-500/10 px-3 py-1.5 text-xs font-black text-violet-200">
                {calendarCount} ativos
              </span>
            </div>
            <p className="mt-5 text-xs font-black uppercase tracking-[0.15em] text-violet-400">
              CONFIG-01
            </p>
            <h2 className="mt-1 text-xl font-black">Calendários do Google</h2>
            <p className="mt-2 text-sm leading-6 text-violet-200/70">
              Defina os calendários consultados e quais eventos representam viagens.
            </p>
            <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-orange-300 transition group-hover:gap-3">
              Configurar calendários <span aria-hidden="true">→</span>
            </span>
          </Link>

          <Link
            href="/dashboard/configuracao/fontes"
            className="group rounded-[1.75rem] border border-orange-400/25 bg-[linear-gradient(145deg,rgba(62,17,116,0.96),rgba(30,8,66,0.96))] p-6 shadow-[0_24px_70px_-40px_rgba(255,107,0,0.55)] transition hover:-translate-y-0.5 hover:border-orange-300/45"
          >
            <div className="flex items-start justify-between gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-orange-300/20 bg-orange-400/10 text-xl text-orange-200">
                ♪
              </span>
              <span className="rounded-full border border-orange-300/20 bg-orange-400/10 px-3 py-1.5 text-xs font-black text-orange-200">
                {sourceCount} ativas
              </span>
            </div>
            <p className="mt-5 text-xs font-black uppercase tracking-[0.15em] text-orange-400">
              CONFIG-02
            </p>
            <h2 className="mt-1 text-xl font-black">Fontes do Spotify</h2>
            <p className="mt-2 text-sm leading-6 text-violet-200/70">
              Escolha playlists de músicas e programas de podcast que alimentam o motor.
            </p>
            <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-orange-300 transition group-hover:gap-3">
              Configurar fontes <span aria-hidden="true">→</span>
            </span>
          </Link>

          <Link
            href="/dashboard/configuracao/destinos"
            className="group rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-6 shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)] transition hover:-translate-y-0.5 hover:border-violet-300/40"
          >
            <div className="flex items-start justify-between gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-300/20 bg-violet-500/15 text-xl text-violet-100">
                ▤
              </span>
              <span className="rounded-full border border-violet-300/20 bg-violet-500/10 px-3 py-1.5 text-xs font-black text-violet-200">
                {targetCount} ativas
              </span>
            </div>
            <p className="mt-5 text-xs font-black uppercase tracking-[0.15em] text-violet-400">
              CONFIG-03
            </p>
            <h2 className="mt-1 text-xl font-black">Destinos e regras</h2>
            <p className="mt-2 text-sm leading-6 text-violet-200/70">
              Escolha as playlists gerenciadas, duração, mistura, sequência e ordem de geração.
            </p>
            <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-orange-300 transition group-hover:gap-3">
              Configurar destinos <span aria-hidden="true">→</span>
            </span>
          </Link>
        </div>
      </div>
    </main>
  );
}
