# #275 PODCAST-06 — Gate 1: contrato de cadência e prioridade

## Escopo

Gate 1 adiciona somente o contrato persistente de produto para cadência e prioridade por show.

Ele **não** altera seleção, ordenação, simulação, execução manual/agendada ou escrita em Spotify.

## Configuração persistida

`PodcastShowPolicy` passa a armazenar:

```text
cadenceMaxEpisodes: Int?
cadenceUnit: DAY | WEEK | MONTH | null
priority: NORMAL | PRIORITY
```

Semântica backward-compatible:

```text
cadenceMaxEpisodes = null
cadenceUnit = null
priority = NORMAL
```

significa o mesmo comportamento anterior: sem limite de cadência e sem prioridade especial.

Cadência configurada exige o par completo:

```text
cadenceMaxEpisodes >= 1
cadenceUnit = DAY | WEEK | MONTH
```

A migration adiciona uma `CHECK` constraint para impedir estado parcial (`1/null`, `null/WEEK`, zero ou negativo).

## Evidência canônica de consumo

Gate 1 não cria uma tabela `PodcastCadenceConsumption`.

O estado canônico existente já possui:

```text
EpisodeListeningState.firstProgressObservedAt
```

Esse timestamp representa a primeira evidência factual de que o episódio começou e será a âncora de consumo da cadência nos gates seguintes.

Consequências:

- publicar/gerar um episódio não consome cadência;
- simulação não consome cadência;
- o mesmo episódio possui uma única âncora factual e não consome duas vezes por re-sync;
- `IN_PROGRESS` pode ser distinguido de mera publicação;
- um registro legado sem `firstProgressObservedAt` não deve ter consumo inventado. Gate 2 mede esses casos como evidência desconhecida/fail-closed.

## Fronteira com o planner

O tipo `PodcastShowPolicySnapshot` continua sendo o contrato PODCAST-05 consumido pelo planner e **não contém** os campos de PODCAST-06 neste gate.

A persistência usa `PodcastShowPolicyStoredSnapshot`, que estende o snapshot legado com:

```text
cadenceMaxEpisodes
cadenceUnit
priority
```

Isso torna impossível ativar a feature apenas por aplicar a migration.

## Compatibilidade com a UI atual

O writer PODCAST-05 existente ainda não expõe controles de cadência/prioridade.

Os novos campos são opcionais em `PodcastShowPolicyUpdate`. Quando o writer antigo os omite, o store preserva os valores já persistidos em vez de sobrescrevê-los com defaults.

A UI fica para o Gate 5.

## Prioridade

`priority=PRIORITY` é somente uma intenção persistida neste gate.

Nos gates de runtime, a semântica obrigatória será:

> prioridade ordena candidatos já elegíveis; nunca transforma um candidato inelegível em elegível.

Ela não poderá furar estado de escuta, cadência, validade, cursor/rodada PODCAST-05, cap por ciclo, duração, janela de calendário, exclusividade, quality gates ou indisponibilidade do provider.

## Fingerprint

O fingerprint global atual ainda representa apenas campos legados básicos de `SourcePlaylist` e não inclui a política completa de PODCAST-05.

Gate 1 não introduz um fingerprint parcial apenas para PODCAST-06, pois isso criaria duas semânticas concorrentes dentro da mesma `PodcastShowPolicy`.

Antes de qualquer gate que permita cadência/prioridade alterar o plano, a configuração canônica deve passar a fingerprintar **a política por show completa**, incluindo PODCAST-05 + PODCAST-06. Isso é requisito de entrada para Gate 3/4, não ativação deste gate.

## Próximo gate

Gate 2 é read-only e deve, com dados reais:

1. resolver janelas civis `DAY`, `WEEK` (segunda-feira) e `MONTH` no timezone do usuário;
2. contar episódios distintos por `firstProgressObservedAt`;
3. mostrar shows que atingiriam o limite;
4. provar que episódio `IN_PROGRESS` pode continuar;
5. medir quantos estados legados não possuem timestamp factual suficiente;
6. não alterar candidatos nem escrever em Spotify.
