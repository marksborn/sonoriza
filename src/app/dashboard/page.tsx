import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { RunControls } from "@/components/RunControls";
import { auth, signIn, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        fill="#4285f4"
        d="M21.8 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.5a4.7 4.7 0 0 1-2 3.1v2.5h3.3c1.9-1.8 3-4.4 3-7.4Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 5-.9 6.8-2.4l-3.3-2.5c-.9.6-2.1 1-3.5 1-2.6 0-4.8-1.8-5.6-4.2H3v2.6A10.3 10.3 0 0 0 12 22Z"
      />
      <path fill="#fbbc05" d="M6.4 13.9a6.1 6.1 0 0 1 0-3.8V7.5H3a10.2 10.2 0 0 0 0 9l3.4-2.6Z" />
      <path
        fill="#ea4335"
        d="M12 5.9c1.5 0 2.8.5 3.9 1.5l2.9-2.8A9.8 9.8 0 0 0 3 7.5l3.4 2.6C7.2 7.7 9.4 5.9 12 5.9Z"
      />
    </svg>
  );
}

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 text-[#1ed760]">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="M6.6 9.3c3.7-1.1 8.2-.8 11.2.9M7.4 12.7c3.1-.8 6.9-.5 9.5.8M8.2 15.8c2.6-.6 5.4-.3 7.7.7"
        fill="none"
        stroke="#271746"
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
    <main className="min-h-screen pb-12">
      <header className="border-b border-white/80 bg-white/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
          <BrandLogo compact />

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold text-ink">
                {session.user.name ?? "Minha conta"}
              </p>
              <p className="text-xs text-muted">{session.user.email}</p>
            </div>
            <form action={logOut}>
              <button type="submit" className="secondary-button px-4 py-2 text-sm">
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-7 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <section className="relative overflow-hidden rounded-[2rem] bg-brand-gradient p-6 text-white shadow-soft sm:p-8">
          <div className="pointer-events-none absolute -right-12 -top-16 h-52 w-52 rounded-full border-[34px] border-white/10" />
          <div className="pointer-events-none absolute -bottom-24 right-28 h-48 w-48 rounded-full bg-accent/25 blur-3xl" />

          <div className="relative flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-white/80">
                <span className="h-2 w-2 rounded-full bg-accent-light" />
                Seu painel musical
              </span>
              <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
                Sua agenda e suas playlists, em sintonia.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/72 sm:text-base">
                Gere, simule e acompanhe as playlists criadas para o seu tempo disponível.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:flex">
              <div className="rounded-2xl bg-white/10 px-4 py-3 backdrop-blur-sm">
                <p className="text-2xl font-black">{connectionCount}/2</p>
                <p className="text-xs text-white/65">conexões</p>
              </div>
              <div className="rounded-2xl bg-white/10 px-4 py-3 backdrop-blur-sm">
                <p className="text-2xl font-black">{targets.length}</p>
                <p className="text-xs text-white/65">playlists</p>
              </div>
              <div className="col-span-2 rounded-2xl bg-white/10 px-4 py-3 backdrop-blur-sm sm:col-auto">
                <p className="text-2xl font-black">{runs.length}</p>
                <p className="text-xs text-white/65">execuções recentes</p>
              </div>
            </div>
          </div>
        </section>

        <section className="section-card">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand">
                Integrações
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-brand-dark">
                Conexões da conta
              </h2>
              <p className="mt-1 text-sm text-muted">
                Com os dois provedores vinculados, você pode entrar com qualquer um deles.
              </p>
            </div>
            <span
              className={`w-fit rounded-full px-3 py-1.5 text-xs font-bold ${
                connectionCount === 2
                  ? "bg-brand-soft text-brand"
                  : "bg-accent-soft text-accent"
              }`}
            >
              {connectionCount === 2 ? "Tudo conectado" : "Conexão pendente"}
            </span>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <article className="flex flex-col justify-between gap-5 rounded-3xl border border-line bg-canvas/70 p-5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm">
                  <GoogleIcon />
                </span>
                <div>
                  <h3 className="font-black text-ink">Google Agenda</h3>
                  <p className={hasGoogle ? "text-sm font-semibold text-brand" : "text-sm text-muted"}>
                    {hasGoogle ? "Conectado ✓" : "Ainda não conectado"}
                  </p>
                </div>
              </div>
              {!hasGoogle && (
                <form action={connectGoogle}>
                  <button type="submit" className="secondary-button w-full px-4 py-2 text-sm sm:w-auto">
                    Conectar Google
                  </button>
                </form>
              )}
            </article>

            <article className="flex flex-col justify-between gap-5 rounded-3xl border border-line bg-canvas/70 p-5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#191414] shadow-sm">
                  <SpotifyIcon />
                </span>
                <div>
                  <h3 className="font-black text-ink">Spotify</h3>
                  <p className={hasSpotify ? "text-sm font-semibold text-brand" : "text-sm text-muted"}>
                    {hasSpotify ? "Conectado ✓" : "Ainda não conectado"}
                  </p>
                </div>
              </div>
              {!hasSpotify && (
                <form action={connectSpotify}>
                  <button type="submit" className="primary-button w-full px-4 py-2 text-sm sm:w-auto">
                    Conectar Spotify
                  </button>
                </form>
              )}
            </article>
          </div>
        </section>

        <div className="grid gap-7 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="section-card">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent">
                  Geração
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-brand-dark">
                  Atualize suas playlists
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Execute a geração real ou simule o resultado antes de aplicar mudanças no Spotify.
                </p>
              </div>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-xl text-accent">
                ♪
              </span>
            </div>

            <div className="mt-6 rounded-3xl border border-line bg-canvas/70 p-4 sm:p-5">
              <RunControls />
            </div>
          </section>

          <section className="section-card">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand">
              Destinos
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-brand-dark">
              Playlists configuradas
            </h2>

            {targets.length === 0 ? (
              <div className="mt-5 rounded-3xl border border-dashed border-brand/20 bg-brand-soft/45 p-5 text-center">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-xl text-brand shadow-sm">
                  +
                </div>
                <p className="mt-3 font-bold text-ink">Nenhuma playlist ainda</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  A configuração pela interface será a próxima etapa funcional do MVP.
                </p>
              </div>
            ) : (
              <ul className="mt-5 space-y-3">
                {targets.map((target) => (
                  <li key={target.id} className="rounded-2xl border border-line bg-canvas/70 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-ink">{target.name}</p>
                        <p className="mt-1 text-sm text-muted">
                          {target.durationMode} · {target.podcastPercent}% podcasts
                        </p>
                      </div>
                      <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-bold text-brand">
                        #{target.priority}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="section-card">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand">
              Histórico
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-brand-dark">
              Execuções recentes
            </h2>
          </div>

          {runs.length === 0 ? (
            <div className="mt-5 rounded-3xl border border-dashed border-line bg-canvas/70 px-5 py-8 text-center">
              <p className="font-bold text-ink">Nenhuma execução registrada</p>
              <p className="mt-1 text-sm text-muted">
                Sua primeira geração aparecerá aqui.
              </p>
            </div>
          ) : (
            <ul className="mt-5 divide-y divide-line overflow-hidden rounded-3xl border border-line bg-white">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-10 w-10 items-center justify-center rounded-2xl text-sm font-black ${
                        run.status === "SUCCESS"
                          ? "bg-brand-soft text-brand"
                          : "bg-accent-soft text-accent"
                      }`}
                    >
                      {run.simulation ? "S" : "G"}
                    </span>
                    <div>
                      <p className="font-bold text-ink">
                        {run.simulation ? "Simulação" : "Geração"} · {run.trigger}
                      </p>
                      <p className="text-sm text-muted">{formatRunDate(run.startedAt)}</p>
                    </div>
                  </div>
                  <span className="w-fit rounded-full bg-canvas px-3 py-1.5 text-xs font-bold text-muted">
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
