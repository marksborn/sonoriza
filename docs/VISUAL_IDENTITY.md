# Sonoriza — Identidade Visual v1

Este documento é o contrato visual do Sonoriza.

A intenção é manter a interface reconhecível e previsível sem transformar o projeto em uma biblioteca de design complexa.

## Princípio central

> Roxo é Sonoriza. Laranja é ação e energia. Roxo profundo é o ambiente do produto. Branco é conteúdo. Cores semânticas comunicam estado.

Marca e estado operacional não devem competir pela mesma cor.

## Marca

A identidade atual é preservada:

- símbolo e wordmark existentes;
- roxo como cor proprietária;
- laranja como energia e ação;
- referências a som, ritmo, playlists e sincronização.

VISUAL-01 não autoriza redesenhar o logo por aproximação.

Se o asset vetorial original não estiver disponível, usar o asset aprovado existente até que a correção de asset da issue #6 seja concluída.

## Paleta oficial

### Marca

| Token | Valor | Uso |
| --- | --- | --- |
| `brand-900` | `#27106F` | texto escuro da marca, contraste sobre laranja |
| `brand-600` | `#6724D9` | cor principal Sonoriza |
| `brand-400` | `#922DF2` | destaque, brilho e gradiente |
| `brand-soft` | `#EFE9FF` | fundo leve quando necessário |
| `accent-600` | `#FF7200` | ação principal |
| `accent-400` | `#FF982B` | hover/destaque claro |
| `accent-soft` | `#FFF1E6` | fundo leve de destaque |

### Base clara auxiliar

A base clara permanece disponível apenas para situações pontuais que realmente exijam superfície clara. Ela não define uma segunda identidade para a aplicação.

| Token | Valor |
| --- | --- |
| `canvas-light` | `#F8F7FB` |
| `surface-light` | `#FFFFFF` |
| `ink-light` | `#271746` |
| `muted-light` | `#71677F` |
| `line-light` | `#E8E3EF` |

### Ambiente principal

| Token | Valor | Uso |
| --- | --- | --- |
| `canvas-dark` | `#0B021F` | fundo principal do Sonoriza |
| `surface-dark` | `#160633` | chrome/header |
| `surface-subtle` | `#1D0B42` | cards internos |
| `surface-elevated` | `#241052` | controles e superfícies elevadas |
| `ink-inverse` | `#FBF9FF` | texto principal no escuro |
| `muted-inverse` | `#C7B9D9` | texto secundário no escuro |
| `line-dark` | `#49306D` | bordas no escuro |

## Unidade entre superfícies

Home, login, dashboard, configuração e demais superfícies próprias do Sonoriza pertencem ao mesmo ambiente visual predominantemente escuro.

A home pode ter composição mais editorial e promocional, enquanto o produto autenticado é mais operacional, mas ambos devem compartilhar:

- `canvas-dark` como ambiente dominante;
- superfícies roxas profundas;
- texto principal claro;
- roxo como identidade;
- laranja reservado para ação, energia e destaques pontuais;
- os mesmos tokens, bordas, sombras e linguagem de ícones.

Não criar uma versão clara da marca para separar “site” e “produto”. A passagem da home para o dashboard deve parecer continuidade do mesmo produto.

Não há toggle de tema no v1.

## Cores semânticas

As cores abaixo são independentes da marca:

| Estado | Token principal | Uso |
| --- | --- | --- |
| sucesso | `success` | conectado, concluído, aprovado |
| atenção | `warning` | bloqueio temporário, pendência, quota/rate limit |
| erro | `danger` | falha, ação destrutiva, erro real |
| informação | `info` | informação operacional sem risco |

### Regra

O laranja da marca (`accent`) não é cor genérica de warning ou erro.

Um bloqueio temporário do Spotify, por exemplo, usa `warning` e mantém texto/ícone explicando o estado.

## Contraste e CTA

O CTA primário usa:

- fundo `accent-600`;
- texto `brand-900`.

Evitar texto branco sobre `#FF7200` em texto normal, pois a combinação não entrega contraste suficiente para WCAG AA.

Foco por teclado deve ser sempre visível.

## Ícones

A interface usa uma única linguagem vetorial de ícones de linha.

O componente central atual é `UiIcon`.

Regras:

- 20 px como tamanho padrão;
- 18 px em controles compactos;
- 24 px em destaque quando necessário;
- stroke visual próximo de 2 px;
- ícone decorativo usa `aria-hidden`;
- botão somente com ícone precisa de nome acessível;
- não usar emoji ou caractere Unicode como ícone de produto.

Google e Spotify mantêm seus próprios símbolos e cores oficiais.

## Primitivas de interface

As seguintes classes formam a base reutilizável:

- `primary-button`;
- `secondary-button`;
- `product-shell`;
- `product-ambient`;
- `product-panel`;
- `product-card`;
- `product-icon-tile`;
- `product-icon-tile-accent`;
- `product-badge`;
- `product-link`;
- `status-success`;
- `status-warning`;
- `status-danger`;
- `status-info`.

Antes de criar uma nova combinação de cor, borda, sombra ou gradiente, verificar se uma dessas primitivas já resolve o papel visual.

## Tipografia

O v1 mantém Inter/system stack.

Papéis tipográficos:

- hero/display: alto peso e tracking fechado;
- page title: destaque principal da tela;
- section title: título de card/seção;
- body: texto funcional;
- eyebrow/label: curto, uppercase, tracking ampliado;
- helper/caption: informação secundária.

Não introduzir nova família tipográfica sem uma revisão de marca separada.

## Gradientes e sombras

Gradientes são parte da identidade, mas devem usar tokens de marca.

Preferir:

- `brand-gradient`;
- `accent-gradient`;
- `product-gradient`;
- `shadow-card`;
- `shadow-action`;
- `shadow-product-card`.

Evitar novos gradientes hexadecimais locais em cada tela.

## Terceiros

Cores hexadecimais de terceiros são exceções válidas quando representam a marca do provedor.

Exemplos:

- Google;
- Spotify.

Não reutilizar essas cores como tokens do Sonoriza.

## Checklist para novas telas

Antes de considerar uma tela visualmente pronta:

1. usa tokens em vez de novos hexadecimais de interface;
2. usa `UiIcon` em vez de Unicode/emoji;
3. não usa `accent` como warning/error;
4. CTA principal tem contraste adequado;
5. foco por teclado está visível;
6. informação de estado não depende somente de cor;
7. preserva continuidade visual com o ambiente principal do Sonoriza;
8. desktop e mobile preservam hierarquia e legibilidade.

## Gate de VISUAL-01

Antes de merge da conclusão da issue #67:

- `npm run typecheck`;
- `npm run build`;
- smoke visual em home, dashboard e configuração;
- busca por símbolos Unicode usados como ícones;
- busca por hexadecimais arbitrários de interface;
- validação do asset/logo da #6 separadamente, sem redesenho silencioso.
