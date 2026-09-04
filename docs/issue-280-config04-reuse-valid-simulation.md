# #280 — CONFIG-04: reutilizar validação anterior após retry inconclusivo

## Problema observado

O CONFIG-04 passou a usar somente a simulação mais recente como autoridade. Essa regra protege contra reutilizar uma simulação de configuração antiga, mas criou um efeito colateral: uma nova tentativa `FAILED + inconclusive=true` causada por indisponibilidade temporária do Spotify invalida na prática uma simulação anterior que já havia sido `SUCCESS`, `qualityPassed=true` e feita sobre o mesmo `configurationFingerprint`.

## Regra corrigida

A configuração atual continua sendo a autoridade.

Para o fingerprint atual, as simulações são avaliadas da mais nova para a mais antiga:

1. tentativa `inconclusive=true` → neutra; não aprova e não invalida evidência anterior;
2. primeiro resultado conclusivo encontrado para o mesmo fingerprint → autoritativo;
3. `SUCCESS + qualityPassed=true` → CONFIG-04 liberado;
4. `SUCCESS + qualityPassed=false` → bloqueado;
5. `FAILED` conclusivo → bloqueado;
6. simulações de outros fingerprints não aprovam a configuração atual;
7. se nenhuma evidência conclusiva válida do fingerprint atual for encontrada → bloqueado.

Assim, por exemplo:

```text
S1  SUCCESS / qualityPassed=true / fingerprint=A
S2  FAILED / inconclusive=true / fingerprint=A
configuração atual = A
```

O gate pode reutilizar S1 depois que o backoff operacional do Spotify terminar.

Mas:

```text
S1  SUCCESS / qualityPassed=true / fingerprint=A
S2  SUCCESS / qualityPassed=false / fingerprint=A
configuração atual = A
```

continua bloqueado por S2.

## Backoff Spotify permanece separado

A correção não ignora quota/rate limit atual. `/api/generate` continua verificando `getActiveSpotifyBackoff()` antes do gate CONFIG-04 e retorna 429 enquanto o provider estiver bloqueado.

Portanto:

- CONFIG-04 válido não força chamada durante backoff;
- quando o backoff expira, uma tentativa inconclusiva anterior não obriga nova simulação se já existe validação compatível.

## Implementação

`evaluateCurrentSimulationGate()` foi preservado para avaliar um único resultado conclusivo.

Novo `evaluateCurrentSimulationHistoryGate()` avalia o histórico do fingerprint atual e trata resultados inconclusivos como neutros.

`getFirstRunGate()` percorre simulações recentes em ordem decrescente, usando cursor por `GenerationRun.id`, e interrompe assim que encontra um resultado conclusivo do fingerprint atual. O limite de busca é 100 registros; se não encontrar evidência suficiente, falha fechado.

## Segurança preservada

- não existe bypass por geração real histórica;
- fingerprint diferente nunca libera;
- falha conclusiva mais recente continua bloqueando;
- quality gate reprovado continua bloqueando;
- nenhuma migration;
- nenhuma geração real durante desenvolvimento/validação;
- nenhum writer Spotify foi alterado;
- merge e deploy permanecem gates separados.
