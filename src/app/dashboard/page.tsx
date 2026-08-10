import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { RunControls } from "@/components/RunControls";
import { UiIcon } from "@/components/UiIcon";
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

const panelClass = "product-panel";
const innerCardClass = "product-card";

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
    <main className="product-shell pb-12">
      <div className="product-ambient" />
      <div className="pointer-events-none absolute left-1/2 top-20 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />

      <header className="relative z-10 border-b border-line-dark/50 bg-surface-dark/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
          <BrandLogo compact variant="light" />

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold text-ink-inverse">
                {session.user.name ?? "Minha conta"}
              </p>
              <p className="text-xs text-muted-inverse">{session.user.email}</p>
            </div>
            <form action={logOut}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-2xl border border-line-dark/70 bg-surface-subtle/70 px-4 py-2 text-sm font-bold text-muted-inverse transition hover:border-brand-400/50 hover:bg-surface-elevated hover:text-ink-inverse"
              >
                <UiIcon name="logout" size={18} />
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-7xl space-y-5 px-5 py-6 sm:space-y-6 sm:px-8 lg:px-10 lg:py-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-brand-400/30 bg-brand-gradient p-6 shadow-product-card sm:p-8 lg:p-9">
          <div className="pointer-events-none absolute -right-14 -top-24 h-72 w-72 rounded-full border-[42px] border-white/10" />
          <div className="pointer-events-none absolute -bottom-32 right-20 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
          <div className="pointer-events-none absolute right-10 top-8 hidden h-48 w-48 rounded-full bg-brand-400/15 blur-2xl lg:block" />

          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-black uppercase tracking-[0.16em] text-accent-400 backdrop-blur-sm">
                <UiIcon name="music" size={16} />
                Seu painel musical
              </span>

              <h1 className="mt-5 text-3xl font-black leading-tight tracking-[-0.04em] text-ink-inverse sm:text-4xl lg:text-5xl">
                Sua agenda e suas playlists,
                <span className="block text-accent-400">em sintonia.</span>
              </h1>

              <p className="mt-4 max-w-xl text-sm leading-6 text-white/80 sm:text-base">
                Gere, simule e acompanhe as playlists criadas para o seu tempo disponível.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-center backdrop-blur-md">
                <p className="text-2xl font-black sm:text-3xl">{connectionCount}/2</p>
                <p className="mt-1 text-xs text-white/75">conexões</p>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-center backdrop-blur-md">
                <p className="text-2xl font-black sm:text-3xl">{targets.length}</p>
                <p className="mt-1 text-xs text-white/75">playlists</p>
              </div>
              <div className="col-span-2 rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-center backdrop-blur-md sm:col-span-1">
                <p className="text-2xl font-black sm:text-3xl">{runs.length}</p>
                <p className="mt-1 text-xs text-white/75">execuções recentes</p>
              </div>
            </div>
          </div>
        </section>

        <section className={`${panelClass} p-5 sm:p-6`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Integrações
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
                Conexões da conta
              </h2>
              <p className="mt-1 text-sm text-muted-inverse">
                Com os dois provedores vinculados, você pode entrar com qualquer um deles.
              </p>
            </div>
            <span
              className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${
                connectionCount === 2 ? "status-success" : "status-warning"
              }`}
            >
              {connectionCount === 2 ? <UiIcon name="check" size={15} /> : <UiIcon name="warning" size={15} />}
              {connectionCount === 2 ? "Tudo conectado" : "Conexão pendente"}
            </span>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <article className={`${innerCardClass} flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center`}>
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-lg">
                  <GoogleIcon />
                </span>
                <div>
                  <h3 className="font-black text-ink-inverse">Google Agenda</h3>
                  <p className={hasGoogle ? "mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-success" : "mt-1 text-sm text-muted-inverse"}>
                    {hasGoogle ? (
                      <>
                        <UiIcon name="check" size={15} />
                        Conectado
                      </>
                    ) : (
                      "Ainda não conectado"
                    )}
                  </p>
                </div>
              </div>
              {!hasGoogle && (
                <form action={connectGoogle}>
                  <button
                    type="submit"
                    className="w-full rounded-xl border border-brand-400/40 bg-surface-elevated/70 px-4 py-2 text-sm font-bold text-ink-inverse transition hover:border-brand-400/70 hover:bg-surface-elevated sm:w-auto"
                  >
                    Conectar Google
                  </button>
                </form>
              )}
            </article>

            <article className={`${innerCardClass} flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center`}>
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-black/55 shadow-lg">
                  <SpotifyIcon />
                </span>
                <div>
                  <h3 className="font-black text-ink-inverse">Spotify</h3>
                  <p className={hasSpotify ? "mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-success" : "mt-1 text-sm text-muted-inverse"}>
                    {hasSpotify ? (
                      <>
                        <UiIcon name="check" size={15} />
                        Conectado
                      </>
                    ) : (
                      "Ainda não conectado"
                    )}
                  </p>
                </div>
              </div>
              {!hasSpotify && (
                <form action={connectSpotify}>
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400 sm:w-auto"
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
                <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                  Geração
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
                  Atualize suas playlists
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  Execute a geração real ou simule o resultado antes de aplicar mudanças no Spotify.
                </p>
              </div>
              <span className="product-icon-tile-accent h-11 w-11">
                <UiIcon name="music" size={21} />
              </span>
            </div>

            <div className="mt-6 rounded-2xl border border-line-dark/55 bg-surface-subtle/65 p-4 sm:p-5">
              <RunControls />
            </div>
          </section>

          <section className={`${panelClass} p-5 sm:p-6`}>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Destinos
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Playlists configuradas
            </h2>

            {targets.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-line-dark bg-surface-subtle/60 p-6 text-center">
                <div className="product-icon-tile mx-auto h-11 w-11">
                  <UiIcon name="plus" size={21} />
                </div>
                <p className="mt-3 font-bold text-ink-inverse">Nenhuma playlist ainda</p>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  A configuração pela interface será a próxima etapa funcional do MVP.
                </p>
              </div>
            ) : (
              <ul className="mt-5 space-y-3">
                {targets.map((target) => (
                  <li key={target.id} className={`${innerCardClass} p-4`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-ink-inverse">{target.name}</p>
                        <p className="mt-1 text-sm text-muted-inverse">
                          {target.durationMode} · {target.podcastPercent}% podcasts
                        </p>
                      </div>
                      <span className="product-badge px-2.5 py-1">#{target.priority}</span>
                    </div>
                    <a
                      href={`/dashboard/playlists/${target.id}`}
                      className="mt-4 inline-flex items-center gap-2 rounded-xl border border-brand-400/35 bg-surface-elevated/70 px-3 py-2 text-sm font-black text-ink-inverse transition hover:border-brand-400/65 hover:bg-surface-elevated"
                    >
                      <UiIcon name="list" size={16} />
                      Ver playlist
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className={`${panelClass} p-5 sm:p-6`}>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Histórico
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Execuções recentes
            </h2>
          </div>

          {runs.length === 0 ? (
            <div className="mt-5 flex flex-col items-center justify-center rounded-2xl border border-line-dark/55 bg-surface-subtle/60 px-5 py-8 text-center sm:flex-row sm:gap-4 sm:text-left">
              <span className="product-icon-tile h-11 w-11 rounded-full">
                <UiIcon name="history" size={20} />
              </span>
              <div className="mt-3 sm:mt-0">
                <p className="font-bold text-ink-inverse">Nenhuma execução registrada</p>
                <p className="mt-1 text-sm text-muted-inverse">
                  Sua primeira geração aparecerá aqui.
                </p>
              </div>
            </div>
          ) : (
            <ul className="mt-5 divide-y divide-line-dark/45 overflow-hidden rounded-2xl border border-line-dark/55 bg-surface-subtle/60">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-10 w-10 items-center justify-center rounded-2xl text-sm font-black ${
                        run.status === "SUCCESS"
                          ? "bg-success-soft text-success"
                          : run.status === "FAILED"
                            ? "bg-danger-soft text-danger"
                            : run.status === "PARTIAL"
                              ? "bg-warning-soft text-warning"
                              : "bg-info-soft text-info"
                      }`}
                    >
                      {run.simulation ? "S" : "G"}
                    </span>
                    <div>
                      <p className="font-bold text-ink-inverse">
                        {run.simulation ? "Simulação" : "Geração"} · {run.trigger}
                      </p>
                      <p className="text-sm text-muted-inverse">{formatRunDate(run.startedAt)}</p>
                    </div>
                  </div>
                  <span
                    className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${
                      run.status === "SUCCESS"
                        ? "status-success"
                        : run.status === "FAILED"
                          ? "status-danger"
                          : run.status === "PARTIAL"
                            ? "status-warning"
                            : "status-info"
                    }`}
                  >
                    {run.status === "SUCCESS" ? (
                      <UiIcon name="check" size={14} />
                    ) : run.status === "PENDING" || run.status === "RUNNING" ? (
                      <UiIcon name="history" size={14} />
                    ) : (
                      <UiIcon name="warning" size={14} />
                    )}
                    {run.status === "SUCCESS"
                      ? "SUCESSO"
                      : run.status === "FAILED"
                        ? "FALHA"
                        : run.status === "PARTIAL"
                          ? "PARCIAL"
                          : run.status === "RUNNING"
                            ? "EM EXECUÇÃO"
                            : "PENDENTE"}
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