import { UiIcon } from "@/components/UiIcon";
import {
  normalizeTargetDiscoveryPolicy,
  type TargetDiscoveryIntensity,
} from "@/services/music-discovery/target-discovery-policy";

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

export function TargetDiscoveryForm({ target, saveAction }: Props) {
  const policy = normalizeTargetDiscoveryPolicy(target);
  const idPrefix = `discovery-${target.id}`;

  return (
    <form action={saveAction} className="space-y-4">
      <input type="hidden" name="targetId" value={target.id} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
        className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 transition hover:border-brand-400/45 hover:bg-surface-elevated/65 has-[:checked]:border-brand-400/65 has-[:checked]:bg-brand/15"
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
            Desligado, mantém as escolhas abaixo salvas sem autorizar famílias de descoberta.
          </span>
        </span>
      </label>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Famílias de descoberta
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          Escolha quais tipos de enriquecimento esta playlist pode considerar.
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
            description="Lançamentos relevantes quando houver provider e evidência suficientes."
            defaultChecked={policy.releasesEnabled}
          />
        </div>
      </fieldset>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">Intensidade</legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          Controla quanto o motor poderá enriquecer a seleção; não representa porcentagem fixa.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {INTENSITIES.map((intensity) => (
            <label
              key={intensity.value}
              htmlFor={`${idPrefix}-${intensity.value.toLowerCase()}`}
              className={discoveryOptionClass}
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

      <div className="flex flex-col gap-3 border-t border-line-dark/55 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted-inverse/65">
          Álbuns completos continuam no fluxo próprio de Descobrir → Álbuns.
        </p>
        <button type="submit" className="primary-button shrink-0">
          Salvar Descobertas
        </button>
      </div>
    </form>
  );
}
