#!/usr/bin/env bash
# Deploy Sonoriza desacoplado da conexão SSH.
# Executar como root: bash .../scripts/deploy-cloudpanel-managed.sh [commit-obrigatorio]
# A unidade transient systemd e flock impedem perda por queda do SSH e corridas
# entre invocações deste launcher.
set -Eeuo pipefail

APP="/home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br"
SCRIPT="$APP/scripts/deploy-cloudpanel.sh"
LOCK="/run/lock/sonoriza-deploy.lock"

[[ "$(id -u)" -eq 0 ]] || { echo "ERRO: execute como root." >&2; exit 1; }
[[ -f "$SCRIPT" ]] || { echo "ERRO: script principal ausente: $SCRIPT" >&2; exit 1; }
command -v systemd-run >/dev/null || { echo "ERRO: systemd-run indisponível." >&2; exit 1; }
command -v flock >/dev/null || { echo "ERRO: flock indisponível." >&2; exit 1; }
[[ "$#" -le 1 ]] || { echo "Uso: $0 [commit-obrigatorio]" >&2; exit 2; }

unit="sonoriza-deploy-$(date +%Y%m%d%H%M%S)-$$"
systemd-run \
  --unit="$unit" \
  --description="Sonoriza deployment via CloudPanel" \
  --property=Type=exec \
  --collect \
  /usr/bin/flock -n "$LOCK" /bin/bash "$SCRIPT" "$@"

printf '\nDeploy iniciado em unidade independente do SSH: %s.service\n' "$unit"
printf 'Logs: journalctl -u %s.service -f --no-pager\n' "$unit"
printf 'Conclusão: procure a mensagem "DEPLOY OK" nos logs.\n'
printf 'Uma queda do SSH NÃO interrompe essa unidade. Não inicie outro deploy antes de conferir o resultado.\n'
