# AUDIOBOOK-02 — Gate D.6: prévia inteiramente manual (dados autodeclarados)

Issue #489; PR empilhada após Gate D.5 #497 → D.4 #496 → D.3 #495 → D.2 #494 → D.1 #493 → C #492 → B #491 → A #490.

**Decisão de escopo:** em contas Spotify sem acesso documentado ao catálogo de audiolivros/capítulos (como pode ocorrer em BR), oferecer somente **uma calculadora de duração virtual e anotação manual NÃO PERSISTIDAS**. O objetivo do Gate D.6 é estudar e apresentar a alternativa sem corromper a rastreabilidade de dados Spotify do modelo `TargetAudiobookOverlay`, sem mexer no planejador, sem criar inferência de capítulo, sem redes/Spotify e sem ativar qualquer feature produtiva.

## Por que esta distinção é obrigatória

Gate A aceita `chapterDurationMs` proveniente de leitura válida do capítulo Spotify; Gate B exige verificação remota antes de registrar um overlay associado a livro e capítulo. Usar um valor de duração digitado pelo usuário como se fosse `duration_ms` validado pelo Spotify seria uma **falsa prova de origem**. O mesmo vale para um `item=null` observado numa playlist: continua impossível associá-lo automaticamente ao livro correto. Portanto, o Gate D.6 não fornece `spotifyAudiobookId`, `selectedChapterId`, `spotifyPlaylistId` nem payload de vinculação em seu resultado; a saída **NÃO PODE** alimentar a simulação SHADOW, `GenerationRun` nem o escritor Spotify.

A flag nova `AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE` é **OFF por padrão** e requer `PREVIEW`; a própria página inteira continua protegida pelo gate pré-existente `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`. Ambas devem ser aprovadas em um **ambiente isolado** antes de habilitar interface.

## Funcionalidade desenvolvida

`src/services/audiobooks/d6-self-reported-preview.ts` é uma calculadora PURA e autossuficiente:
- Campos: `targetDurationMs` para uma playlist fixa; `bookTitle`, `chapterLabel`, `chapterDurationMs` digitados; `selection = FULL_CHAPTER | MANUAL_REMAINDER(consumedMs)`.
- Validação positiva de duração até 24h, textos de até 120 caracteres (sem controles), consumo em milissegundos inteiro, sem aproximação/deriva de ponto flutuante.
- Se o restante do capítulo ultrapassar a duração-alvo: bloqueia, **sem cortar o áudio ou ajustar silenciosamente**. Capítulo finalizado bloqueia; não avança capítulos automaticamente.
- Aceita input humano decimal em segundos `20,039` ou `20.039` (até 3 casas), que equivale a **20.039 ms**, com parser estrito que rejeita `1e2`, negativos, múltiplas pontuações ou mais de 3 casas.
- Sucesso retorna `READY_MANUAL_PREVIEW`; falha `BLOCKED(reason)`.
- **AMBOS os retornos** sempre afirmam:
  - `durationEvidence="USER_DECLARED_UNVERIFIED"`
  - `remoteChapterVerified=false`
  - `remoteBookPresenceVerified=false`
  - `eligibleForBinding=false`
  - `eligibleForShadowPlanner=false`
  - `eligibleForAutomaticReconciliation=false`
  - `authorizedForAutomaticWrite=false`
  - `spotifyWrites=false`
  - `persisted=false`
- `formatUserDeclaredChapterNotes` gera anotação para copiar manualmente em seu aplicativo de notas; não gera Spotify URI, cron, aprovação de produção ou preflight de writer.

`src/components/AudiobookSelfReportedPreview.tsx` aparece dentro da tela experimental `/dashboard/configuracao/audiolivros`:
1. Escolher uma playlist de destino FIXED **ainda sem overlay validado**, apenas como referência de 5 min, 30 min etc.
2. Informar nome do livro, capítulo, segundos e opcionalmente o tempo já ouvido.
3. Clicar **Calcular prévia manual (sem salvar)**.
4. Ver tempo total, capítulo virtual e saldo, mais uma **anotação copiável** com aviso `USER_DECLARED_UNVERIFIED`.
5. Cada alteração de campo invalida imediatamente a prévia antiga. Ao recarregar a página, a anotação desaparece. Não usa sessionStorage, localStorage nem backend.
6. Se desejar, abrir o link da própria playlist diretamente no Spotify para verificar/reproduzir/trocar capítulo **manualmente**.

Nenhuma rota nova, migration ou alteração do banco foi introduzida neste gate. A informação não sobrevive ao reload, não pode gerar faixas da playlist nem é contabilizada pelo planejador produtivo.

## Demonstração com dados humanos

Destino de 300.000ms (5 minutos), livro "1984", capítulo "Apresentação" informado como `20,039` segundos:
- Duração virtual (não verificada): 20.039ms.
- Saldo virtual: 279.961ms (4min39,961s).
- Se o usuário informar 10 segundos já ouvidos: restante 10.039ms e saldo 289.961ms.
- Se o capítulo informado tiver 400.000ms e for contado inteiro em uma playlist de 300.000ms, retorna bloqueio `CHAPTER_EXCEEDS_TARGET`.
- O Spotify pode continuar exibindo a duração total real do livro (por exemplo, 15h). A prévia **NÃO controla reprodução**.

## Matriz de segurança

| Comportamento | Gate D.6 |
|---|---|
| Informa dados manualmente mesmo quando a API BR não devolve capítulos | SIM |
| Calcula capítulo e tempo livre sem API | SIM |
| Copia anotação manual | SIM, texto selecionável |
| Registra livro no banco como verificado pelo Spotify | **NÃO** |
| Grava draft, overlay, capítulos ou progresso persistente | **NÃO** |
| Autoriza geração real / usa o Gate D shadow planner | **NÃO** |
| Cria/atualiza playlists ou muda áudio no Spotify | **NÃO** |
| Troca capítulo automaticamente | **NÃO** |
| Identifica `item=null` como livro específico | **NÃO** |
| Habilita feature em produção | **NÃO** |

## Qualidade / limites

- [x] Serviço puro com proveniência explícita e política de `no writes`.
- [x] UI condicional com campo de duração e nota copiável.
- [x] Testes de duração, progresso, bloqueio, parser e SSR.
- [ ] CI PostgreSQL descartável, testes de todos os gates e typecheck.
- [ ] Teste interativo em browser e Android em ambiente de homologação.
- [ ] Avaliação separada sobre eventual salvamento de **notas humanas** no banco, se o produto precisar deste recurso; isso exigirá schema próprio com proveniência, isolamento do overlay verificado e consentimento explícito.
- [ ] Merge/deploy/flags de produção sujeitos à aprovação expressa.

**Critério de aceite D.6:** a prévia manual funciona offline, deixa claro que a duração não foi verificada, não armazena nem influencia a geração e não toca o Spotify. Homologação com conta real, automação e gravação ficam fora deste gate.
