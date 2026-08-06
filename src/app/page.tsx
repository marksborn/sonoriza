import Link from "next/link";

import { auth, signIn } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();

  async function connectSpotify() {
    "use server";
    await signIn("spotify", { redirectTo: "/dashboard" });
  }

  async function connectGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-10 px-6 py-16">
      <header className="space-y-4">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand">
          Sonoriza
        </p>
        <h1 className="text-4xl font-bold sm:text-5xl">
          Playlists dinâmicas no seu tempo, agenda e contexto.
        </h1>
        <p className="max-w-xl text-lg text-neutral-600 dark:text-neutral-400">
          Monte playlists de músicas e podcasts com regras configuráveis:
          duração fixa ou calculada pela sua agenda, proporção entre conteúdos,
          ordem de reprodução e exclusividade entre listas.
        </p>
      </header>

      {session?.user ? (
        <div className="flex items-center gap-4">
          <span className="text-neutral-600 dark:text-neutral-400">
            Conectado como {session.user.email ?? session.user.name}.
          </span>
          <Link
            href="/dashboard"
            className="rounded-full bg-brand px-5 py-2 font-medium text-white hover:bg-brand-dark"
          >
            Abrir painel
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          <form action={connectGoogle}>
            <button
              type="submit"
              className="rounded-full border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Conectar Google
            </button>
          </form>
          <form action={connectSpotify}>
            <button
              type="submit"
              className="rounded-full bg-brand px-5 py-2 font-medium text-white hover:bg-brand-dark"
            >
              Conectar Spotify
            </button>
          </form>
        </div>
      )}

      <footer className="text-sm text-neutral-500">
        Open-source dynamic playlists shaped by your schedule, time and context.
      </footer>
    </main>
  );
}
