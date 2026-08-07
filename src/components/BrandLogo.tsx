type BrandLogoProps = {
  compact?: boolean;
  className?: string;
};

export function BrandMark({ className = "h-11 w-11" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Símbolo do Sonoriza"
      className={className}
    >
      <defs>
        <linearGradient id="sonoriza-mark-gradient" x1="8" y1="8" x2="57" y2="58">
          <stop offset="0" stopColor="#27106f" />
          <stop offset="0.58" stopColor="#6724d9" />
          <stop offset="1" stopColor="#922df2" />
        </linearGradient>
      </defs>

      <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#sonoriza-mark-gradient)" />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="16.25"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1.5"
      />

      <path
        d="M17 25.5c4.1-8.6 15.9-13 27.7-7.4 5.1 2.4 5.3 8.8.3 12.1L29.5 40.4"
        fill="none"
        stroke="#ffffff"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M47 38.5c-4.1 8.6-15.9 13-27.7 7.4-5.1-2.4-5.3-8.8-.3-12.1l15.5-10.2"
        fill="none"
        stroke="#ff7200"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path d="M50.5 24.5v5" stroke="#ff982b" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M55 21.5v11" stroke="#ff982b" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M59.5 25.5v3" stroke="#ff982b" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

export function BrandLogo({ compact = false, className = "" }: BrandLogoProps) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`.trim()}>
      <BrandMark className={compact ? "h-9 w-9" : "h-11 w-11"} />
      <span className="sr-only">Sonoriza</span>
      <span
        aria-hidden="true"
        className={`font-extrabold leading-none tracking-[-0.045em] text-brand-dark ${
          compact ? "text-xl" : "text-[1.75rem]"
        }`}
      >
        Sonor
        <span className="relative inline-block">
          ı
          <span className="absolute left-1/2 top-[0.05em] h-[0.22em] w-[0.22em] -translate-x-1/2 rounded-full bg-accent" />
        </span>
        za
      </span>
    </span>
  );
}
