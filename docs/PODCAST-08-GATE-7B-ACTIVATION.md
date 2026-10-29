# PODCAST-08 Gate 7B — ativação das faixas de duração (#365)

## O que muda
- `PODCAST08_PRODUCTIVE_WRITES=APPROVED` é a terceira chave, separada das outras. Junto com
  `PODCAST08_ACTIVE_MODE=ACTIVE` e o ID do destino em `PODCAST08_ACTIVE_TARGET_IDS`,
  as gerações reais (manual e agendada) usam o seletor por faixa no Spotify.
- Sem as três chaves, nada muda: o Gate 7 continua falhando, antes de qualquer
  leitura ou escrita, as gerações reais de destinos com faixa salva ou pedido ACTIVE.
- Com aprovação, uma simulação com faixas vira evidência válida para o CONFIG-04,
  porque o run real usa o mesmo seletor.
- Fail-closed novo (`BLOCKED_BANDS_NOT_HONORED`): se um destino aprovado tem
  faixas mas o planner não as aplicou (calendário por evento, programa com ordem
  estrita/sequencial, limites inválidos), o run real falha antes da primeira
  escrita e a playlist fica como estava.
- O editor de faixas abre **somente** nos destinos que cumprem as três chaves e
  `PODCAST08_DURATION_EDITOR_ENABLED=1`. Os outros destinos não conseguem salvar
  faixa (servidor e UI), para não travar o Carro, a Academia etc.

## Limites
- Funciona só em destinos de bloco único (duração fixa ou calendário somado).
  Destinos por evento do calendário (CALENDAR-03/04) ficam fora.
- Fallback por slot: `SHORT → MEDIUM → ANY`, `MEDIUM → SHORT → LONG → ANY`,
  `LONG → MEDIUM → ANY`. Sem candidato, a sequência termina naquele slot.
- A divergência 11 → 25 itens vista no SHADOW de 20/10 não foi investigada item
  por item. Simule e revise antes de ligar.

## Ativação do piloto (Trabalho)
1. Deploy normal.
2. No `.env`: `PODCAST08_ACTIVE_MODE=ACTIVE`, `PODCAST08_ACTIVE_TARGET_IDS=<id do Trabalho>`,
   `PODCAST08_PRODUCTIVE_WRITES=APPROVED`, `PODCAST08_DURATION_EDITOR_ENABLED=1`, depois
   `systemctl restart pm2-itsoft-sonoriza.service`.
3. Em Destinos → Trabalho, escolher as faixas e salvar. Simular e revisar.
4. A próxima geração do Trabalho (07:00, REBUILD_DAILY) usa as faixas.

Rollback: remover `PODCAST08_PRODUCTIVE_WRITES` e reiniciar. Com as faixas ainda
salvas, o Gate 7 volta a falhar o Trabalho de propósito. Para voltar ao legado sem
falha, volte as faixas para "Qualquer duração" **antes** de remover a chave.
