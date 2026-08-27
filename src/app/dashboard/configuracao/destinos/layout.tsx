import type { ReactNode } from "react";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { targetDiscoveryPolicyFromForm } from "@/services/music-discovery/target-discovery-form";
import {
  normalizeTargetDiscoveryPolicy,
  type TargetDiscoveryIntensity,
} from "@/services/music-discovery/target-discovery-policy";

const CONFIG_PATH = "/dashboard/configuracao/destinos";
const sectionClass =
  "rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 sm:p-5";
const discoveryOptionClass =
  "cursor-pointer rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 transition hover:border-brand-400/45 hover:bg-surface-elevated/65 has-[:checked]:border-brand-400/65 has-[:checked]:bg-brand/15";

const INTENSITIES: Array<{
  value: TargetDiscoveryIntensity;
  label: string;
  description: string;
}> = [
  {
    value: "CONSERVATIVE",
    label: "Conservadora",
    description: "Prioriza o repertório conhecido e abre menos espaço para enriquecimento.",
  },
  {
    value: "BALANCED",
    label: "Equilibrada",
    description: "Equilibra repertório conhecido, redescobertas e candidatos novos.",
  },
  {
    value: "EXPLORATORY",
    label: "Exploratória",
    description: "Permite ao motor considerar mais candidatos de descoberta quando forem fortes.",
  },
];

async function saveTargetDiscoveryPolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId) redirect(`${CONFIG_PATH}?error=invalid`);

  let data;
  try {
    data = targetDiscoveryPolicyFromForm({
      discoveryEnabled: valueOrNull(formData.get("discoveryEnabled")),
      discoveryFamiliarEnabled: valueOrNull(
        formData.get("discoveryFamiliarEnabled"),
      ),
      discoveryRediscoveryEnabled: valueOrNull(
        formData.get("discoveryRediscoveryEnabled"),
      ),
      discoveryNoveltyEnabled: valueOrNull(
        formData.get("discoveryNoveltyEnabled"),
      ),
      discoveryReleasesEnabled: valueOrNull(
        formData.get("discoveryReleasesEnabled"),
      ),
      discoveryIntensity: valueOrNull(formData.get("discoveryIntensity")),
    });
  } catch {
    redirect(`${CONFIG_PATH}?error=discovery`);
  }

  const result = await prisma.targetPlaylist.updateMany({
    where: {
      id: targetId,
      userId: session.user.id,
    },
    data,
  });

  if (result.count !== 1) redirect(`${CONFIG_PATH}?error=invalid`);

  revalidatePath(CONFIG_PATH);
  redirect(`${CONFIG_PATH}?saved=updated`);
}

function valueOrNull(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" ? value : null;
}

function DiscoveryToggle({
  id,
  name,
  label,
  description,
  defaultChecked,
}: {
  id: string;
  name: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label htmlFor={id} className={discoveryOptionClass}>
      <span className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          className="mt-1 h-4 w-4 shrink-0 accent-accent"
        />
        <span>
          <span className="block text-sm font-black text-ink-inverse">{label}</span>
          <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
            {description}
          </span>
        </span>
      </span>
    </label>
  );
}

