import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { RunControls } from "@/components/RunControls";
import { auth, signIn, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6">
      <path
        fill="#4285f4"
        d="M21.8 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.5a4.7 4.7 0 0 1-2 3.1v2.5h3.3c1.9-1.8 3-4.4 3-7.4Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 5-.9 6.8-2.4l-3.3-2.5c-.9.6-2.1 1-3.5 1-2.6 0-4.8-1.8-5.6-4.2H3v2.6A10.3 10.3 0 0 0 12 22Z"
      />
      <path
        fill="#fbbc05"
        d="M6.4 13.9a6.1 6.1 0 0 1 0-3.8V7.5H3a10.2 10.2 0 0 0 0 9l3.4-2.6Z"
      />
      <path
        fill="#ea4335"
        d="M12 5.9c1.5 0 2.8.5 3.9 1.5l2.9-2.8A9.8 9.8 0 0 0 3 7.5l3.4 2.6C7.2 7.7 9.4 5.9 12 5.9Z"
      />
    </svg>
  );
}

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 text-[#1ed760]">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="M6.6 9.3c3.7-1.1 8.2-.8 11.2.9M7.4 12.7c3.1-.8 6.9-.5 9.5.8M8.2 15.8c2.6-.6 5.4-.3 7.7.7"
        fill="none"
        stroke="#0d0616"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatRunDate(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const panelClass =
  "rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)] backdrop-blur-xl";

const innerCardClass =
  "rounded-2xl border border-violet-400/20 bg-violet-950/40 transition hover:border-violet-300/35 hover:bg-violet-900/35";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  async function connectGoogle() {
    "use server";

    const currentSession = await auth();
    if (!currentSession?.user?.id) redirect("/");

    const existingAccount = await prisma.account.findFirst({
      where: {
        userId: currentSession.user.id,
        provider: "google",
      },
      select: { id: true },
    });

    if (existingAccount) redirect("/dashboard");
    await signIn("google", { redirectTo: "/dashboard" });
  }

  async function connectSpotify() {
    "use server";

    const currentSession = await auth();
    if (!currentSession?.user?.id) redirect("/");

    const existingAccount = await prisma.account.findFirst({
      where: {
        userId: currentSession.user.id,
        provider: "spotify",
      },
      select: { id: true },
    });

    if (existingAccount) redirect("/dashboard");
    await signIn("spotify", { redirectTo: "/dashboard" });
  }

  async function logOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  const [targets, runs, connectedProviders] = await Promise.all([
    prisma.targetPlaylist.findMany({
      where: { userId: session.user.id },
      orderBy: { priority: "asc" },
    }),
    prisma.generationRun.findMany({
      where: { userId: session.user.id },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    prisma.account.findMany({
      where: { userId: session.user.id },
      select: { provider: true },
    }),
  ]);

  const providers = new Set(connectedProviders.map((account) => account.provider));
  const hasGoogle = providers.has("google");
  const hasSpotify = providers.has("spotify");
  const connectionCount = Number(hasGoogle) + Number(hasSpotify);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] pb-12 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_4%,rgba(126,34,206,0.28),transparent_31rem),radial-gradient(circle_at_88%_16%,rgba(255,107,0,0.14),transparent_26rem),linear-gradient(180deg,#12032f_0%,#0b021f_52%,#090119_100%)]" />
      <div className="pointer-events-none absolute left-1/2 top-20 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-violet-600/10 blur-3xl" />

      <header className="relative z-10 border-b border-violet-300/15 bg-[#10032a]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
          <BrandLogo compact variant="light" />

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold text-white">
                {session.user.name ?? "Minha conta"}
              </p>
              <p className="text-xs text-violet-200/70">{session.user.email}</p>
            </div>
            <form action={logOut}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-2xl border border-violet-300/30 bg-violet-950/35 px-4 py-2 text-sm font-bold text-violet-100 transition hover:border-violet-200/60 hover:bg-violet-900/55 hover:text-white"
              >
                <span aria-hidden="true">↪</span>
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-7xl space-y-5 px-5 py-6 sm:space-y-6 sm:px-8 lg:px-10 lg:py-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-violet-300/25 bg-[linear-gradient(120deg,#1d0758_0%,#34108a_42%,#7928e8_76%,#a02cf2_100%)] p-6 shadow-[0_28px_90px_-42px_rgba(124,58,237,0.95)] sm:p-8 lg:p-9">
          <div className="pointer-events-none absolute -right-14 -top-24 h-72 w-72 rounded-full border-[42px] border-white/10" />
          <div className="pointer-events-none absolute -bottom-32 right-20 h-72 w-72 rounded-full bg-orange-500/30 blur-3xl" />
          <div className="pointer-events-none absolute right-10 top-8 hidden h-48 w-48 rounded-full bg-violet-300/10 blur-2xl lg:block" />

          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-black uppercase tracking-[0.16em] text-orange-300 backdrop-blur-sm">
                <span aria-hidden="true">♫</span>
                Seu painel musical
              </span>

              <h1 className="mt-5 text-3xl font-black leading-tight tracking-[-0.04em] sm:text-4xl lg:text-5xl">
                Sua agenda e suas playlists,
                <span className="block text-orange-400">em sintonia.</span>
              </h1>

              <p className="mt-4 max-w-xl text-sm leading-6 text-violet-100/80 sm:text-base">
                Gere, simule e acompanhe as playlists criadas para o seu tempo disponível.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-center backdrop-blur-md">
                <p className="text-2xl font-black sm:text-3xl">{connectionCount}/2</p>
                <p className="mt-1 text-xs text-violet-100/75">conexões</p>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-center backdrop-blur-md">
                <p className="text-2xl font-black sm:text-3xl">{targets.length}</p>
                <p className="mt-1 text-xs text-violet-100/75">playlists</p>
              </div>
              <div className="col-span-2 rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-center backdrop-blur-md sm:col-span-1">
                <p className="text-2xl font-black sm:text-3xl">{runs.length}</p>
                <p className="mt-1 text-xs text-violet-100/75">execuções recentes</p>
              </div>
            </div>
          </div>
        </section>

        <section className={`${panelClass} p-5 sm:p-6`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
                Integrações
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-white">
                Conexões da conta
              </h2>
              <p className="mt-1 text-sm text-violet-200/70">
                Com os dois provedores vinculados, você pode entrar com qualquer um deles.
              </p>
            </div>
            <span
              className={`w-fit rounded-full border px-3 py-1.5 text-xs font-bold ${
                connectionCount === 2
                  ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                  : "border-orange-400/25 bg-orange-400/10 text-orange-300"
              }`}
            >
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-current" />
              {connectionCount === 2 ? "Tudo conectado" : "Conexão pendente"}
            </span>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <article className={`${innerCardClass} flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center`}>
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-lg shadow-violet-950/30">
                  <GoogleIcon />
                </span>
                <div>
                  <h3 className="font-black text-white">Google Agenda</h3>
                  <p className={hasGoogle ? "text-sm font-semibold text-emerald-300" : "text-sm text-violet-200/65"}>
                    {hasGoogle ? "Conectado ✓" : "Ainda não conectado"}
                  </p>
                </div>
              </div>
              {!hasGoogle && (
                <form action={connectGoogle}>
                  <button
                    type="submit"
                    className="w-full rounded-xl border border-violet-400/40 bg-violet-900/45 px-4 py-2 text-sm font-bold text-violet-100 transition hover:bg-violet-800/60 sm:w-auto"
                  >
                    Conectar Google
                  </button>
                </form>
              )}
            </article>

            <article className={`${innerCardClass} flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center`}>
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#181016] shadow-lg shadow-violet-950/40">
                  <SpotifyIcon />
                </span>
                <div>
                  <h3 className="font-black text-white">Spotify</h3>
                  <p className={hasSpotify ? "text-sm font-semibold text-emerald-300" : "text-sm text-violet-200/65"}>
                    {hasSpotify ? "Conectado ✓" : "Ainda não conectado"}
                  </p>
                </div>
              </div>
              {!hasSpotify && (
                <form action={connectSpotify}>
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-4 py-2 text-sm font-black text-white transition hover:brightness-110 sm:w-auto"
                  >
                    Conectar Spotify
                  </button>
                </form>
              )}
            </article>
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <section className={`${panelClass} p-5 sm:p-6`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-400">
                  Geração
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-white">
                  Atualize suas playlists
                </h2>
                <p className="mt-1 text-sm leading-6 text-violet-200/70">
                  Execute a geração real ou simule o resultado antes de aplicar mudanças no Spotify.
                </p>
              </div>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-orange-400/20 bg-orange-400/10 text-xl text-orange-300">
                ♪
              </span>
            </div>

            <div className="mt-6 rounded-2xl border border-violet-400/20 bg-violet-950/35 p-4 sm:p-5">
              <RunControls />
            </div>
          </section>

          <section className={`${panelClass} p-5 sm:p-6`}>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
              Destinos
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-white">
              Playlists configuradas
            </h2>

            {targets.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-violet-400/30 bg-violet-950/30 p-6 text-center">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-xl text-white shadow-lg shadow-violet-900/50">
                  +
                </div>
                <p className="mt-3 font-bold text-white">Nenhuma playlist ainda</p>
                <p className="mt-1 text-sm leading-6 text-violet-200/65">
                  A configuração pela interface será a próxima etapa funcional do MVP.
                </p>
              </div>
            ) : (
              <ul className="mt-5 space-y-3">
                {targets.map((target) => (
                  <li key={target.id} className={`${innerCardClass} p-4`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-white">{target.name}</p>
                        <p className="mt-1 text-sm text-violet-200/65">
                          {target.durationMode} · {target.podcastPercent}% podcasts
                        </p>
                      </div>
                      <span className="rounded-full border border-violet-400/20 bg-violet-400/10 px-2.5 py-1 text-xs font-bold text-violet-200">
                        #{target.priority}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className={`${panelClass} p-5 sm:p-6`}>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
              Histórico
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-white">
              Execuções recentes
            </h2>
          </div>

          {runs.length === 0 ? (
            <div className="mt-5 flex flex-col items-center justify-center rounded-2xl border border-violet-400/20 bg-violet-950/30 px-5 py-8 text-center sm:flex-row sm:gap-4 sm:text-left">
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-violet-300/20 bg-violet-500/20 text-violet-200">
                ◷
              </span>
              <div className="mt-3 sm:mt-0">
                <p className="font-bold text-white">Nenhuma execução registrada</p>
                <p className="mt-1 text-sm text-violet-200/65">
                  Sua primeira geração aparecerá aqui.
                </p>
              </div>
            </div>
          ) : (
            <ul className="mt-5 divide-y divide-violet-400/15 overflow-hidden rounded-2xl border border-violet-400/20 bg-violet-950/30">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-10 w-10 items-center justify-center rounded-2xl text-sm font-black ${
                        run.status === "SUCCESS"
                          ? "bg-emerald-400/15 text-emerald-300"
                          : "bg-orange-400/15 text-orange-300"
                      }`}
                    >
                      {run.simulation ? "S" : "G"}
                    </span>
                    <div>
                      <p className="font-bold text-white">
                        {run.simulation ? "Simulação" : "Geração"} · {run.trigger}
                      </p>
                      <p className="text-sm text-violet-200/60">{formatRunDate(run.startedAt)}</p>
                    </div>
                  </div>
                  <span className="w-fit rounded-full border border-violet-400/20 bg-violet-900/35 px-3 py-1.5 text-xs font-bold text-violet-200">
                    {run.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
