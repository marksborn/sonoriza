import { UiIcon } from "@/components/UiIcon";

export default function ForYouPage() {
  return (
    <section className="product-panel p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <span className="product-icon-tile-accent h-12 w-12 shrink-0">
          <UiIcon name="music" size={22} />
        </span>
        <div>
          <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Para você</p>
          <h2 className="mt-1 text-2xl font-black text-ink-inverse">Seu mix pessoal de descoberta</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-inverse">
            Esta seção vai reunir familiaridade, redescoberta e descoberta do motor DISCOVERY-01. A estrutura de navegação já está pronta; a experiência completa entra na próxima etapa.
          </p>
        </div>
      </div>
    </section>
  );
}
