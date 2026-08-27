import { UiIcon } from "@/components/UiIcon";
import {
  normalizeTargetDiscoveryPolicy,
  type TargetDiscoveryIntensity,
} from "@/services/music-discovery/target-discovery-policy";

const sectionClass =
  "rounded-2xl border border-line-dark/55 bg-surface-subtle/55 px-3 py-3 sm:p-5";
const discoveryOptionClass =
  "cursor-pointer rounded-xl border border-line-dark/55 bg-surface-subtle/55 px-3 py-2.5 transition hover:border-brand-400/45 hover:bg-surface-elevated/65 has-[:checked]:border-brand-400/65 has-[:checked]:bg-brand/15 sm:rounded-2xl sm:p-4";

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

type TargetDiscoveryInitial = {
  id: string;
  discoveryEnabled: boolean;
  discoveryFamiliarEnabled: boolean;
  discoveryRediscoveryEnabled: boolean;
  discoveryNoveltyEnabled: boolean;
  discoveryReleasesEnabled: boolean;
  discoveryIntensity: TargetDiscoveryIntensity;
};

type Props = {
  target: TargetDiscoveryInitial;
  saveAction: (formData: FormData) => void | Promise<void>;
};

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
      <span className="flex items-center gap-2.5 sm:items-start sm:gap-3">
        <input
          id={id}
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          className="h-4 w-4 shrink-0 accent-accent sm:mt-1"
        />
        <span className="min-w-0">
          <span className="block text-sm font-black text-ink-inverse">{label}</span>
          <span className="mt-1 hidden text-xs leading-5 text-muted-inverse/65 sm:block">
            {description}
          </span>
        </span>
      </span>
    </label>
  );
}

export function TargetDiscoveryForm({ target, saveAction }: Props) {
  const policy = normalizeTargetDiscoveryPolicy(target);
  const idPrefix = `discovery-${target.id}`;

  return (
    <form action={saveAction} className="space-y-3 sm:space-y-4">
      <input type="hidden" name="targetId" value={target.id} />

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
            Descobrir neste destino
          </p>
          <h4 className="mt-1 text-base font-black text-ink-inverse">
            Enriquecimento e descoberta
          </h4>
          <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
            Esta política pertence somente a esta playlist. Salvar não inicia uma geração.
          </p>
        </div>
        <span className="product-badge w-fit">
          <UiIcon name="music" size={14} />
          {policy.enabled ? "Descobrir ativo" : "Descobrir desligado"}
        </span>
      </div>

      <label
        htmlFor={`${idPrefix}-master`}
        className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-line-dark/55 bg-surface-subtle/55 px-3 py-3 transition hover:border-brand-400/45 hover:bg-surface-elevated/65 has-[:checked]:border-brand-400/65 has-[:checked]:bg-brand/15 sm:items-start sm:gap-3 sm:rounded-2xl sm:p-4"
      >
        <input
          id={`${idPrefix}-master`}
          type="checkbox"
          name="discoveryEnabled"
          defaultChecked={policy.enabled}
          className="h-4 w-4 shrink-0 accent-accent sm:mt-1"
        />
        <span className="min-w-0">
          <span className="block text-sm font-black text-ink-inverse">
            Usar Descobrir neste destino
          </span>
          <span className="mt-1 hidden text-xs leading-5 text-muted-inverse/65 sm:block">
            Desligado, mantém as escolhas abaixo salvas sem autorizar famílias de descoberta.
          </span>
        </span>
      </label>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Famílias de descoberta
        </legend>
        <p className="mt-1 text-[11px] leading-4 text-muted-inverse/65 sm:text-xs sm:leading-5">
          Escolha os tipos de enriquecimento permitidos nesta playlist.
        </p>
        <div className="mt-3 grid gap-2 sm:mt-4 sm:grid-cols-2 sm:gap-3">
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
            description="Lançamentos relevantes quando houver provider e evidência suficientes."
            defaultChecked={policy.releasesEnabled}
          />
        </div>
      </fieldset>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">Intensidade</legend>
        <p className="mt-1 text-[11px] leading-4 text-muted-inverse/65 sm:text-xs sm:leading-5">
          Define quanto espaço o motor pode abrir para enriquecimento; não é uma porcentagem fixa.
        </p>
        <div className="mt-3 grid gap-2 sm:mt-4 sm:gap-3 lg:grid-cols-3">
          {INTENSITIES.map((intensity) => (
            <label
              key={intensity.value}
              htmlFor={`${idPrefix}-${intensity.value.toLowerCase()}`}
              className={discoveryOptionClass}
            >
              <span className="flex items-center gap-2 sm:block">
                <input
                  id={`${idPrefix}-${intensity.value.toLowerCase()}`}
                  type="radio"
                  name="discoveryIntensity"
                  value={intensity.value}
                  defaultChecked={policy.intensity === intensity.value}
                  className="shrink-0 accent-accent sm:mr-2"
                />
                <span className="font-black text-ink-inverse">{intensity.label}</span>
              </span>
              <span className="mt-1 hidden text-xs leading-5 text-muted-inverse/65 sm:block">
                {intensity.description}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-line-dark/55 pt-3 sm:flex-row sm:items-center sm:justify-between sm:pt-4">
        <p className="hidden text-xs leading-5 text-muted-inverse/65 sm:block">
          Álbuns completos continuam no fluxo próprio de Descobrir → Álbuns.
        </p>
        <button type="submit" className="primary-button w-full shrink-0 sm:w-auto">
          Salvar Descobertas
        </button>
      </div>
    </form>
  );
}
