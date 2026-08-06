import { redirect } from "next/navigation";

import { RunControls } from "@/components/RunControls";
import { auth, signIn, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

    // Auth.js receives the current database session cookie during the OAuth
    // callback and links the new provider to this user instead of creating one.
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

    // If this Spotify account already belongs to another user, Auth.js rejects
    // the link rather than moving or merging it implicitly.
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

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Painel</h1>
          <p className="text-neutral-600 dark:text-neutral-400">
            {session.user.email}
          </p>
        </div>
        <form action={logOut}>
          <button
            type="submit"
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Sair
          </button>
        </form>
      </header>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Conexões</h2>
          <p className="text-sm text-neutral-500">
            Conecte os dois provedores ao mesmo usuário. Depois disso, você pode
            entrar no Sonoriza com qualquer um deles.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <article className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div>
              <h3 className="font-medium">Google</h3>
              <p className={hasGoogle ? "text-sm text-brand" : "text-sm text-neutral-500"}>
                {hasGoogle ? "Conectado ✓" : "Ainda não conectado"}
              </p>
            </div>
            {!hasGoogle && (
              <form action={connectGoogle}>
                <button
                  type="submit"
                  className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  Conectar Google
                </button>
              </form>
            )}
          </article>

          <article className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div>
              <h3 className="font-medium">Spotify</h3>
              <p className={hasSpotify ? "text-sm text-brand" : "text-sm text-neutral-500"}>
                {hasSpotify ? "Conectado ✓" : "Ainda não conectado"}
              </p>
            </div>
            {!hasSpotify && (
              <form action={connectSpotify}>
                <button
                  type="submit"
                  className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
                >
                  Conectar Spotify
                </button>
              </form>
            )}
          </article>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Geração</h2>
        <RunControls />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Playlists de destino</h2>
        {targets.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nenhuma configurada ainda. (Configuração via UI é o próximo passo do
            MVP — por enquanto use <code>prisma studio</code> ou o seed.)
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {targets.map((target) => (
              <li key={target.id}>
                <span className="font-medium">{target.name}</span> · prioridade{" "}
                {target.priority} · {target.durationMode} · {target.podcastPercent}%
                podcasts
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Execuções recentes</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhuma execução ainda.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {runs.map((run) => (
              <li key={run.id}>
                {run.startedAt.toISOString()} · {run.trigger} ·{" "}
                <span className="font-medium">{run.status}</span>
                {run.simulation ? " (simulação)" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
