import Link from "next/link";

import { BrandLogo } from "@/components/BrandLogo";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "Esta conta já está vinculada a outro usuário ou ainda não foi conectada ao seu usuário atual. Entre primeiro com um provedor já vinculado e conecte o outro pelo painel.",
  AccessDenied:
    "O Sonoriza está com acesso restrito nesta fase. Este e-mail não está na lista de usuários autorizados. Peça ao administrador para liberar o seu e-mail antes de tentar novamente.",
  OAuthCallbackError:
    "Não foi possível concluir a autenticação com o provedor. Tente novamente.",
  Configuration:
    "A autenticação encontrou um problema de configuração. Consulte o administrador do Sonoriza.",
};

type AuthErrorPageProps = {
  searchParams: Promise<{
    error?: string | string[];
  }>;
};

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const params = await searchParams;
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const message =
    (errorCode && AUTH_ERROR_MESSAGES[errorCode]) ??
    "Não foi possível concluir a autenticação. Volte ao início e tente novamente.";

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-12">
      <div className="pointer-events-none absolute -left-20 top-20 h-72 w-72 rounded-full bg-brand-light/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-20 bottom-10 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />

      <section className="glass-panel relative w-full max-w-xl rounded-[2rem] p-6 sm:p-9">
        <BrandLogo compact />

        <div className="mt-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl font-black text-accent">
          !
        </div>

        <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-brand">
          Autenticação
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-brand-dark sm:text-4xl">
          Não foi possível entrar
        </h1>
        <p className="mt-4 leading-7 text-muted">{message}</p>

        {errorCode && (
          <p className="mt-3 text-xs text-muted/75">
            Código: <code className="rounded bg-canvas px-1.5 py-0.5">{errorCode}</code>
          </p>
        )}

        <Link href="/" className="primary-button mt-8">
          Voltar ao início
          <span aria-hidden="true">→</span>
        </Link>
      </section>
    </main>
  );
}