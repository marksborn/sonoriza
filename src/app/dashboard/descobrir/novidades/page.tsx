import { UiIcon } from "@/components/UiIcon";

export default function NewReleasesPage() {
  return (
    <section className="product-panel p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <span className="product-icon-tile-accent h-12 w-12 shrink-0">
          <UiIcon name="bell" size={22} />
        </span>
        <div>
          <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Novidades</p>
          <h2 className="mt-1 text-2xl font-black text-ink-inverse">Radar de lançamentos</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-inverse">
            Aqui vão aparecer lançamentos recentes relevantes para o seu perfil, separados de catálogo antigo que é apenas novo para você. O radar será implementado em RELEASES-01.
          </p>
        </div>
      </div>
    </section>
  );
}
