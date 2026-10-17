# AUDIOBOOK-02 — Gate D.1: shadow do orçamento virtual no planejador

Issue: #489. PRs empilhados: Gate A #490 → B #491 → C #492 → **Gate D.1**.

## Objetivo entregue

Uma playlist FIXED de 5 minutos pode conter no Spotify um **único livro inteiro** com aproximadamente 15 horas. Como o Spotify Web API devolveu `item=null` para esse item e as APIs de audiolivros são restritas por mercado, o Sonoriza **não consegue comprovar o conteúdo remoto nem comandar capítulos**. A solução do Gate D.1 é permitir uma **projeção local/simulada**, considerando somente o capítulo previamente selecionado no overlay manual (Gate C), sem substituir o item remoto, sem criar um candidato de música/podcast fictício e sem declarar que a playlist foi escrita.

Exemplo com *1984*:
- Capítulo selecionado: Apresentação, **20.039 ms**.
- Duração alvo: **300.000 ms**.
- Orçamento restante para candidatas tradicionais: **279.961 ms**.
- Se duas músicas elegíveis e de fontes autorizadas somam **270.000 ms**, total virtual projetado **290.039 ms**, saldo **9.961 ms**.
- A playlist Spotify permanece com o livro inteiro; **não há inclusão automática das músicas projetadas**.

## Implementação

### Motor puro `src/services/audiobooks/gate-d-shadow-planner.ts`

`projectAudiobookVirtualChapterPlan` recebe SOMENTE dados da aplicação fornecidos pelo caller autenticado/orquestrador: overlay, destino, regras e pools candidatos já coletados.

- Revalida `userId`, destino e o Spotify playlist ID exato do overlay, revisão, modo, progresso e teto de duração.
- Chama `calculateAudiobookVirtualDuration` do Gate A.
- Restringe **deliberadamente** a `FIXED` + `MANUAL` + `PROPORTION`. Recusa `CALENDAR`, `SEQUENCE`, `KEEP_FILLED` e `REBUILD_DAILY`, que têm invariantes de ordem, conservação ou política de tempo que exigem outro gate.
- Filtra candidatas exclusivamente com `sourcePlaylistId` comprovadamente dentro da seleção efetiva de fontes do destino e suprime identidades musicais bloqueadas. Candidatas sem proveniência explícita não entram nesta projeção.
- Chama o seletor **puro existente** `planPlaylist` com orçamento restante, sem mutar pools/regras originais, `strictDurationBoundary=true`.
- Se algum dado é ambíguo, retorna `ABSTAIN` e não gera pseudo-mídia.
- `READY_SHADOW` fornece capítulo, tempo virtual, saldo, duração e URIs adicionais projetadas. **Nunca** é elegível para aprovação de geração real: `plannerInfluence=false, spotifyWrites=false, approvalEligible=false`.
- Não calcula posição do player, não busca o item opaco e não tem código de escrita Spotify.

### Integração na execução `src/jobs/generate-playlists-incremental.ts`

- Sempre consulta overlays para os destinos da execução, inclusive em simulações normais.
- **Real run + um destino protegido:** finaliza `FAILED` antecipadamente, antes da leitura de fontes e **antes de escrever em QUALQUER destino do lote**. Isso fecha o risco de uma escrita parcial em outro destino seguida de bloqueio da playlist opaca no writer.
- Simulação com overlay protegido: `summary.qualityPassed=false` para impedir que uma simulação que ignora o item remoto produza aprovação CONFIG-04 enganosa, ainda que `AUDIOBOOK02_PLANNER_MODE=OFF`.
- Quando `simulate=true` **e** `AUDIOBOOK02_PLANNER_MODE=SHADOW`, avalia a projeção a partir de `incremental.pools` após a coleta já existente e escreve apenas em `generationRun.summary.audiobookGateD` (metadados locais de auditoria).
- O `incremental.plan` canônico, `GenerationItem` original, regras de qualidade e qualquer payload de escrita de playlist **não são substituídos**. O preview é experimental, não é o plano real de entrega.
- Flag `AUDIOBOOK02_PLANNER_MODE` OFF por padrão; `ACTIVE` não está implementado nem autoriza Spotify. **NÃO ativar em produção**.

## Restrições / próximas etapas antes de um produto ativo

1. Garantir que editar/excluir destinos com overlay não altere a identidade do Spotify protegida. Gate de governança pendente.
2. Provar presença/posição do audiolivro opaco no Spotify por meios suportados, ou exigir confirmação manual mais reconciliação de snapshot e uma estratégia de escrita externa **sem substituir o livro**. Como o objeto permanece opaco, esta validação pode ser tecnicamente inviável com a API pública.
3. Planejamento de outros conteúdos é só projeção de suficiência, **não garantia de que músicas sejam enviadas** nem de que o Spotify vá parar ao atingir 5 minutos.
4. Regra de composição PROPORTION aplica-se ao orçamento restante; o audiobook não altera contadores MUSIC/PODCAST (não é nenhum dos dois).
5. Incorporar autorização multi-destino, duração variável, SEQUENCE, descoberta/reserva, qualidade global, condições de compartilhamento, resultados reais e manutenção de playlist sem perder o item opaco exigirá gates independentes.
6. A duração virtual não equivale à duração que o Spotify exibe na playlist.

## Testes e CI

- `gate-d-shadow-planner.test.ts` protege 300.000 - 20.039 = 279.961, progresso manual, limites, fontes, modos não suportados, soma da projeção e ausência de escrita.
- `.github/workflows/audiobook-02-gate-d.yml` usa PostgreSQL descartável, `prisma validate`, `migrate deploy`, todos os testes A/B/C/D e `npm run typecheck`.
- [ ] Validação completa da PR/commit atual.
- [ ] Testes manuais do resumo de simulação em homologação com conta de mercado suportado.
- [ ] Liberação, merge, deploy, migração produtiva e writes Spotify: **nenhum autorizado**.

Critério central: se o suporte automático depender de comandar uma playlist com audiolivro opaco, **não escrever** e não disfarçar a limitação com um candidato sintético.
