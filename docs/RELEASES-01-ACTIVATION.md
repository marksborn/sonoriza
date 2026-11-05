# RELEASES-01 — ativação das Novidades no planner (#161)

## Atualização automática do radar
- Roda no cron de geração, somente em um tick que não gerou nada.
- Atualiza uma vez por dia. Artistas consultados nos últimos 7 dias não geram leitura.
- Uma atualização que não salvou espera 6 horas antes de tentar de novo.
- Só roda para quem tem destino automático com Descobrir e Novidades ligados, dentro do
  rollout `DISCOVER_DEST_RUNTIME_ENABLED` + `DISCOVER_DEST_RUNTIME_USER_EMAILS`.
- `RELEASES_PLANNER_MODE=OFF` para o radar automático e a família Novidades.
  A tela Novidades e o botão manual continuam funcionando.

## Modos
- `SHADOW` (padrão): só registra na simulação o que entraria.
- `ACTIVE`: as faixas entram como candidatas no pool do destino.

Nenhuma etapa publica no Spotify por si só; a escrita continua sendo a geração normal.
`discoveryReleasesEnabled` nasce ligado: todo destino com Descobrir ligado participa, a não
ser que Novidades seja desmarcada nele.

## Sequência
1. Deploy. Confirmar que Descobrir → Novidades mostra atualização do dia.
2. Rodar a simulação e abrir Revisar e testar: a linha "Novidades" lista as faixas por destino.
3. Se a seleção fizer sentido, definir `RELEASES_PLANNER_MODE=ACTIVE` e reiniciar com
   `pm2 restart sonoriza --update-env` como `itsoft-sonoriza`.
4. Na próxima simulação, conferir "entraram como candidatas".

## Reversão
`RELEASES_PLANNER_MODE=SHADOW` e reiniciar. O teto por intensidade é 2/4/6 faixas por destino.
