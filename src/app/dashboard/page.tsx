import { redirect } from "next/navigation";

import { RunControls } from "@/components/RunControls";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

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

  const providers = new Set(connectedProviders.map((a) => a.provider));

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-6 py-12">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Painel</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          {session.user.email}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Conexões</h2>
        <ul className="flex gap-3 text-sm">
          <li className={providers.has("google") ? "text-brand" : "text-neutral-400"}>
            Google {providers.has("google") ? "✓" : "—"}
          </li>
          <li className={providers.has("spotify") ? "text-brand" : "text-neutral-400"}>
            Spotify {providers.has("spotify") ? "✓" : "—"}
          </li>
        </ul>
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
            {targets.map((t) => (
              <li key={t.id}>
                <span className="font-medium">{t.name}</span> · prioridade{" "}
                {t.priority} · {t.durationMode} · {t.podcastPercent}% podcasts
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
            {runs.map((r) => (
              <li key={r.id}>
                {r.startedAt.toISOString()} · {r.trigger} ·{" "}
                <span className="font-medium">{r.status}</span>
                {r.simulation ? " (simulação)" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
