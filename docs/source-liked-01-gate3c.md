# SOURCE-LIKED-01 — Gate 3C

Gate de arbitragem **somente em shadow** para a fonte nativa `LIKED_TRACKS`.

## Objetivo

Antes de definir qualquer participação produtiva das Curtidas, medir:

1. quantas músicas já selecionadas pelo plano autoritativo pertencem às Curtidas;
2. qual seria o efeito de intercalar apenas Curtidas que ainda não existem no pool atual;
3. cenários de exposição de 5%, 10% e 20%;
4. deltas de seleção, duração, diversidade e qualidade.

## Regras de segurança

- reutiliza o gate fail-closed do Gate 3B;
- apenas usuário e destino allowlisted participam;
- fonte lida somente de `LikedTrackPreference` local;
- cooldown/MUSIC-01 continua obrigatório;
- MUSIC-05/skip negativo é removido antes da interleaving;
- preserva a ordem relativa do pool atual;
- preserva a ordem relativa das Curtidas exclusivas;
- nenhum cenário substitui o plano autoritativo;
- `plannerInfluence=false`;
- zero Spotify writes;
- zero provider reads da fonte;
- evidência fica somente em `GenerationRun.summary.likedTrackSourceShadow.arbitrationShadow`.

## Estratégia

`ORDER_PRESERVING_INTERLEAVE_EXCLUSIVE_LIKED`

- 5%: aproximadamente 19 itens atuais para 1 Curtida exclusiva;
- 10%: aproximadamente 9 itens atuais para 1 Curtida exclusiva;
- 20%: aproximadamente 4 itens atuais para 1 Curtida exclusiva.

A porcentagem é um cenário de ordenação do pool, não uma cota garantida de seleção. O planner continua aplicando duração, composição, diversidade, preservados, exclusividade entre destinos e demais regras existentes.

## Decisão posterior

O Gate 3C não escolhe automaticamente uma arbitragem produtiva. A decisão deve usar a evidência real da Avulsa para determinar se `LIKED_TRACKS` deve ser apenas fallback/reserva ou receber uma exposição produtiva limitada em gate posterior.
