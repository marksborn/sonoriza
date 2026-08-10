import { MusicRepeatWindowUnit } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
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

  const inputClass =
    "mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-4 py-3 text-ink-inverse outline-none transition focus:border-accent-400/70 focus:ring-2 focus:ring-accent/15";

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

        <div className="mt-7">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">MUSIC-01</p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Evitar músicas repetidas
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Use o histórico nativo do Spotify para deixar fora do planejamento as faixas tocadas dentro do período escolhido.
          </p>
        </div>

        {params.saved === "1" ? (
          <div className="status-success mt-6 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} />
            Política salva. Nenhuma playlist foi gerada ou alterada.
          </div>
        ) : null}
        {params.error === "invalid" ? (
          <div className="status-warning mt-6 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="warning" size={17} />
            Informe um período inteiro maior que zero e escolha dias, meses ou anos.
          </div>
        ) : null}

        <section className="product-panel mt-7 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Spotify</p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">Histórico de reprodução</h2>
              <p className="mt-2 text-sm leading-6 text-muted-inverse">
                O Sonoriza consulta apenas o histórico de músicas tocadas; não modifica playlists de origem.
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${
                hasRecentlyPlayedScope ? "status-success" : "status-warning"
              }`}
            >
              <UiIcon name={hasRecentlyPlayedScope ? "check" : "warning"} size={15} />
              {hasRecentlyPlayedScope ? "Permissão disponível" : "Reconexão necessária"}
            </span>
          </div>

          {!hasRecentlyPlayedScope ? (
            <div className="status-warning mt-5 rounded-2xl border p-4">
              <p className="text-sm leading-6">
                Para ativar esta regra, reconecte o Spotify e autorize a leitura de músicas tocadas recentemente.
              </p>
              <form action={reconnectSpotify} className="mt-3">
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-xl border border-warning/35 bg-warning/10 px-4 py-2.5 text-sm font-black transition hover:bg-warning/15"
                >
                  <UiIcon name="repeat" size={17} />
                  Reconectar Spotify
                </button>
              </form>
            </div>
          ) : null}

          <dl className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="product-card p-4">
              <dt className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">Faixas conhecidas</dt>
              <dd className="mt-2 text-lg font-black text-ink-inverse">{trackedCount}</dd>
            </div>
            <div className="product-card p-4">
              <dt className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">Histórico conhecido desde</dt>
              <dd className="mt-2 text-sm font-bold text-ink-inverse">{formatDate(policy?.historyKnownSince ?? null)}</dd>
            </div>
            <div className="product-card p-4">
              <dt className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">Última sincronização</dt>
              <dd className="mt-2 text-sm font-bold text-ink-inverse">{formatDate(policy?.lastSyncAt ?? null)}</dd>
            </div>
          </dl>
        </section>

        <form action={savePolicy} className="product-panel mt-5 p-6">
          <label className="flex items-start gap-3">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={enabled}
              className="mt-1 h-5 w-5 accent-accent"
            />
            <span>
              <span className="block font-black text-ink-inverse">Evitar músicas tocadas recentemente</span>
              <span className="mt-1 block text-sm leading-6 text-muted-inverse">
                Quando ativa, a regra vale globalmente para todas as fontes e destinos de música.
              </span>
            </span>
          </label>

          <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <label className="text-sm font-bold text-ink-inverse">
              Período
              <input
                name="windowValue"
                type="number"
                min={1}
                step={1}
                defaultValue={windowValue}
                required
                className={inputClass}
              />
            </label>
            <label className="text-sm font-bold text-ink-inverse">
              Unidade
              <select name="windowUnit" defaultValue={windowUnit} className={inputClass}>
                <option value={MusicRepeatWindowUnit.DAYS}>Dias</option>
                <option value={MusicRepeatWindowUnit.MONTHS}>Meses</option>
                <option value={MusicRepeatWindowUnit.YEARS}>Anos</option>
              </select>
            </label>
          </div>

          <p className="mt-4 text-xs leading-5 text-muted-inverse/70">
            Meses e anos seguem calendário real. Ex.: 31 de março menos 1 mês resulta no último dia válido de fevereiro.
          </p>

          <button
            type="submit"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400"
          >
            <UiIcon name="check" size={18} />
            Salvar regra de repetição
          </button>
        </form>
      </div>
    </main>
  );
}