export default async function DestinationsDiscoveryLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const targets = await prisma.targetPlaylist.findMany({
    where: { userId: session.user.id },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      discoveryEnabled: true,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: true,
      discoveryIntensity: true,
    },
  });

  const enabledCount = targets.filter((target) => target.discoveryEnabled).length;

  return (
    <>
      {children}

      <section className="px-5 pb-10 sm:px-8 lg:px-10">
        <div className="relative mx-auto max-w-6xl">
          <div className="product-panel p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                  Descobertas por destino
                </p>
                <h2 className="mt-1 text-xl font-black text-ink-inverse">
                  Escolha como cada playlist poderá usar o Descobrir
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
                  A política é independente por destino. Descobrir é enriquecimento, não cota obrigatória:
                  quando não houver candidato forte, as fontes normais continuam sendo a base.
                </p>
              </div>
              <span className="product-badge w-fit">
                <UiIcon name="music" size={15} />
                {enabledCount} de {targets.length} habilitados
              </span>
            </div>

            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-line-dark/55 bg-surface-subtle/55 px-4 py-3 text-xs font-semibold leading-5 text-muted-inverse">
              <UiIcon name="music" size={17} className="mt-0.5 shrink-0 text-brand-400" />
              <span>
                Salvar atualiza somente a política deste destino. Nenhuma geração é iniciada e nenhuma playlist é alterada imediatamente.
              </span>
            </div>

            {targets.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-line-dark/60 bg-surface-subtle/55 p-6 text-center">
                <p className="font-black text-ink-inverse">Crie um destino primeiro</p>
                <p className="mt-1 text-sm text-muted-inverse">
                  Todo destino novo nasce com Descobrir desligado e pode ser configurado aqui depois.
                </p>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                {targets.map((target) => {
                  const policy = normalizeTargetDiscoveryPolicy(target);
                  const idPrefix = `discovery-${target.id}`;

                  return (
                    <form
                      key={target.id}
                      action={saveTargetDiscoveryPolicy}
                      className="rounded-2xl border border-line-dark/55 bg-surface-dark/60 p-4 sm:p-5"
                    >
                      <input type="hidden" name="targetId" value={target.id} />

                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <h3 className="text-lg font-black text-ink-inverse">{target.name}</h3>
                          <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
                            As escolhas ficam salvas somente neste destino.
                          </p>
                        </div>
                        <span className="product-badge w-fit">
                          <UiIcon name="music" size={14} />
                          {policy.enabled ? "Descobrir ativo" : "Descobrir desligado"}
                        </span>
                      </div>

                      <label
                        htmlFor={`${idPrefix}-master`}
                        className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 transition hover:border-brand-400/45 hover:bg-surface-elevated/65 has-[:checked]:border-brand-400/65 has-[:checked]:bg-brand/15"
                      >
                        <input
                          id={`${idPrefix}-master`}
                          type="checkbox"
                          name="discoveryEnabled"
                          defaultChecked={policy.enabled}
                          className="mt-1 h-4 w-4 shrink-0 accent-accent"
                        />
                        <span>
                          <span className="block text-sm font-black text-ink-inverse">
                            Usar Descobrir neste destino
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                            Interruptor principal. Desligado, mantém as escolhas abaixo salvas sem autorizar famílias de descoberta.
                          </span>
                        </span>
                      </label>

                      <fieldset className={`${sectionClass} mt-4`}>
                        <legend className="px-1 text-sm font-black text-ink-inverse">
                          Famílias de descoberta
                        </legend>
                        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
                          Escolha quais tipos de enriquecimento este destino pode considerar quando o master estiver ativo.
                        </p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <DiscoveryToggle
                            id={`${idPrefix}-familiar`}
                            name="discoveryFamiliarEnabled"
                            label="Familiaridade"
                            description="Repertório e artistas já conhecidos, respeitando as demais regras aplicáveis."
                            defaultChecked={policy.familiarEnabled}
                          />
                          <DiscoveryToggle
                            id={`${idPrefix}-rediscovery`}
                            name="discoveryRediscoveryEnabled"
                            label="Redescoberta"
                            description="Músicas com histórico forte que ficaram ausentes por tempo relevante."
                            defaultChecked={policy.rediscoveryEnabled}
                          />
                          <DiscoveryToggle
                            id={`${idPrefix}-novelty`}
                            name="discoveryNoveltyEnabled"
                            label="Descoberta"
                            description="Faixas e artistas novos para você quando houver afinidade provável."
                            defaultChecked={policy.discoveryEnabled}
                          />
                          <DiscoveryToggle
                            id={`${idPrefix}-releases`}
                            name="discoveryReleasesEnabled"
                            label="Novidades"
                            description="Reserva a preferência para lançamentos relevantes; não inventa candidatos enquanto o provider não estiver disponível."
                            defaultChecked={policy.releasesEnabled}
                          />
                        </div>
                      </fieldset>

                      <fieldset className={`${sectionClass} mt-4`}>
                        <legend className="px-1 text-sm font-black text-ink-inverse">
                          Intensidade
                        </legend>
                        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
                          A intensidade controla o quanto o motor poderá enriquecer a seleção; não representa uma porcentagem fixa.
                        </p>
                        <div className="mt-4 grid gap-3 lg:grid-cols-3">
                          {INTENSITIES.map((intensity) => (
                            <label
                              key={intensity.value}
                              htmlFor={`${idPrefix}-${intensity.value.toLowerCase()}`}
                              className={`cursor-pointer rounded-2xl border p-4 transition ${
                                policy.intensity === intensity.value
                                  ? "border-brand-400/65 bg-brand/15"
                                  : "border-line-dark/55 bg-surface-subtle/55 hover:border-brand-400/45 hover:bg-surface-elevated/65"
                              }`}
                            >
                              <input
                                id={`${idPrefix}-${intensity.value.toLowerCase()}`}
                                type="radio"
                                name="discoveryIntensity"
                                value={intensity.value}
                                defaultChecked={policy.intensity === intensity.value}
                                className="mr-2 accent-accent"
                              />
                              <span className="font-black text-ink-inverse">{intensity.label}</span>
                              <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                                {intensity.description}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <div className="mt-5 flex flex-col gap-3 border-t border-line-dark/55 pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs leading-5 text-muted-inverse/65">
                          Álbuns completos continuam fora desta política e permanecem no fluxo próprio de Descobrir → Álbuns.
                        </p>
                        <button type="submit" className="primary-button shrink-0">
                          Salvar Descobertas
                        </button>
                      </div>
                    </form>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
