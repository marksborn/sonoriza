import Link from "next/link";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "Esta conta já está vinculada a outro usuário ou ainda não foi conectada ao seu usuário atual. Entre primeiro com um provedor já vinculado e conecte o outro pelo painel.",
  AccessDenied:
    "O acesso foi negado pelo provedor. Revise a autorização e tente novamente.",
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

export default async function AuthErrorPage({
  searchParams,
}: AuthErrorPageProps) {
  const params = await searchParams;
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const message =
    (errorCode && AUTH_ERROR_MESSAGES[errorCode]) ??
    "Não foi possível concluir a autenticação. Volte ao início e tente novamente.";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand">
          Sonoriza
        </p>
        <h1 className="text-3xl font-bold">Não foi possível entrar</h1>
        <p className="text-neutral-600 dark:text-neutral-400">{message}</p>
      </div>

      <div>
        <Link
          href="/"
          className="inline-flex rounded-full bg-brand px-5 py-2 font-medium text-white hover:bg-brand-dark"
        >
          Voltar ao início
        </Link>
      </div>
    </main>
  );
}
