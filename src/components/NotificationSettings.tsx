"use client";

import { useEffect, useState } from "react";

import { UiIcon } from "@/components/UiIcon";
import type { NotificationPreferencesShape } from "@/services/notifications/types";

type DeviceState =
  | "checking"
  | "unsupported"
  | "unconfigured"
  | "blocked"
  | "available"
  | "active";

type Props = {
  configured: boolean;
  publicKey: string | null;
  initialPreferences: NotificationPreferencesShape;
  initialActiveDeviceCount: number;
};

export function NotificationSettings({
  configured,
  publicKey,
  initialPreferences,
  initialActiveDeviceCount,
}: Props) {
  const [deviceState, setDeviceState] = useState<DeviceState>("checking");
  const [preferences, setPreferences] = useState(initialPreferences);
  const [activeDeviceCount, setActiveDeviceCount] = useState(initialActiveDeviceCount);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void detectDeviceState(configured, publicKey).then(setDeviceState);
  }, [configured, publicKey]);

  const enableNotifications = async () => {
    if (!configured || !publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setDeviceState("unsupported");
        return;
      }

      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission !== "granted") {
        setDeviceState(permission === "denied" ? "blocked" : "available");
        setMessage(
          permission === "denied"
            ? "O navegador bloqueou notificações para este site. Libere a permissão nas configurações do navegador para tentar novamente."
            : "Permissão não concedida. Nada foi registrado.",
        );
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      let response = await persistSubscription(subscription);
      if (response.status === 409) {
        await subscription.unsubscribe();
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        response = await persistSubscription(subscription);
      }
      const payload = (await response.json()) as {
        error?: string;
        activeDeviceCount?: number;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Não foi possível ativar as notificações.");
      }

      setActiveDeviceCount(payload.activeDeviceCount ?? activeDeviceCount + 1);
      setDeviceState("active");
      setMessage("Notificações ativadas neste dispositivo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao ativar notificações.");
    } finally {
      setBusy(false);
    }
  };

  const disableNotifications = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/notifications/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        const payload = (await response.json()) as {
          error?: string;
          activeDeviceCount?: number;
        };
        await subscription.unsubscribe();
        if (!response.ok) {
          throw new Error(payload.error ?? "Não foi possível remover a inscrição do servidor.");
        }
        setActiveDeviceCount(payload.activeDeviceCount ?? Math.max(0, activeDeviceCount - 1));
      }
      setDeviceState("available");
      setMessage("Notificações desativadas neste dispositivo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao desativar notificações.");
    } finally {
      setBusy(false);
    }
  };

  const savePreferences = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      const payload = (await response.json()) as NotificationPreferencesShape & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Não foi possível salvar as preferências.");
      }
      setPreferences(payload);
      setMessage("Preferências de notificação salvas.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar preferências.");
    } finally {
      setBusy(false);
    }
  };

  const stateLabel =
    deviceState === "active"
      ? "Ativo neste dispositivo"
      : deviceState === "blocked"
        ? "Bloqueado pelo navegador"
        : deviceState === "unsupported"
          ? "Não suportado neste navegador"
          : deviceState === "unconfigured"
            ? "Servidor ainda não configurado"
            : deviceState === "checking"
              ? "Verificando suporte…"
              : "Pronto para ativar";

  return (
    <div className="space-y-5">
      <section className="product-panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              Dispositivo
            </p>
            <h2 className="mt-1 text-xl font-black text-ink-inverse">Web Push</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-inverse">
              O Sonoriza só pede permissão quando você toca em “Ativar notificações”. Cada navegador/dispositivo é registrado separadamente.
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${
              deviceState === "active" ? "status-success" : deviceState === "blocked" ? "status-warning" : "product-badge"
            }`}
          >
            <UiIcon name={deviceState === "active" ? "check" : "warning"} size={14} />
            {stateLabel}
          </span>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          {deviceState !== "active" ? (
            <button
              type="button"
              disabled={busy || !configured || deviceState === "unsupported" || deviceState === "blocked"}
              onClick={enableNotifications}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UiIcon name="bell" size={17} />
              Ativar notificações
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={disableNotifications}
              className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/55 px-5 py-3 text-sm font-black text-ink-inverse transition hover:bg-surface-elevated disabled:opacity-50"
            >
              Desativar neste dispositivo
            </button>
          )}
          <span className="self-center text-sm text-muted-inverse">
            {activeDeviceCount} dispositivo(s) ativo(s) na conta
          </span>
        </div>
        {message ? <p className="mt-4 text-sm text-muted-inverse">{message}</p> : null}
      </section>

      <section className="product-panel p-6">
        <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
          Preferências
        </p>
        <h2 className="mt-1 text-xl font-black text-ink-inverse">Quando avisar</h2>
        <p className="mt-2 text-sm leading-6 text-muted-inverse">
          Simulações não geram push. “Nenhuma alteração” fica desligada por padrão para evitar ruído.
        </p>

        <div className="mt-5 space-y-3">
          <PreferenceToggle
            checked={preferences.generationEnabled}
            onChange={(generationEnabled) =>
              setPreferences((current) => ({ ...current, generationEnabled }))
            }
            title="Geração e manutenção concluídas"
            description="KEEP_FILLED, REBUILD_DAILY e geração manual real."
          />
          <PreferenceToggle
            checked={preferences.cleanupEnabled}
            onChange={(cleanupEnabled) =>
              setPreferences((current) => ({ ...current, cleanupEnabled }))
            }
            title="Limpeza concluída"
            description="Resumo da limpeza automática da inbox quando há auditoria canônica."
          />
          <PreferenceToggle
            checked={preferences.errorEnabled}
            onChange={(errorEnabled) =>
              setPreferences((current) => ({ ...current, errorEnabled }))
            }
            title="Erros e bloqueios"
            description="Falhas e gates que impediram uma execução real."
          />
          <PreferenceToggle
            checked={preferences.noopEnabled}
            onChange={(noopEnabled) =>
              setPreferences((current) => ({ ...current, noopEnabled }))
            }
            title="Nenhuma alteração necessária"
            description="Avisa quando a manutenção encontra o destino já completo."
          />
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={savePreferences}
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 transition hover:bg-accent-400 disabled:opacity-50"
        >
          <UiIcon name="check" size={17} />
          Salvar preferências
        </button>
      </section>
    </div>
  );
}

function PreferenceToggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="product-card flex cursor-pointer items-start gap-3 p-4">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-5 w-5 accent-accent"
      />
      <span>
        <span className="block font-black text-ink-inverse">{title}</span>
        <span className="mt-1 block text-sm leading-5 text-muted-inverse">{description}</span>
      </span>
    </label>
  );
}

async function detectDeviceState(
  configured: boolean,
  publicKey: string | null,
): Promise<DeviceState> {
  if (!configured || !publicKey) return "unconfigured";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription ? "active" : "available";
  } catch {
    return "unsupported";
  }
}

async function persistSubscription(subscription: PushSubscription): Promise<Response> {
  const data = subscription.toJSON();
  return fetch("/api/notifications/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: data.keys,
    }),
  });
}

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
