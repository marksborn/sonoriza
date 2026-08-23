import Link from "next/link";
import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";

import { DiscoverTabs } from "./DiscoverTabs";

export default async function DiscoverLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  return (
    <main className="product-shell min-h-screen pb-24">
      <div className="product-ambient" />
      <div className="pointer-events-none absolute left-1/2 top-12 h-[30rem] w-[30rem] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />

      <header className="relative z-10 border-b border-line-dark/50 bg-surface-dark/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
          <BrandLogo compact variant="light" />
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-subtle/70 px-3 py-2 text-sm font-bold text-muted-inverse transition hover:border-brand-400/50 hover:text-ink-inverse"
          >
            <UiIcon name="arrow-left" size={17} />
            Painel
          </Link>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-7xl space-y-5 px-5 py-6 sm:space-y-6 sm:px-8 lg:px-10 lg:py-8">
        <section className="product-panel overflow-hidden p-5 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-accent-400">
                Descobrir
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-[-0.035em] text-ink-inverse sm:text-4xl">
                Música que faz sentido para você.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-inverse sm:text-base">
                Recomendações personalizadas, álbuns para aprofundar e lançamentos relevantes em uma única área.
              </p>
            </div>
            <div className="w-full lg:max-w-xl">
              <DiscoverTabs />
            </div>
          </div>
        </section>

        {children}
      </div>
    </main>
  );
}
