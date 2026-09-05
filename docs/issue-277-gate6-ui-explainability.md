# MUSIC-06 — Gate 6: UI / explicabilidade

Issue: #277

## Objetivo

Tornar a influência do MUSIC-06 auditável na interface sem transformar inferência em fato e sem sugerir uma causa psicológica que os dados não suportam.

A UI usa exclusivamente o `music06PlannerInfluence` já persistido no `GenerationRun.summary` pelo runtime produtivo do Gate 5B.

Nenhuma nova leitura de Spotify ou Last.fm é disparada para abrir a explicação.

## Onde aparece

A explicação fica junto aos controles de geração no dashboard.

`GET /api/generate` entrega a explicabilidade da geração real mais recente que possui summary MUSIC-06. Após uma geração manual, o `POST /api/generate` devolve a explicação da própria run recém-concluída para atualização imediata do painel.

Runs antigas sem `music06PlannerInfluence` continuam válidas e simplesmente não mostram o painel.

## Linguagem obrigatória

A UI identifica explicitamente:

```text
Curadoria inferida
não é fato
```

O detector é descrito como:

```text
Tipo: INFERRED
Método: LASTFM_PLANNED_SEQUENCE_GAP
Origem: Last.fm + ordem publicada pelo Sonoriza
```

A explicação diferencia duas perguntas:

1. **por que o Sonoriza criou o sinal?**
   - houve um gap observável entre âncoras reconciliadas da ordem publicada;
   - a cobertura da janela foi confirmada.
2. **por que a pessoa pulou a música?**
   - o MUSIC-06 não sabe;
   - não apresentar gosto, rejeição ao artista, versão LIVE ou qualquer causa psicológica como fato.

## Estado de aplicação

A UI não usa `negativeOccurrenceCount > 0` como sinônimo de rerank aplicado.

Estados:

```text
DISABLED
ABSTAINED
NO_RERANK
RERANK_APPLIED
FAILED_SAFE
```

`NO_RERANK` significa que o runtime participou e avaliou evidência, mas nenhum candidato atingiu os thresholds produtivos.

`RERANK_APPLIED` só é mostrado quando `application.applied === true` e deve informar:

- ocorrências influenciadas;
- deslocamento máximo observado em ranks musicais.

`FAILED_SAFE` informa que a influência foi ignorada e a geração prosseguiu sem rerank.

## Proteções mostradas ao usuário

A UI declara que:

- Spotify não é fonte de evidência comportamental de skip do MUSIC-06;
- o MUSIC-06 não remove músicas;
- o MUSIC-06 não altera elegibilidade;
- preferência explícita é mais forte que inferência;
- um gap não prova a intenção nem o motivo do usuário.

Se `explicitPreferenceSuppressedCount > 0`, a UI informa quantas influências inferidas foram suprimidas por preferência explícita.

## Dados exibidos

Resumo principal:

- ocorrências avaliáveis;
- sinais negativos inferidos;
- candidatas avaliadas pelo runtime;
- ocorrências efetivamente reposicionadas.

Detalhes técnicos:

- método;
- origem;
- targets com cobertura confirmada;
- source runs;
- elegibilidade alterada: sim/não;
- falhas de aplicação.

Não exibir API key, username privado, tokens, URIs internos, payload bruto ou dados de Spotify Recently Played.

## Parser fail-safe

`parseMusic06RunExplainability(summary)`:

- retorna `null` para runs sem summary MUSIC-06;
- não lança por JSON antigo/malformado;
- números inválidos viram `0`;
- só classifica `RERANK_APPLIED` quando o runtime persistiu `applied=true`;
- falha de aplicação tem precedência e vira `FAILED_SAFE`;
- policy desabilitada vira `DISABLED`;
- status diferente de `READY` com policy ativa vira `ABSTAINED`.

## Regressões do Gate 6

1. run antiga sem MUSIC-06 → nenhum painel;
2. `READY + enabled + applied=false` → explica inferência, mas diz que nenhuma ordem foi alterada;
3. `applied=true` → mostra somente rerank limitado e deslocamento persistido;
4. `eligibilityChanged=false` permanece explícito;
5. provider indisponível → `ABSTAINED`, sem alegar skip;
6. falha de aplicação → `FAILED_SAFE`, sem alegar rerank;
7. UI nunca usa Spotify como origem do sinal;
8. UI nunca diz “você não gosta” com base na inferência;
9. preferência explícita suprimindo inferência é explicável;
10. abrir/expandir o painel não faz write e não consulta provider.

## Fora do escopo deste gate

- atribuição causal por versão `LIVE` / `STUDIO_OR_STANDARD`;
- alterar thresholds;
- persistir novos sinais comportamentais;
- permitir exclusão automática;
- enviar MUSIC-06 para IA;
- criar histórico comportamental via Spotify.

A extensão de causa por versão registrada na #277 continua separada e deve passar pelo gate shadow próprio antes de aparecer como “provável motivo”.
