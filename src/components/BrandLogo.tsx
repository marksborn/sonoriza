import Image from "next/image";

const SONORIZA_MARK = "/sonoriza-mark.webp";

type BrandLogoProps = {
  compact?: boolean;
  className?: string;
  variant?: "dark" | "light";
};

export function BrandMark({ className = "h-11 w-11" }: { className?: string }) {
  return (
    <span className={`relative inline-flex shrink-0 overflow-hidden ${className}`}>
      <Image
        src={SONORIZA_MARK}
        alt="Símbolo do Sonoriza"
        fill
        unoptimized
        sizes="48px"
        className="object-contain"
      />
    </span>
  );
}

export function BrandLogo({
  compact = false,
  className = "",
  variant = "dark",
}: BrandLogoProps) {
  const textColor = variant === "light" ? "text-white" : "text-brand-dark";

  return (
    <span className={`inline-flex items-center gap-3 ${className}`.trim()}>
      <BrandMark className={compact ? "h-10 w-[2.35rem]" : "h-12 w-[2.82rem]"} />
      <span className="sr-only">Sonoriza</span>
      <span
        aria-hidden="true"
        className={`font-black leading-none tracking-[-0.05em] ${textColor} ${
          compact ? "text-xl sm:text-2xl" : "text-[1.8rem]"
        }`}
      >
        Sonor
        <span className="relative inline-block">
          ı
          <span className="absolute left-1/2 top-[-0.02em] h-[0.22em] w-[0.22em] -translate-x-1/2 rounded-full bg-accent" />
        </span>
        za
      </span>
    </span>
  );
}
