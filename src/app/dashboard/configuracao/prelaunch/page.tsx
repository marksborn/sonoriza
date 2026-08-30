import { PrelaunchSignupStatus } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { isPrelaunchAdmin } from "@/lib/prelaunch-admin";
import { prisma } from "@/lib/prisma";

const FILTER_STATUSES = [
  PrelaunchSignupStatus.WAITING,
  PrelaunchSignupStatus.INVITED,
  PrelaunchSignupStatus.ACTIVATED,
  PrelaunchSignupStatus.UNSUBSCRIBED,
] as const;

const STATUS_LABELS: Record<PrelaunchSignupStatus, string> = {
  PENDING_CONFIRMATION: "Confirmação pendente",
  WAITING: "Aguardando",
  INVITED: "Convidado",
  ACTIVATED: "Ativado",
  DECLINED: "Recusado",
  UNSUBSCRIBED: "Cancelado",
  BOUNCED: "E-mail devolvido",
};

function readStatus(value: string | undefined): PrelaunchSignupStatus | undefined {
  return Object.values(PrelaunchSignupStatus).includes(
    value as PrelaunchSignupStatus,
  )
    ? (value as PrelaunchSignupStatus)
    : undefined;
}

function formatDate(value: Date | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}

async function changeSignupStatus(formData: FormData) {
  "use server";

  const session = await auth();
  if (
    !session?.user?.id ||
    !session.user.email ||
    !isPrelaunchAdmin(session.user.email)
  ) {
    notFound();
  }

  const signupId = String(formData.get("signupId") ?? "");
  const requestedStatus = readStatus(String(formData.get("status") ?? ""));
  if (
    !signupId ||
    (requestedStatus !== PrelaunchSignupStatus.INVITED &&
      requestedStatus !== PrelaunchSignupStatus.WAITING)
  ) {
    throw new Error("Alteração de status inválida.");
  }

  await prisma.$transaction(async (tx) => {
    const signup = await tx.prelaunchSignup.findUnique({
      where: { id: signupId },
      select: { status: true },
    });
    if (!signup) throw new Error("Inscrição não encontrada.");

    const allowed =
      (signup.status === PrelaunchSignupStatus.WAITING &&
        requestedStatus === PrelaunchSignupStatus.INVITED) ||
      (signup.status === PrelaunchSignupStatus.INVITED &&
        requestedStatus === PrelaunchSignupStatus.WAITING);

    if (!allowed) throw new Error("Transição de status não permitida.");
    if (!session.user.email) throw new Error("Administrador sem e-mail.");

    const now = new Date();
    await tx.prelaunchSignup.update({
      where: { id: signupId },
      data: {
        status: requestedStatus,
        invitedAt:
          requestedStatus === PrelaunchSignupStatus.INVITED ? now : null,
      },
    });
    await tx.prelaunchSignupStatusEvent.create({
      data: {
        prelaunchSignupId: signupId,
        previousStatus: signup.status,
        status: requestedStatus,
        actorUserId: session.user.id,
        actorEmail: session.user.email.toLowerCase(),
      },
    });
  });

  revalidatePath("/dashboard/configuracao/prelaunch");
}

