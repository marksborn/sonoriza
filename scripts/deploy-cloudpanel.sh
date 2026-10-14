#!/usr/bin/env bash
# Sonoriza — deployment comprovado no srv914260 (CloudPanel + PM2).
# Como root: bash /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br/scripts/deploy-cloudpanel.sh [commit-obrigatorio]
# NUNCA executar Git/npm/Prisma/PM2 como root. NUNCA carregar /root/.nvm.
set -Eeuo pipefail

SITE_USER="itsoft-sonoriza"
SITE_HOME="/home/itsoft-sonoriza"
APP="$SITE_HOME/htdocs/sonoriza.itsoft.com.br"
NODE_BIN="$SITE_HOME/.nvm/versions/node/v24.19.0/bin"
PM2_HOME="$SITE_HOME/.pm2"
SERVICE="pm2-itsoft-sonoriza.service"
HEALTH_URL="http://127.0.0.1:3005/"
REQUIRED_ANCESTOR=""
if [[ "$#" -ge 1 ]]; then
  REQUIRED_ANCESTOR="$1"
fi

error() {
  printf >&2 '[Sonoriza deploy] ERRO: %s\n' "$*"
  exit 1
}
note() {
  printf '[Sonoriza deploy] %s\n' "$*"
}

# Preserva autenticação Git/SSH da sessão, mas remove NVM/XDG herdados do root.
site() {
  runuser -u "$SITE_USER" -- env \
    -u NVM_DIR -u XDG_CONFIG_HOME -u XDG_CACHE_HOME \
    HOME="$SITE_HOME" USER="$SITE_USER" LOGNAME="$SITE_USER" \
    PM2_HOME="$PM2_HOME" PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}
in_app() {
  site bash -c 'cd "$1"; shift; exec "$@"' _ "$APP" "$@"
}

[[ "$(id -u)" -eq 0 ]] || error "Execute este script como root pelo terminal do CloudPanel."
[[ -d "$APP/.git" ]] || error "Repositório Git não encontrado em $APP."
[[ -x "$NODE_BIN/node" && -x "$NODE_BIN/npm" && -x "$NODE_BIN/pm2" ]] ||
  error "Node/npm/PM2 não encontrados em $NODE_BIN. Verifique a instalação ANTES do deploy."

note "Node do usuário do site: $(site "$NODE_BIN/node" --version)"
note "PM2_HOME: $PM2_HOME"
branch="$(site git -C "$APP" branch --show-current)"
[[ "$branch" == "main" ]] || error "Branch atual '$branch'. Esperado: main."

# Ignora SOMENTE arquivos untracked (.env.backup-*, etc.). Nunca apaga ou
# sobrescreve backups; alterações rastreadas ou staged exigem intervenção.
site git -C "$APP" diff --quiet ||
  error "Alterações locais em arquivos rastreados; não aplicar merge."
site git -C "$APP" diff --cached --quiet ||
  error "Alterações staged; não aplicar merge."

note "Buscando a main remota como $SITE_USER..."
site git -C "$APP" fetch --no-tags origin main
remote_sha="$(site git -C "$APP" rev-parse --verify origin/main)"
if [[ -n "$REQUIRED_ANCESTOR" ]]; then
  site git -C "$APP" merge-base --is-ancestor "$REQUIRED_ANCESTOR" "$remote_sha" ||
    error "A main remota ($remote_sha) não contém o commit obrigatório $REQUIRED_ANCESTOR."
fi

note "Atualizando sem reset, stash ou sobrescrita de backups..."
site git -C "$APP" merge --ff-only origin/main
deployed_sha="$(site git -C "$APP" rev-parse HEAD)"
note "Código verificado: $deployed_sha"

note "Dependências, migrações, TypeScript e build com Node 24..."
in_app npm ci
in_app npm run db:deploy
in_app npm run typecheck
in_app npm run build

note "Reiniciando o serviço PM2 do usuário do site..."
systemctl restart "$SERVICE"
systemctl is-active --quiet "$SERVICE" ||
  error "Serviço $SERVICE não ficou ativo."
site "$NODE_BIN/pm2" status sonoriza

healthy=0
for attempt in {1..15}; do
  if curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" -eq 1 ]] ||
  error "PM2 reiniciado, mas não foi possível validar HTTP em $HEALTH_URL; inspecione os logs."

note "DEPLOY OK — $deployed_sha — serviço ativo e HTTP local acessível."
note "Configurações .env, flags de Reserva e backups não foram modificados."
