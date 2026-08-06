# Sonoriza

> **Crie playlists dinâmicas de músicas e podcasts com base no seu tempo, agenda e contexto.**
>
> _Open-source dynamic playlists shaped by your schedule, time and context._

Sonoriza monta playlists automaticamente a partir de regras configuráveis:
duração fixa ou calculada pela sua agenda, proporção entre músicas e podcasts,
ordem de reprodução, limite de episódios por programa e exclusividade de
conteúdo entre listas.

O projeto começa atendendo ao uso pessoal, mas a arquitetura foi pensada para
evoluir para uma aplicação pública multiusuário. Esta primeira etapa foca em uma
base técnica **simples, segura e funcional** — sem monetização.

---

## Recursos (MVP)

- Conectar contas do **Spotify** e do **Google**.
- Selecionar quais calendários do Google são consultados.
- Configurar playlists de origem (músicas e podcasts).
- Configurar múltiplas playlists de destino.
- Duração **fixa** ou **calculada a partir de eventos do Google Calendar**.
- Proporção configurável entre músicas e podcasts.
- Sequência de reprodução (ex.: música, podcast, duas músicas, podcast…).
- No máximo **um episódio por programa** em cada playlist.
- **Exclusividade** entre playlists geradas na mesma execução (nenhuma música ou
  episódio se repete).
- Execução **agendada** (cron), **manual** e **simulada** (sem alterar nada).
- Histórico de execuções com resultado, logs e erros.

## Caso de uso inicial

Duas playlists geradas na mesma execução:

| Playlist   | Duração                          | Proporção            | Prioridade |
| ---------- | -------------------------------- | -------------------- | ---------- |
| **Carro**  | soma das viagens do dia (agenda) | 60% podcast / 40% música | 1ª (reserva o conteúdo) |
| **Trabalho** | fixa (padrão: 8 h)             | 60% podcast / 40% música | 2ª (usa o que sobrou)   |

Regras: Carro é gerada primeiro; Trabalho usa apenas o conteúdo restante;
nenhuma música ou episódio aparece nas duas; no máximo um episódio por programa
em cada playlist; sem viagens no dia, a playlist Carro é limpa (ou mantida,
conforme `emptyCalendarBehavior`).

## Arquitetura

- **Next.js** (App Router) + **TypeScript**
- **PostgreSQL** + **Prisma**
- **Auth.js (NextAuth v5)** para autenticação e OAuth de Spotify/Google
- **Motor de geração isolado da interface** (`src/services/playlist-planner`),
  sem dependência de Next, Prisma, Spotify ou Google — é lógica pura e testável.
- Execução agendada pelo **cron do servidor**, processo Node gerenciado por
  **PM2**, implantação em **CloudPanel** (ver [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

```text
src/
├── app/            # UI + rotas de API (auth, geração manual, cron)
├── components/     # componentes de UI
├── jobs/           # orquestração da geração (une engine + Spotify + Calendar + DB)
├── lib/            # prisma, auth, validação de env
├── services/
│   ├── google-calendar/   # cliente do Calendar + cálculo de duração por viagens
│   ├── spotify/           # cliente do Spotify Web API + refresh de token
│   └── playlist-planner/  # MOTOR: planejamento puro (proporção, sequência, exclusividade)
└── types/
```

O fluxo de uma execução vive em [`src/jobs/generate-playlists.ts`](src/jobs/generate-playlists.ts):
monta os pools de candidatos a partir das origens no Spotify, resolve a duração
de cada destino, chama o motor em ordem de prioridade (reservando o conteúdo já
usado) e então aplica ao Spotify — a menos que seja uma simulação — registrando
tudo em `GenerationRun`.

## Como rodar (desenvolvimento)

Pré-requisitos: Node ≥ 20 e um PostgreSQL acessível.

```bash
cp .env.example .env      # preencha as variáveis
npm install
npm run db:migrate        # cria as tabelas
npm run dev               # http://localhost:3000
```

Veja o motor funcionando **sem** Spotify/Google/banco:

```bash
npm run plan:example
```

Depois de entrar no app (o que cria seu usuário), semeie o caso de uso inicial:

```bash
npm run db:seed
```

Execução manual/simulação para um usuário via CLI:

```bash
npm run generate:run -- --user <userId> --simulate
```

## Variáveis de ambiente

Todas descritas em [`.env.example`](.env.example): `DATABASE_URL`, `AUTH_SECRET`,
`AUTH_SPOTIFY_ID/SECRET`, `AUTH_GOOGLE_ID/SECRET` e `CRON_SECRET`.

## Roadmap para multiusuário

A base já é multiusuário (todo dado é escopado por `userId`). Antes de abrir ao
público, os próximos passos incluem: UI de configuração de origens/destinos e
seleção de calendários, revisão do `allowDangerousEmailAccountLinking`, filas
por usuário para respeitar rate limits, filtro de episódios já ouvidos e planos
gratuito/pago.

## Licença

[MIT](LICENSE) © Marcos Nascimento
