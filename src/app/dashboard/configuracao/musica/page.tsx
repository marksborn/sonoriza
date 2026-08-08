import { MusicRepeatWindowUnit } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { RECENTLY_PLAYED_SCOPE, scopeIncludes } from "@/services/spotify/recently-played";

function revalidateConfiguration() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/configuracao");
  revalidatePath("/dashboard/configuracao/musica");
  revalidatePath("/dashboard/configuracao/revisao");
}

async function savePolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const enabled = formData.get("enabled") === "on";
  const valueRaw = Number(String(formData.get("windowValue") ?? ""));
  const unitRaw = String(formData.get("windowUnit") ?? "");
  const windowValue = Number.isInteger(valueRaw) && valueRaw > 0 ? valueRaw : null;
  const windowUnit =
    unitRaw === MusicRepeatWindowUnit.DAYS
      ? MusicRepeatWindowUnit.DAYS
      : unitRaw === MusicRepeatWindowUnit.MONTHS
        ? MusicRepeatWindowUnit.MONTHS
        : unitRaw === MusicRepeatWindowUnit.YEARS
          ? MusicRepeatWindowUnit.YEARS
          : null;

  if (!windowValue || !windowUnit) {
    redirect("/dashboard/configuracao/musica?error=invalid");
  }

  await prisma.musicPlaybackPolicy.upsert({
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
      enabled,
      windowValue,
      windowUnit,
    },
    update: {
      enabled,
      windowValue,
      windowUnit,
    },
  });

  revalidateConfiguration();
  redirect("/dashboard/configuracao/musica?saved=1");
}

async function reconnectSpotify() {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  await signIn("spotify", { redirectTo: "/dashboard/configuracao/musica" });
}

