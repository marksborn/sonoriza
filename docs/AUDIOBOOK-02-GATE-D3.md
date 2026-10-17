# AUDIOBOOK-02 — Gate D.3: avaliação de adição e entrega SOMENTE MANUAL

Issue #489; PR empilhada em Gate D.2 #494 → D.1 #493 → C #492 → B #491 → A #490. **Não há merge, deploy, alteração Spotify, nem liberação de writes automáticos.**

## Conclusão técnica da API Spotify (documentação consultada em 17/10/2026)

| Operação | Documentação oficial | Propriedade relevante |
|---|---|---|
| `GET /playlists/{id}/items` | https://developer.spotify.com/documentation/web-api/reference/get-playlists-items | Descreve item do tipo track/episode. Livro adicionado no cliente Spotify apareceu `item=null`, `uri=null` no experimento. A API não comprova que o item opaco é aquele audiobook. |
| `POST /playlists/{id}/items` | https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist | Documenta inclusão de URIs de **track ou episode**, com inserção em posição especificada ou append se `position` omitida. Não documenta parâmetro `snapshot_id` para condicionamento atômico do append. **Não é uma operação de leitura nem garantia de identidade do item opaco.** |
| `PUT /playlists/{id}/items` | https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items | Substitui inteiramente ou reordena itens conforme parâmetros. Uso de `uris` substitui a lista existente; seria perigoso para um audiobook não representável pela API. |
| Snapshots | https://developer.spotify.com/documentation/web-api/concepts/playlists | Identificam versões e podem ajudar com concorrência em endpoints que os aceitam, mas um snapshot estável não identifica `item=null` nem acrescenta uma condição CAS ao POST de append. |

**Conclusão:** o append tem semântica menos destrutiva que replace, mas não atende à garantia de não impactar um audiobook opaco que o Sonoriza não consegue identificar ou verificar após a operação. **Gate D.3 não implementa chamada de escrita.** NUNCA sugerir que o add `POST` é comprovadamente seguro nesse caso.

## Produto entregue: lista para adição manual ao Spotify

`src/services/audiobooks/manual-handoff-assessment.ts`: função pura `assessAudiobookManualHandoff`.

- Recebe os dados atuais do destino, overlay, um `GenerationRun` de simulação SHADOW e um snapshot remoto lido por GET, com o horário de avaliação.
- Confere ownership, playlist ID, `FIXED+MANUAL+PROPORTION`, revisão e capítulo.
- A simulação deve ter concluído com SUCCESS **na última hora**, com `collectionComplete=true`, `inconclusive=false`, `simulate=true`, `audiobookGateDSimulationOnly=true` e evidência `READY_SHADOW` para **somente aquele destino**. O flag de aprovação segue `false`.
- Recalcula com a calculadora pura do Gate A a duração do capítulo efetivamente vinculado. Compara milissegundos de capítulo, saldo, duração total, progresso e revisão com os valores previamente calculados.
- Aceita até 100 itens de complemento `spotify:track:{id}` ou `spotify:episode:{id}`, nunca `spotify:audiobook`. Rejeita URIs falsas, duplicatas e itens que já constam na lista remota **legível**.
- Snapshot remoto deve estar estável e conter ao menos um item opaco que o usuário possa inspecionar pessoalmente. Mesmo assim, `audiobookIdentityVerified=false` e `authorizedForAutomaticWrite=false`.
- A resposta válida tem `status=MANUAL_HANDOFF_ONLY`, duração virtual, saldo, links do Spotify para cada candidato e para a playlist. Não existe comando de adicionar, reorder, remove, nenhuma permissão de escrita e nenhum token de preflight.
- Qualquer dúvida: `status=BLOCKED` com razão específica, sem plano executável.

`POST /api/audiobooks/manual-handoff`: endpoint somente de consulta e **owner-scoped**, com sessão, validação same-origin, corpo `{targetPlaylistId,expectedRevision}` e duas flags `AUDIOBOOK02_BIND_UI_MODE=PREVIEW` + `AUDIOBOOK02_PLANNER_MODE=SHADOW`. Padrão **OFF**.
- Consulta até 30 simulações SUCCESS recentes do usuário, seleciona a mais nova com shadow válido do destino. Se nenhuma existir, informa que precisa de simulação.
- Busca o snapshot playlist com `SpotifyClient.getTargetPlaylistState` (GET, snapshot antes/depois e leitura paginada). Revalida user, destino e TODOS os campos do vínculo após a consulta.
- Não escreve em DB além dos GET/read-states já existentes nem chama o Spotify para mutação.

UI na página de audiolivros: botão **Avaliar lista manual da simulação**, tempo do capítulo, complementos e saldo, itens com links diretos, aviso insistente para conferir manualmente a presença do livro e controlar o capítulo/reprodução. **Não há botão de aplicar ou autorizar.**

## Exemplo: 1984

- Duração alvo configurada: 300.000 ms (5 min).
- Capítulo *Apresentação* no vínculo: 20.039 ms.
- Tempo virtual livre: 279.961 ms.
- Exemplo hipotético: duas candidatas com duração combinada 270.000 ms → total virtual 290.039 ms, saldo de 9.961 ms.
- O Spotify continuará mostrando o livro inteiro (cerca de 15h), independentemente do tempo virtual no Sonoriza. **A reprodução não para aos 5min automaticamente.** A mudança de capítulo e inclusão das músicas/episódios são manuais.

## Restrições ativas (nenhuma foi enfraquecida)

- Gate B: `TargetAudiobookWriteFence` e guarda do transporte Spotify continuam negando mutações no destino com overlay.
- Gate D.1: geração real em lote com overlay bloqueada antes de tocar QUALQUER playlist Spotify.
- Gate D.2: edição de destino bloqueada no vínculo; desativação é segura.
- `AUDIOBOOK02_PLANNER_MODE=ACTIVE` não é suportado.
- Resultado `MANUAL_HANDOFF_ONLY` nunca se torna aprovação CONFIG-04, nem autorização para Spotify Write.
- Um vínculo local + `item=null` não significa verificação de identidade do audiobook remoto.
- No mercado BR, as APIs de catálogo de audiolivros podem não estar disponíveis; não inventar títulos, duração ou progresso ao falharem.

## Testes e pendências

- [x] Serviço puro com seleção de simulação válida, validação contra orçamento e relatório manual sem writer.
- [x] Rota de leitura com owner+same-origin+read-stability e revisão de vínculo após GET.
- [x] UI experimental sem botão de escrita, apenas links para operação humana.
- [x] Testes negativos: run vencido/falho, outra conta, destinação alterada, novo capítulo, orçamento incongruente, item opaco ausente, item duplicado e URI inválida.
- [ ] CI final: PostgreSQL descartável, Gates A/B/C/D/D.2/D.3, typecheck e regressões.
- [ ] Homologação visual e reais limites da API Spotify por mercado.
- [ ] Revisão arquitetural futura de operações externas sem acesso ao item opaco. **Nunca inferir que serão possíveis.**
- [ ] Aprovação explícita para qualquer merge/deploy/migração produtiva/ativação.

Esta etapa é uma alternativa útil e reversível ao risco da mutação automática: o usuário abre Spotify, confere o livro inteiro e adiciona manualmente as sugestões. Sonoriza não afirma que o Spotify cumprirá o limite virtual de 5 minutos.
