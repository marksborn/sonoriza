# AUDIOBOOK-02 — Gate C: trocar manualmente o capítulo de um livro já vinculado

Issue principal: [#489](https://github.com/marksborn/sonoriza/issues/489). Este gate está empilhado no Draft PR #491 (Gate B) e **não deve ser mergeado/deployado nem ativado** sem aprovação expressa.

## Objetivo exato

- O livro **inteiro** continua sendo um item opaco já adicionado pelo próprio usuário à playlist Spotify.
- O Sonoriza altera **somente os metadados locais** `selectedChapterId`, `chapterDurationMs`, `selectionMode` e `manualConsumedMs` de um `TargetAudiobookOverlay` já existente.
- O livro escolhido permanece o mesmo. Não existe botão "próximo capítulo" que avance no player; a troca de capítulo dentro do Spotify e o ponto de reprodução **sempre são manuais**.
- A duração total do livro não substitui a do capítulo no planejamento, e `providerDurationMs` é preservado sem inventar valores.
- Gate C não ativa o planner nem cria itens MUSIC/PODCAST para o livro.

## API/UI opt-in

- Página existente `/dashboard/configuracao/audiolivros`: quando `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`, lista vínculos já existentes para o usuário autenticado, com livro e capítulo atuais e a revisão.
- O capítulo novo é selecionado da **mesma obra**, via catálogo Spotify de leitura.
- `POST /api/audiobooks/manual-chapter-preview`: exige `auth()`, same-origin, formato estrito e UI em PREVIEW. Verifica usuário/destino, revisão atual, livro do overlay no banco e capítulo no catálogo; recalcula orçamento. **Não grava nada.**
- `POST /api/audiobooks/manual-chapter-update`: exige `auth()`, same-origin, confirmação `CONFIRMAR_TROCA_MANUAL_CAPITULO` e **três flags ACTIVE**:
  - `AUDIOBOOK02_CHAPTER_UPDATE_MODE=ACTIVE`
  - `AUDIOBOOK02_BIND_MODE=ACTIVE`
  - `AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE`
- Flags permanecem **OFF por padrão**. Não alterar configurações de produção neste gate.

### Exemplo do corpo de atualização (somente documentação)

```json
{
  "targetPlaylistId": "<id local do Sonoriza>",
  "expectedRevision": 0,
  "selectedChapterId": "71PKNrJrxgaYwUY6srGQ3L",
  "selection": {"mode": "FULL_CHAPTER"},
  "confirmation": "CONFIRMAR_TROCA_MANUAL_CAPITULO"
}
```

Para progresso manual usar `selection: {mode: "MANUAL_REMAINDER", consumedMs: 5000}`; o tempo consumido é declarado pelo usuário, não recebido do player.

**Nunca** aceitar `userId`, `spotifyAudiobookId`, `spotifyPlaylistId`, `chapterDurationMs` ou `revision` do corpo. O servidor carrega as identidades reais do overlay autenticado. IDs de capítulos diferentes da obra vinculada são bloqueados pela verificação `GET /audiobooks/{id}` e `GET /chapters/{id}`.

## Concorrência, integridade e histórico

1. Ler o overlay por usuário + target; validar `expectedRevision`, identidade da playlist persistida, destino FIXED e duração.
2. Buscar livro/capítulo somente via **GET** e aplicar o cálculo puro do Gate A. Erro Spotify/mercado, capítulo indisponível, capítulo terminado ou duração excessiva: não gravar.
3. Abrir `withAudiobookOverlayBindAdmission`, adquirindo o **mesmo fence transacional** utilizado pelo writer Spotify e impedindo writes remotos ativos ou incertos; verificar que o destino mantém o mesmo ID Spotify e o mesmo orçamento FIXED.
4. Executar update condicional com `userId`, ID do overlay, livro, playlist e `revision = expectedRevision`. Incrementar `revision` atomicamente; alteração velha ou idempotente sem mudança real deve ser rejeitada.
5. Na mesma transação, criar `TargetAudiobookChapterChange` com capítulo anterior, novo, consumo manual, duração e versões antiga/nova. Falha do audit implica rollback do update.
6. Responder `UPDATED_LOCAL_ONLY` após COMMIT; não fazer GET ou WRITE de itens de playlist.

Nova migração **aditiva** `20261017112500_audiobook_manual_chapter_gate_c`: campo `revision` com default 0 no overlay e tabela de histórico com unicidade `(overlayId, revision)`.

## Limitações a resolver antes de lançamento

- Spotify Audiobooks API pode não disponibilizar dados para a conta/país; sem catálogo validado, não habilitar atualização manual, nem tentar adivinhar a duração pelo item opaco.
- Falta auditar edição e exclusão de destinos com overlay ativo. Uma mudança de `target.spotifyPlaylistId` resulta em **bloqueio** no Gate C, mas não impede a própria edição noutro fluxo. Tratar em gate de governança.
- A revisão numérica evita sobrescritas concorrentes do capítulo local; não constitui sincronização com a posição real do player.
- Se o usuário trocar o livro completo no Spotify, isso NÃO autoriza editar `spotifyAudiobookId` por este endpoint: precisa de novo fluxo de desvincular/revincular com reconciliação.
- Gate C **não** modifica a rotina do planner para usar o novo capítulo; a aplicação do orçamento virtual será feita no Gate D e apenas mediante autorização.

## Critérios de validação

- [x] Contrato de seleção explícita, confirmação e versão: testado.
- [x] Novos endpoints separados de prévia e atualização, OFF por padrão.
- [x] Página de configuração exibe vínculos e editor manual com confirmação.
- [x] Persistência de revision e trilha de auditoria, na mesma transação.
- [x] Testes de integração em PostgreSQL descartável com Spotify GET mockado escritos.
- [ ] GitHub Actions: schema, migração, testes e `npm run typecheck` confirmados verdes.
- [ ] Teste humano visual em ambiente isolado de homologação.
- [ ] Nenhum merge/deploy/migração produtiva, escrita Spotify ou ativação autorizados.

## Dependências

Gate A — PR #490; Gate B — PR #491, incluindo correção do TypeScript no seletor do link Spotify. A aprovação de Gate C depende da estabilidade dos gates anteriores. O estado seguro segue **Draft/sem ativação**.