function formatDate(date: Date | null): string {
  if (!date) return "Ainda não conhecido";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

export default async function MusicRepeatConfigurationPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const params = await searchParams;

  const [policy, spotifyAccount, trackedCount] = await Promise.all([
    prisma.musicPlaybackPolicy.findUnique({
      where: { userId: session.user.id },
    }),
    prisma.account.findFirst({
      where: { userId: session.user.id, provider: "spotify" },
      select: { scope: true },
    }),
    prisma.trackListeningState.count({ where: { userId: session.user.id } }),
  ]);

  const hasRecentlyPlayedScope = scopeIncludes(
    spotifyAccount?.scope,
    RECENTLY_PLAYED_SCOPE,
  );
  const enabled = policy?.enabled ?? false;
  const windowValue = policy?.windowValue ?? 30;
  const windowUnit = policy?.windowUnit ?? MusicRepeatWindowUnit.DAYS;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />

      <div className="relative mx-auto max-w-3xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white"
        >
          <span aria-hidden="true">←</span>
          Central de configuração
        </Link>

        <div className="mt-7">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-orange-400">
            MUSIC-01
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
            Evitar músicas repetidas
          </h1>
          <p className="mt-3 text-sm leading-6 text-violet-200/75 sm:text-base">
            Use o histórico nativo do Spotify para deixar fora do planejamento as faixas tocadas dentro do período escolhido.
          </p>
        </div>

        {params.saved === "1" ? (
          <div className="mt-6 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm font-bold text-emerald-200">
            Política salva. Nenhuma playlist foi gerada ou alterada.
          </div>
        ) : null}
        {params.error === "invalid" ? (
          <div className="mt-6 rounded-2xl border border-orange-400/30 bg-orange-500/10 px-4 py-3 text-sm font-bold text-orange-200">
            Informe um período inteiro maior que zero e escolha dias, meses ou anos.
          </div>
        ) : null}

        <section className="mt-7 rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.94),rgba(22,6,53,0.96))] p-6 shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
                Spotify
              </p>
              <h2 className="mt-1 text-xl font-black">Histórico de reprodução</h2>
              <p className="mt-2 text-sm leading-6 text-violet-200/70">
                O Sonoriza consulta apenas o histórico de músicas tocadas; não modifica playlists de origem.
              </p>
            </div>
            <span
              className={`rounded-full border px-3 py-1.5 text-xs font-black ${
                hasRecentlyPlayedScope
                  ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                  : "border-orange-400/30 bg-orange-500/10 text-orange-200"
              }`}
            >
              {hasRecentlyPlayedScope ? "Permissão disponível ✓" : "Reconexão necessária"}
            </span>
          </div>

          {!hasRecentlyPlayedScope ? (
            <div className="mt-5 rounded-2xl border border-orange-400/25 bg-orange-500/10 p-4">
              <p className="text-sm leading-6 text-orange-100/90">
                Para ativar esta regra, reconecte o Spotify e autorize a leitura de músicas tocadas recentemente.
              </p>
              <form action={reconnectSpotify} className="mt-3">
                <button
                  type="submit"
                  className="rounded-xl border border-orange-300/30 bg-orange-400/15 px-4 py-2.5 text-sm font-black text-orange-100 transition hover:bg-orange-400/25"
                >
                  Reconectar Spotify
                </button>
              </form>
            </div>
          ) : null}

          <dl className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
              <dt className="text-xs font-black uppercase tracking-[0.12em] text-violet-400">Faixas conhecidas</dt>
              <dd className="mt-2 text-lg font-black">{trackedCount}</dd>
            </div>
            <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
              <dt className="text-xs font-black uppercase tracking-[0.12em] text-violet-400">Histórico conhecido desde</dt>
              <dd className="mt-2 text-sm font-bold text-violet-100">{formatDate(policy?.historyKnownSince ?? null)}</dd>
            </div>
            <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
              <dt className="text-xs font-black uppercase tracking-[0.12em] text-violet-400">Última sincronização</dt>
              <dd className="mt-2 text-sm font-bold text-violet-100">{formatDate(policy?.lastSyncAt ?? null)}</dd>
            </div>
          </dl>
        </section>

        <form
          action={savePolicy}
          className="mt-5 rounded-[1.75rem] border border-orange-400/20 bg-[linear-gradient(145deg,rgba(62,17,116,0.96),rgba(30,8,66,0.96))] p-6"
        >
          <label className="flex items-start gap-3">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={enabled}
              className="mt-1 h-5 w-5 accent-orange-500"
            />
            <span>
              <span className="block font-black">Evitar músicas tocadas recentemente</span>
              <span className="mt-1 block text-sm leading-6 text-violet-200/70">
                Quando ativa, a regra vale globalmente para todas as fontes e destinos de música.
              </span>
            </span>
          </label>

          <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <label className="text-sm font-bold text-violet-100">
              Período
              <input
                name="windowValue"
                type="number"
                min={1}
                step={1}
                defaultValue={windowValue}
                required
                className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white outline-none transition focus:border-orange-300/50"
              />
            </label>
            <label className="text-sm font-bold text-violet-100">
              Unidade
              <select
                name="windowUnit"
                defaultValue={windowUnit}
                className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white outline-none transition focus:border-orange-300/50"
              >
                <option value={MusicRepeatWindowUnit.DAYS}>Dias</option>
                <option value={MusicRepeatWindowUnit.MONTHS}>Meses</option>
                <option value={MusicRepeatWindowUnit.YEARS}>Anos</option>
              </select>
            </label>
          </div>

          <p className="mt-4 text-xs leading-5 text-violet-300/70">
            Meses e anos seguem calendário real. Ex.: 31 de março menos 1 mês resulta no último dia válido de fevereiro.
          </p>

          <button
            type="submit"
            className="mt-6 rounded-xl bg-orange-500 px-5 py-3 text-sm font-black text-white shadow-lg shadow-orange-950/30 transition hover:bg-orange-400"
          >
            Salvar regra de repetição
          </button>
        </form>
      </div>
    </main>
  );
}
