import { notFound } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { UiIcon } from "@/components/UiIcon";
import { signIn } from "@/lib/auth";
import {
  findValidPrelaunchInvite,
  maskPrelaunchEmail,
} from "@/services/prelaunch-invite";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await findValidPrelaunchInvite(token);
  if (!invite) notFound();

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  async function signInWithSpotify() {
    "use server";
    await signIn("spotify", { redirectTo: "/dashboard" });
  }

  const maskedEmail = maskPrelaunchEmail(invite.expectedEmail);
  const expiresAt = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(invite.expiresAt);

  return (
    <main className="product-shell flex min-h-dvh items-center px-5 py-8 sm:px-8">
      <div className="product-ambient" />
      <section className="product-panel relative mx-auto w-full max-w-xl p-6 sm:p-8">
        <BrandLogo compact variant="light" />

        <div className="mt-8">
          <span className="product-icon-tile-accent">
            <UiIcon name="mail" size={23} />
          </span>
          <p className="mt-6 text-xs font-black uppercase tracking-[0.17em] text-accent-400">
            Convite para o piloto
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse">
            Seu convite chegou.
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse">
            Entre com o mesmo e-mail do convite:{" "}
            <strong className="text-ink-inverse">{maskedEmail}</strong>.
            Outro endereço será recusado.
          </p>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <form action={signInWithGoogle}>
            <button className="w-full rounded-2xl border border-line-dark bg-surface-elevated px-5 py-3 font-black text-ink-inverse">
              Entrar com Google
            </button>
          </form>
          <form action={signInWithSpotify}>
            <button className="w-full rounded-2xl bg-accent px-5 py-3 font-black text-brand-900 shadow-action">
              Entrar com Spotify
            </button>
          </form>
        </div>

        <p className="mt-5 text-xs leading-5 text-muted-inverse">
          Válido até {expiresAt}. O link não substitui a confirmação de identidade
          feita pelo provedor de acesso.
        </p>
      </section>
    </main>
  );
}
