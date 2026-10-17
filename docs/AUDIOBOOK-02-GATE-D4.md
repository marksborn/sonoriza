# AUDIOBOOK-02 — Gate D.4: ensaio ponta a ponta OFFLINE + roteiro de homologação REAL

Issue #489; branch empilhada em Gate D.3 #495 → D.2 #494 → D.1 #493 → C #492 → B #491 → A #490.

**A implementação e CI deste gate NÃO representam homologação com uma conta Spotify real, nem concedem permissão para writes.** Sem merge, sem deploy, sem migrações produtivas, sem modificações de playlists ou configurações reais.

## Limite oficial confirmado em 17/10/2026

As documentações do Spotify:
- [Get an Audiobook](https://developer.spotify.com/documentation/web-api/reference/get-an-audiobook)
- [Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)

declaram audiolivros/capítulos disponíveis apenas nos mercados **US, UK, Canada, Ireland, New Zealand e Australia**. Códigos: **US, GB, CA, IE, NZ, AU**. Mercado **BR** não consta. O mercado efetivo é o **da conta Spotify**, não a localização geográfica, idioma, endereço IP do usuário nem presença de audiolivro no aplicativo. Resultado 403, 404, 429 ou falha GET também pode resultar de acesso, permissão, mercado ou infraestrutura; **não inferir causa única**.

Playlist GET pode devolver \`item=null\` para livro inteiro; snapshot estável comprova apenas uma versão lida. Não identifica o livro nem permite inserir com segurança no destino. [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

## Entrega técnica

### Motor de homologação *somente fixture*

\`src/services/audiobooks/d4-offline-homologation.ts\`

\`rehearseAudiobookManualFlowOffline\` recebe configuração já obtida, um **leitor de catálogo injetado** e um estado Spotify **simulado**:
1. Verifica mercado de conta declarado **apenas pela fixture**; mercado ausente ou fora dos seis documentados bloqueia o fluxo antes de chamar sequer o leitor simulado.
2. Executa as funções de PRODUÇÃO \`loadAudiobookChapterList\` e \`assertSpotifyAudiobookChapterEvidence\` contra GETs simulados. Exige capítulo único/listado, identidade do livro, status reproduzível e duração consistente.
3. Executa o **planejador puro real** do Gate D.1 \`projectAudiobookVirtualChapterPlan\` com fontes pertencentes ao destino.
4. Constrói em memória (não salva) o formato de um resumo SHADOW. Ele é **simulated-only**, \`qualityPassed=false\`, \`approvalEligible=false\`, \`spotifyWrites=false\`. Não cria geração real.
5. Executa o avaliador real do Gate D.3 \`assessAudiobookManualHandoff\` contra um snapshot falso mas estável, sem assumir que \`item=null\` é o livro.
6. Retorna \`PASS_OFFLINE_MANUAL_ONLY\` ou \`BLOCKED_OFFLINE\`, e **sempre** \`fixtureOnly=true\`, \`realSpotifyAvailabilityVerified=false\`, \`remoteAudiobookIdentityVerified=false\`, \`productionApproved=false\`, \`spotifyWrites=false\`.

**Nunca importar no runtime da aplicação**: este módulo é dedicado a testes/ensaios offline. Não constrói token, não chama \`fetch\`, não usa o servidor Spotify e não aplica nada.

### Testes de integração/experiência

\`d4-offline-homologation.test.ts\`:
- Mercado documentado US: catálogo 1984 → capítulo Apresentação 20.039 ms → planner de 300.000 ms → 279.961 ms livres → duas músicas de 270.000 ms → sobra 9.961 ms, checklist manual com links.
- Mercado BR: bloqueado **antes de GET simulado**; não confundir localidade com configuração da conta.
- Catálogo negado e capítulos inconsistentes, pertencendo a outro livro, capítulo não reproduzível, ausência de item opaco, snapshot inválido, destino alterado, duração excessiva: **fail closed**.
- Usa PostgreSQL 16 descartável para persistir **User + TargetPlaylist + TargetAudiobookOverlay reais** e relê-los com Prisma. Os GETs de Spotify permanecem mocks, sem credencial/tokens.
- Usa **renderToStaticMarkup** na interface para garantir instruções de inclusão manual e que não exista botão aplicar no Spotify. Essa renderização **não** é teste browser/end-to-end de interação.
- A estrutura dos endpoints SHADOW, fence e ausência de chamadas de escrita é testada contra arquivos reais do repo.

\`d4-preview-guidance.ts\`: mensagens visíveis e acionáveis para mercado potencialmente indisponível, SHADOW vencido, snapshot inconclusivo, revisão alterada, lista duplicada. Não alega conhecer o país real da conta. UI mostra limite conhecido.

## Matriz de validação **real** — pendente de execução humana autorizada

**Pré-condições**: homologação isolada, usuário proprietário, credenciais Spotify da pessoa que fará o teste, playlist de testes SEM conteúdo essencial e sem qualquer write automático; não reutilizar a playlist real do livro 1984. **As flags ficam OFF em produção.** Para tornar a UI visível SOMENTE na homologação, requer aprovação posterior da equipe:

- \`AUDIOBOOK02_BIND_UI_MODE=PREVIEW\`
- \`AUDIOBOOK02_PLANNER_MODE=SHADOW\`
- \`AUDIOBOOK02_BIND_MODE=OFF\`
- \`AUDIOBOOK02_WRITE_FENCE_MODE=OFF\` (o guard de escrita existente continua obrigatório)
- \`AUDIOBOOK02_CHAPTER_UPDATE_MODE=OFF\`

Estes valores devem ser configurados **só no ambiente dedicado de testes**, após autorização; não ativar as flags pela execução do PR.

| Teste real | Critério | Status |
|---|---|---|
| Identificar **mercado da conta Spotify** pelo perfil/configuração oficial | Mercado real documentado; não inferir da região física | **Pendente** |
| \`GET /audiobooks/{id}\` | 200 válido ou erro observado; registrar código sem guardar token | **Pendente** |
| \`GET /chapters/{id}\`, lista de capítulos | Identidade do livro, duração, playable; falhas bloqueiam | **Pendente** |
| \`GET /playlists/{id}/items\` com snapshot antes/depois | Item opaco observado; nunca inferir ID do livro | **Pendente** |
| Criar simulação manual do destino 5min | \`READY_SHADOW\` ou ABSTAIN fundamentado | **Pendente** |
| Ver lista de inclusão manual | \`MANUAL_HANDOFF_ONLY\` com links, sem alterar Spotify | **Pendente** |
| Atualizar capítulo/revisão após simulação | Lista anterior deve bloquear e exigir nova simulação | **Pendente** |
| Desativar destino | Deve preservar livro inteiro, sem write Spotify | **Pendente** |
| Confirmar visualmente a playlist no Spotify | Audiolivro intacto; reprodução e capítulo manuais | **Pendente** |
| Confirmar ausência de writes provider em logs | Zero POST/PUT/DELETE em playlist de testes | **Pendente** |
| UI Chrome/Android, leitura de erros, responsividade | Browser E2E visual não executado por este CI | **Pendente** |

Não existem dados obtidos de uma conta Spotify real neste Gate D.4. Se o catálogo de audiolivros estiver indisponível no mercado da conta, registrar **BLOCKED_BY_PROVIDER_ACCOUNT_MARKET_OR_ACCESS**, não forçar entrada de ID/duração sem prova, não ativar produção.

## Resultado esperado de CI

- [ ] Prisma schema válido; todas migrations em PostgreSQL 16 descartável.
- [ ] Testes A/B/C/D/D.2/D.3/D.4 passam, incluindo persistência Prisma fixture, mercado, casos negativos e SSR.
- [ ] Typecheck completo sem erro.
- [ ] Demais workflows do stack empilhado, sem regressão.

**Critério de encerramento do Gate D.4:** *ensaio offline automatizado validado*, **homologação Spotify real pendente** e bloqueios de escrita preservados. Não chamar de homologação real aprovada.

## Próximo avanço recomendado

Gate D.5: auditoria independente do contrato dos endpoints/rotas sob conta real e decisão de produto baseada no mercado e nas limitações de \`item=null\`; caso não exista mecanismo remoto seguro, considerar o fluxo de audiobook definitivamente manual, sem improvisar timer nem URIs sintéticas.
