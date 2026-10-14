# Orientações permanentes para assistentes e agentes — Sonoriza

> Consulte este arquivo **antes de qualquer merge/deploy de produção**, inclusive em nova sessão. A fonte operacional é [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), seção 0, e o executor oficial é [scripts/deploy-cloudpanel.sh](scripts/deploy-cloudpanel.sh).

## Produção comprovada (CloudPanel / srv914260)

- Repositório GitHub: `marksborn/sonoriza`; implantação manual da branch `main`.
- Site user: `itsoft-sonoriza` — Git, npm, Prisma e PM2 **sempre** nesse usuário.
- App: `/home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br`.
- Node/npm/PM2: `/home/itsoft-sonoriza/.nvm/versions/node/v24.19.0/bin`. Não usar Node do sistema (18.x), nem `nvm use` com ambiente herdado do root.
- Definir `HOME=/home/itsoft-sonoriza`, `PM2_HOME=/home/itsoft-sonoriza/.pm2` e `PATH` iniciando pelo Node 24 do site ao chamar `runuser`.
- PM2 app: `sonoriza`; serviço systemd: `pm2-itsoft-sonoriza.service`; HTTP interno: `127.0.0.1:3005`.
- Backups não rastreados `.env.backup-*` podem existir na raiz do projeto: **não apagar, mover ou bloquear deploy por esses arquivos**. Bloquear apenas alterações Git rastreadas/staged.
- Root é permitido para `systemctl restart` e invocar o script; jamais executar `npm ci`/`npm run build` ou Git do repositório como root.
- O repositório GitHub não possui CD automático; merge **não** é deploy. Nunca declarar deploy concluído sem saída do servidor (PM2 ativo + HTTP local + SHA).
- Nenhum deploy altera por si só opt-in, rollout ou flags produtivas da Reserva da Academia. Nunca publicar no Spotify por inferência.

## Comando padrão no terminal root do servidor

```bash
bash /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br/scripts/deploy-cloudpanel.sh
```

No primeiro uso, quando o script ainda não existe no checkout, fazer **uma única vez** o bootstrap da seção 0 de `docs/DEPLOYMENT.md`. Não pedir repetidamente testes de `nvm ls`, caminho PM2 ou instalar Node se o binário do site estiver presente.

## Check de aceitação

- Comparar `git rev-parse HEAD` de produção com a `main` autorizada.
- Conferir `systemctl is-active pm2-itsoft-sonoriza.service` e HTTP local.
- Se não houver canal SSH entre ChatGPT e o host, preparar o comando/documentação, mas **não** afirmar que executou o deploy.
