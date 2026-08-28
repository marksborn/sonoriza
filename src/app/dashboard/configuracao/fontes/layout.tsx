import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import {
  getNativeLikedTrackSourceConfiguration,
  setNativeLikedTrackSourceEnabled,
} from "@/services/music-preference/native-source-preference";

async function toggleNativeLikedTrackSource(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const enabled = String(formData.get("enabled") ?? "") === "true";
  await setNativeLikedTrackSourceEnabled(session.user.id, enabled);

  revalidatePath("/dashboard/configuracao/fontes");
  revalidatePath("/dashboard/configuracao/revisao");
  redirect("/dashboard/configuracao/fontes");
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function relativeFreshness(value: Date | null) {
  if (!value) return "Ainda sem sincronização local";

  const deltaMs = Math.max(0, Date.now() - value.getTime());
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "Atualizada agora";
  if (minutes < 60) return `Atualizada há ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Atualizada há ${hours} h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `Atualizada há ${days} dia${days === 1 ? "" : "s"}`;

  return `Atualizada em ${new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value)}`;
}

export default async function SourcesLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const source = await getNativeLikedTrackSourceConfiguration(session.user.id);
  const nextEnabled = !source.enabled;

  return (
    <>
      <section className="relative overflow-hidden border-b border-line-dark/40 bg-canvas-dark px-5 pt-8 sm:px-8 lg:px-10">
        <div className="product-ambient" />
        <div className="relative mx-auto max-w-6xl pb-2">
          <div className="product-panel p-5 sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 gap-4">
                <div className="product-icon-tile-accent">
                  <UiIcon name="music" size={22} />
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                      Fonte nativa
                    </p>
                    <span className="product-badge">Fonte pessoal fixa</span>
                    <span
                      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-black ${
                        source.enabled
                          ? "border-success/30 bg-success-soft text-success"
                          : "border-line-dark/60 bg-surface-elevated/70 text-muted-inverse"
                      }`}
                    >
                      <UiIcon name={source.enabled ? "check" : "music"} size={14} />
                      Preferência {source.enabled ? "ativada" : "desativada"}
                    </span>
                  </div>

                  <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-ink-inverse">
                    Músicas Curtidas
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
                    Biblioteca pessoal persistente. As músicas continuam nesta fonte depois de serem usadas e permanecem sujeitas às regras normais de repetição, diversidade e qualidade do Sonoriza.
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-bold text-muted-inverse">
                    <span className="product-badge">
                      {compactNumber(source.counts.activeLikedTracks)} músicas
                    </span>
                    <span className="product-badge">
                      {compactNumber(source.counts.available)} disponíveis
                    </span>
                    {source.counts.unavailable > 0 && (
                      <span className="product-badge">
                        {compactNumber(source.counts.unavailable)} indisponíveis
                      </span>
                    )}
                    {source.counts.invalid > 0 && (
                      <span className="product-badge">
                        {compactNumber(source.counts.invalid)} inválidas
                      </span>
                    )}
                    <span className="product-badge">
                      {relativeFreshness(source.freshness.latestObservedAt)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="shrink-0 lg:w-64">
                <form action={toggleNativeLikedTrackSource}>
                  <input type="hidden" name="enabled" value={String(nextEnabled)} />
                  <button
                    type="submit"
                    className={
                      source.enabled
                        ? "inline-flex w-full items-center justify-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-4 py-3 text-sm font-black text-ink-inverse transition hover:border-brand-400/55 hover:bg-surface-elevated"
                        : "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400"
                    }
                  >
                    <UiIcon name={source.enabled ? "repeat" : "check"} size={17} />
                    {source.enabled ? "Desativar preferência" : "Habilitar preferência"}
                  </button>
                </form>
                <p className="mt-2 text-xs leading-5 text-muted-inverse">
                  O ajuste é salvo no Sonoriza e não remove nenhuma música da sua biblioteca.
                </p>
              </div>
            </div>

            <div className="status-info mt-5 rounded-2xl border px-4 py-3 text-xs font-bold leading-5">
              Nesta etapa, o controle é apenas uma preferência persistida e ainda não altera o planner. A participação efetiva continuará protegida pelo rollout atual até o Gate 5B2.
            </div>
          </div>
        </div>
      </section>

      {children}
    </>
  );
}
