"use client";

import { useFormStatus } from "react-dom";

type CleanupSubmitButtonProps = {
  removableTrackCount: number;
};

export function CleanupSubmitButton({
  removableTrackCount,
}: CleanupSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      aria-live="polite"
      className="rounded-xl border border-red-200/30 bg-red-500/20 px-4 py-2.5 text-sm font-black text-red-50 transition hover:bg-red-500/30 disabled:cursor-wait disabled:opacity-60"
    >
      {pending
        ? `Removendo ${removableTrackCount} faixa(s)...`
        : `Confirmar remoção de ${removableTrackCount} faixa(s)`}
    </button>
  );
}
