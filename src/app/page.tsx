import Link from "next/link";

import { BrandLogo } from "@/components/BrandLogo";
import { PrelaunchSignupForm } from "@/components/PrelaunchSignupForm";
import { UiIcon } from "@/components/UiIcon";
import { auth, signIn } from "@/lib/auth";

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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="M6.6 9.3c3.7-1.1 8.2-.8 11.2.9M7.4 12.7c3.1-.8 6.9-.5 9.5.8M8.2 15.8c2.6-.6 5.4-.3 7.7.7"
        fill="none"
        stroke="#27106f"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
    </svg>
  );
}

const highlights = [
  "Duração guiada pela agenda",
  "Músicas e podcasts na medida",
  "Uma playlist para cada contexto",
];

export default async function HomePage() {
  const session = await auth();

  async function signInWithSpotify() {
    "use server";
    await signIn("spotify", { redirectTo: "/dashboard" });
  }

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <main className="product-shell">
      <div className="product-ambient" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <nav className="product-panel flex items-center justify-between px-4 py-3 sm:px-5">
          <BrandLogo compact variant="light" />
          <span className="product-badge">
            <span className="h-2 w-2 rounded-full bg-accent" />
            Open source
          </span>
        </nav>

        <section className="grid flex-1 items-center gap-12 py-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-20">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/25 bg-brand/15 px-3 py-1.5 text-xs font-black uppercase tracking-[0.16em] text-brand-400">
              <span className="h-2 w-2 rounded-full bg-accent" />
              Playlists que acompanham seu ritmo
            </span>

            <h1 className="mt-6 text-5xl font-black leading-[0.98] tracking-[-0.055em] text-ink-inverse sm:text-6xl lg:text-7xl">
              Seu tempo muda.
              <span className="mt-2 block bg-gradient-to-r from-brand-400 via-brand-light to-accent bg-clip-text text-transparent">
                Seu som acompanha.
              </span>
            </h1>

            <p className="mt-7 max-w-xl text-lg leading-8 text-muted-inverse sm:text-xl">
              O Sonoriza combina sua agenda, o tempo disponível e suas preferências
              para montar playlists dinâmicas de músicas e podcasts — sem trabalho
              manual a cada mudança do dia.
            </p>

            {session?.user ? (
              <div className="product-panel mt-9 flex max-w-xl flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-inverse">
                    Sessão ativa
                  </p>
                  <p className="mt-1 font-bold text-ink-inverse">
                    {session.user.email ?? session.user.name}
                  </p>
                </div>
                <Link href="/dashboard" className="primary-button">
                  Abrir meu painel
                  <UiIcon name="arrow-right" size={18} />
                </Link>
              </div>
            ) : (
              <section className="mt-9 space-y-4" aria-label="Entrar no Sonoriza">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <form action={signInWithGoogle}>
                    <button
                      type="submit"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-line-dark/70 bg-surface-elevated px-5 py-3 font-bold text-ink-inverse shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-brand-400/45 hover:bg-surface-subtle sm:w-auto"
                    >
                      <GoogleIcon />
                      Entrar com Google
                    </button>
                  </form>
                  <form action={signInWithSpotify}>
                    <button type="submit" className="primary-button w-full sm:w-auto">
                      <SpotifyIcon />
                      Entrar com Spotify
                    </button>
                  </form>
                </div>
                <p className="max-w-xl text-sm leading-6 text-muted-inverse">
                  Escolha um provedor no primeiro acesso. No painel, conecte o outro
                  para entrar depois com qualquer um deles no mesmo usuário.
                </p>
              </section>
            )}

            {!session?.user ? <PrelaunchSignupForm /> : null}

            <ul className="mt-10 grid gap-3 text-sm font-semibold text-ink-inverse sm:grid-cols-3">
              {highlights.map((highlight) => (
                <li key={highlight} className="flex items-start gap-2.5">
                  <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-brand-400/30 bg-brand/15 text-brand-400">
                    <UiIcon name="check" size={13} strokeWidth={2.5} />
                  </span>
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
            <div className="absolute -inset-5 -rotate-2 rounded-[2.5rem] bg-brand-gradient opacity-20 blur-xl" />
            <div className="product-panel relative overflow-hidden p-5 sm:p-7">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-inverse">
                    Agora no Sonoriza
                  </p>
                  <h2 className="mt-1 text-2xl font-black tracking-[-0.035em] text-ink-inverse">
                    Foco da manhã
                  </h2>
                </div>
                <div className="product-icon-tile-accent">
                  <UiIcon name="music" size={23} />
                </div>
              </div>

              <div className="mt-6 overflow-hidden rounded-3xl bg-brand-gradient p-5 text-white shadow-soft sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/[0.65]">
                      Playlist inteligente
                    </p>
                    <p className="mt-2 text-2xl font-black tracking-tight">
                      Comece com energia
                    </p>
                    <p className="mt-1 text-sm text-white/70">
                      48 min · 80% música · 20% podcast
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-brand-dark shadow-lg"
                  >
                    <UiIcon name="play" size={20} fill="currentColor" strokeWidth={1.5} />
                  </span>
                </div>

                <div className="mt-7 flex h-12 items-end gap-1.5" aria-hidden="true">
                  {[16, 29, 20, 38, 25, 43, 31, 19, 35, 46, 28, 40, 22, 34, 18, 30, 14, 24].map(
                    (height, index) => (
                      <span
                        key={`${height}-${index}`}
                        className="flex-1 rounded-full bg-white/75"
                        style={{ height }}
                      />
                    ),
                  )}
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <article className="product-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted-inverse">
                      Agenda
                    </span>
                    <span className="rounded-full border border-brand-400/30 bg-brand/15 px-2.5 py-1 text-xs font-bold text-brand-400">
                      09:00–09:48
                    </span>
                  </div>
                  <p className="mt-3 font-bold text-ink-inverse">Bloco de concentração</p>
                  <p className="mt-1 text-sm text-muted-inverse">Duração calculada automaticamente</p>
                </article>

                <article className="product-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted-inverse">
                      Mix
                    </span>
                    <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-bold text-accent-400">
                      Dinâmico
                    </span>
                  </div>
                  <p className="mt-3 font-bold text-ink-inverse">Seu conteúdo, na medida</p>
                  <p className="mt-1 text-sm text-muted-inverse">Sem repetir entre as listas</p>
                </article>
              </div>
            </div>
          </div>
        </section>

        <footer className="flex flex-col gap-2 border-t border-line-dark/60 py-5 text-sm text-muted-inverse sm:flex-row sm:items-center sm:justify-between">
          <span>Sonoriza · playlists no seu tempo.</span>
          <span>Agenda, música e contexto em sintonia.</span>
        </footer>
      </div>
    </main>
  );
}
