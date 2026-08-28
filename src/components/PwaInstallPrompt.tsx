"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";

type InstallChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
};

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

type InstallState = "checking" | "browser" | "installed";

function isStandaloneDisplay() {
  if (typeof window === "undefined") return false;

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((window.navigator as NavigatorWithStandalone).standalone)
  );
}

export function PwaInstallPrompt() {
  const pathname = usePathname();
  const [installState, setInstallState] = useState<InstallState>("checking");
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showFallback, setShowFallback] = useState(false);

  useEffect(() => {
    if (isStandaloneDisplay()) {
      setInstallState("installed");
      return;
    }

    setInstallState("browser");

    const displayMode = window.matchMedia("(display-mode: standalone)");

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setShowFallback(false);
    };

    const handleInstalled = () => {
      setDeferredPrompt(null);
      setShowFallback(false);
      setInstallState("installed");
    };

    const handleDisplayModeChange = () => {
      if (isStandaloneDisplay()) handleInstalled();
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    displayMode.addEventListener?.("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      displayMode.removeEventListener?.("change", handleDisplayModeChange);
    };
  }, []);

  const requestInstall = useCallback(async () => {
    if (!deferredPrompt) {
      setShowFallback(true);
      return;
    }

    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;

    // beforeinstallprompt is one-shot. A future eligible event can repopulate it.
    setDeferredPrompt(null);

    if (choice.outcome === "dismissed") {
      setShowFallback(true);
    }
  }, [deferredPrompt]);

  if (
    installState !== "browser" ||
    !pathname?.startsWith("/dashboard")
  ) {
    return null;
  }

  return (
    <>
      <div className="fixed bottom-[4.65rem] right-3 z-[55] sm:bottom-7 sm:right-[9.4rem]">
        <button
          type="button"
          onClick={requestInstall}
          className="inline-flex items-center gap-1.5 rounded-xl border border-accent/45 bg-accent px-3 py-2 text-xs font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400 sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm"
          aria-haspopup={deferredPrompt ? undefined : "dialog"}
        >
          <UiIcon name="plus" size={18} />
          Instalar
        </button>
      </div>

      {showFallback ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
        >
          <div className="product-panel w-full max-w-md p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="product-icon-tile-accent">
                <UiIcon name="plus" size={21} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                  Instalar aplicativo
                </p>
                <h2
                  id="pwa-install-title"
                  className="mt-1 text-xl font-black text-ink-inverse"
                >
                  Instalar o Sonoriza
                </h2>
              </div>
            </div>

            <p className="mt-4 text-sm leading-6 text-muted-inverse">
              Este navegador não disponibilizou o prompt automático agora. Você
              ainda pode instalar pelo menu do navegador.
            </p>

            <div className="mt-4 rounded-2xl border border-line-dark/60 bg-surface-subtle/70 p-4 text-sm leading-6 text-ink-inverse">
              <p className="font-black">No Vivaldi para Android:</p>
              <p className="mt-1 text-muted-inverse">
                Menu → Adicionar página a → Tela inicial → Instalar.
              </p>
              <p className="mt-3 text-xs text-muted-inverse">
                Se aparecer apenas “Criar atalho”, o navegador ainda não está
                reconhecendo o site como instalável. Nesse caso, não tratamos o
                atalho como instalação concluída.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowFallback(false)}
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl border border-line-dark/70 bg-surface-elevated px-4 py-3 text-sm font-black text-ink-inverse transition hover:border-brand-400/55 hover:bg-surface-subtle"
            >
              Fechar
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