export default async function PrelaunchAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  if (!isPrelaunchAdmin(session.user.email)) notFound();

  const params = await searchParams;
  const query = params.q?.trim().slice(0, 120) ?? "";
  const status = readStatus(params.status);

  const [signups, counts] = await Promise.all([
    prisma.prelaunchSignup.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(query
          ? { email: { contains: query.toLowerCase(), mode: "insensitive" } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        statusEvents: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { actorEmail: true, createdAt: true },
        },
      },
    }),
    prisma.prelaunchSignup.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const countByStatus = new Map(
    counts.map((entry) => [entry.status, entry._count._all]),
  );
  const total = counts.reduce((sum, entry) => sum + entry._count._all, 0);

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />
      <div className="relative mx-auto max-w-6xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
        >
          <UiIcon name="arrow-left" size={18} />
          Voltar à configuração
        </Link>

        <header className="mt-7">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
            Pré-lançamento
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Lista de interessados
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-inverse sm:text-base">
            Consulte a fila e controle quem pode avançar para a etapa de convite.
            Marcar como convidado não envia e-mail nem libera acesso automaticamente.
          </p>
        </header>

        <section className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="product-card p-4">
            <p className="text-2xl font-black text-ink-inverse">{total}</p>
            <p className="mt-1 text-xs text-muted-inverse">Total</p>
          </div>
          {FILTER_STATUSES.slice(0, 3).map((item) => (
            <div key={item} className="product-card p-4">
              <p className="text-2xl font-black text-ink-inverse">
                {countByStatus.get(item) ?? 0}
              </p>
              <p className="mt-1 text-xs text-muted-inverse">
                {STATUS_LABELS[item]}
              </p>
            </div>
          ))}
        </section>

        <section className="product-panel mt-5 p-5 sm:p-6">
          <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <label className="relative">
              <span className="sr-only">Buscar por e-mail</span>
              <UiIcon
                name="search"
                size={18}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-inverse"
              />
              <input
                name="q"
                type="search"
                defaultValue={query}
                placeholder="Buscar por e-mail"
                className="w-full rounded-2xl border border-line-dark bg-surface-subtle py-3 pl-11 pr-4 text-sm text-ink-inverse outline-none transition placeholder:text-muted-inverse focus:border-brand-400"
              />
            </label>
            <select
              name="status"
              defaultValue={status ?? ""}
              className="rounded-2xl border border-line-dark bg-surface-subtle px-4 py-3 text-sm font-bold text-ink-inverse outline-none focus:border-brand-400"
            >
              <option value="">Todos os estados</option>
              {Object.values(PrelaunchSignupStatus).map((item) => (
                <option key={item} value={item}>
                  {STATUS_LABELS[item]}
                </option>
              ))}
            </select>
            <button className="rounded-2xl bg-brand px-5 py-3 text-sm font-black text-white">
              Filtrar
            </button>
          </form>
        </section>

        <section className="mt-5 space-y-3">
          {signups.length === 0 ? (
            <div className="product-panel p-8 text-center">
              <p className="font-bold text-ink-inverse">Nenhuma inscrição encontrada.</p>
            </div>
          ) : (
            signups.map((signup) => {
              const latestEvent = signup.statusEvents[0];
              return (
                <article key={signup.id} className="product-panel p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="break-all font-black text-ink-inverse">
                          {signup.email}
                        </h2>
                        <span className="product-badge">
                          {STATUS_LABELS[signup.status]}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted-inverse sm:grid-cols-2">
                        <p>Cadastro: {formatDate(signup.createdAt)}</p>
                        <p>Último envio: {formatDate(signup.lastSubmittedAt)}</p>
                        <p>Origem: {signup.source}</p>
                        <p>Envios: {signup.submissionCount}</p>
                        {latestEvent ? (
                          <p className="sm:col-span-2">
                            Última alteração: {formatDate(latestEvent.createdAt)} por{" "}
                            {latestEvent.actorEmail}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {signup.status === PrelaunchSignupStatus.WAITING ||
                    signup.status === PrelaunchSignupStatus.INVITED ? (
                      <form action={changeSignupStatus}>
                        <input type="hidden" name="signupId" value={signup.id} />
                        <input
                          type="hidden"
                          name="status"
                          value={
                            signup.status === PrelaunchSignupStatus.WAITING
                              ? PrelaunchSignupStatus.INVITED
                              : PrelaunchSignupStatus.WAITING
                          }
                        />
                        <button
                          type="submit"
                          className={
                            signup.status === PrelaunchSignupStatus.WAITING
                              ? "w-full rounded-2xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action lg:w-auto"
                              : "w-full rounded-2xl border border-line-dark bg-surface-subtle px-5 py-3 text-sm font-black text-ink-inverse lg:w-auto"
                          }
                        >
                          {signup.status === PrelaunchSignupStatus.WAITING
                            ? "Marcar como convidado"
                            : "Revogar convite"}
                        </button>
                      </form>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </section>
      </div>
    </main>
  );
}
