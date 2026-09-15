# pax-tools-api

Backend das ferramentas internas de TI da Pax Primavera. Express + Prisma + PostgreSQL.

O front está em **[pax-tools-web](https://github.com/lukarodrigue/pax-tools-web)**. Este repositório também carrega a infraestrutura (`docker-compose.yml`, `Caddyfile`, backup), porque o banco pertence a ele.

| Módulo | Rotas |
|---|---|
| Autenticação | `/api/auth/*`, `/api/minha-senha` |
| Links | `/api/links/*` — painel, grupos, lixeira |
| Termos | `/api/termos/*` — geração do `.docx` e histórico |
| Usuários | `/api/usuarios/*` — cadastro, papéis, desativação |

---

## Rodar na sua máquina

**Pré-requisitos:** `node -v` (22+) e `docker info` respondendo. `docker version` não serve — imprime o cliente mesmo com o Docker parado.

```bash
cp .env.local.example .env              # nunca escreva na mao: precisa de todas as variaveis
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d banco
docker compose ps                       # espere "healthy", nao "starting"

npm install
npx prisma migrate dev --name inicial   # na primeira vez; depois use migrate deploy
npm run usuario -- teste@pax.local "Teste TI" "teste-local-2026"
npm run dev                             # porta 3000
```

O front roda em paralelo, em outro terminal — veja o README dele. Abra `http://localhost:5173`, não a 3000: o Vite repassa `/api` para cá, e assim o navegador vê uma origem só, igual a produção.

**Commite `prisma/migrations/`.** É o que o servidor aplica.

### Voltar depois

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d banco
npm run dev
```

Depois de um `down -v` o banco está vazio: `npx prisma migrate deploy` e recrie o usuário.

---

## Subir no servidor interno

Linux com Docker. **Não use o `docker-compose.local.yml` lá** — ele publica a porta 5432 no host.

### Antes de começar

- Alguém além de você precisa saber subir, derrubar e restaurar.
- Defina para onde os backups saem deste servidor.
- Defina o nome que a equipe vai digitar (DNS interno ou `hosts`).

### Os dois repositórios ficam lado a lado

O compose constrói o front a partir de `../pax-tools-web`. Os nomes das pastas importam:

```bash
cd /opt                      # ou onde preferir
git clone <url-do-back> pax-tools-api
git clone <url-do-front> pax-tools-web
cd pax-tools-api
```

Resultado esperado:

```
/opt/
  pax-tools-api/    ← compose, Caddyfile, backup rodam daqui
  pax-tools-web/
```

Se o front estiver em outro caminho, ajuste o `build:` do serviço `web` no `docker-compose.yml`.

### Configurar e subir

```bash
cp .env.example .env
nano .env                    # troque POSTGRES_PASSWORD
nano Caddyfile               # troque ferramentas.pax.local pelo nome real

docker compose up -d --build
docker compose ps            # banco, api, web e proxy
docker compose logs -f api   # migrations rodam sozinhas no start
```

### Primeiro administrador

Só este sai por linha de comando; os demais você cria pela tela.

```bash
docker compose exec api npm run usuario:prod -- voce@paxprimavera.com.br "Seu Nome" "senha-longa"
```

`usuario:prod`, não `usuario` — a imagem de produção não tem `tsx`. O usuário nasce `ROOT`. Rodar de novo com o mesmo e-mail redefine a senha: é o destravamento de emergência.

**Não reaproveite a senha de teste local.**

### Sem HTTPS

No `Caddyfile`, troque o bloco por:

```
:80 {
	encode gzip
	handle /api/* { reverse_proxy api:3000 }
	handle { reverse_proxy web:80 }
}
```

E ponha `COOKIE_SEGURO=false`. A senha passa a trafegar em claro na LAN.

### Com `tls internal`

Instale a CA raiz nas máquinas da TI:

```bash
docker compose exec proxy cat /data/caddy/pki/authorities/local/root.crt
```

### Que volte sozinho após reiniciar

```bash
sudo systemctl enable docker
```

### Backup

```bash
crontab -e
# 0 2 * * * /opt/pax-tools-api/scripts/backup.sh >> /var/log/pax-tools-backup.log 2>&1
```

Guarda 30 dias. **Copie `backups/` para fora deste servidor** — mesmo disco não é backup.

Restaurar:

```bash
gunzip -c backups/paxtools-AAAAMMDD-HHMM.sql.gz | docker compose exec -T banco psql -U pax -d paxtools
```

Teste a restauração uma vez antes de precisar dela.

### Atualizar

Dois `git pull`, um `up`:

```bash
cd /opt/pax-tools-api && git pull
cd ../pax-tools-web && git pull
cd ../pax-tools-api && docker compose up -d --build
```

Esquecer um dos dois é o risco desta arquitetura: front e back saem de sincronia e o erro aparece como chamada quebrada, não como falha de deploy.

---

## Comandos

| O quê | Comando |
|---|---|
| Desenvolver | `npm run dev` |
| Criar/redefinir usuário (local) | `npm run usuario -- <email> "<nome>" "<senha>"` |
| Criar/redefinir usuário (servidor) | `docker compose exec api npm run usuario:prod -- ...` |
| Aplicar migrations | `npx prisma migrate deploy` |
| Logs | `docker compose logs -f api` (ou `web`, `proxy`, `banco`) |
| Parar (mantém dados) | `docker compose down` |
| Parar e **apagar o banco** | `docker compose down -v` |

Banco no DBeaver (local): `localhost:5432`, user `pax`, senha `local`, base `paxtools`.

---

## Quando algo falha

| Sintoma | Causa |
|---|---|
| `Environment variable not found: DATABASE_URL` | `.env` ausente. O Prisma CLI lê `.env` sozinho; a aplicação depende de `src/env.ts` |
| `Can't reach database server` | `docker compose ps -a` → se `Exited`, ver `logs banco` (quase sempre `.env` incompleto) |
| `POSTGRES_PASSWORD` vazio no log | `.env` incompleto. O compose trata variável faltante como string vazia e segue |
| `The table 'public.X' does not exist` | Faltou `prisma migrate deploy` |
| Login responde OK mas a tela não muda | `COOKIE_SEGURO=true` em HTTP |
| `build path ../pax-tools-web not found` | O repositório do front não está ao lado, ou tem outro nome |
| Container em `Restarting` | `docker compose logs <servico>` — o restart automático esconde falha de boot |
| `CORS policy` no console | Chamada direta à API de outra origem. Preencha `ORIGENS_PERMITIDAS` no `.env` |

---

## Papéis

| Papel | Pode |
|---|---|
| `PADRAO` | Usar links e termos. Não exclui nada. |
| `ADMIN` | Tudo do padrão + criar grupos, editar e **mover links para a lixeira**. Cadastra usuários `PADRAO`. |
| `ROOT` | Tudo + restaurar da lixeira, apagar de vez, apagar grupos e definir papéis. |

Exclusão de link é reversível de propósito: o admin move para a lixeira e o root decide. Fila de aprovação foi descartada porque travaria a equipe quando o root estivesse fora, e não é reversível depois de aprovada.

Termos nunca são excluídos por ninguém — são registro, não dado operacional.

O sistema recusa desativar você mesmo e recusa deixar a equipe sem nenhum root ativo. A validação está no servidor; esconder botão não é permissão.

---

## Manutenção

**Modelo do termo** — `src/templates/termo.docx`, com os marcadores `{{NOME}}`, `{{CPF}}`, `{{FILIAL}}`, `{{ITENS}}`, `{{ANO}}`, `{{CIDADE}}`. O arquivo fica em cache: trocar exige rebuild. O texto fixo está no singular ("que deverá ser utilizado") — com vários itens a frase fica torta; ajuste o modelo, não o código.

**CORS** — configurado em `src/server.ts` e inativo por padrão, porque o Caddy coloca front e API sob o mesmo hostname. Só preencha `ORIGENS_PERMITIDAS` se separar os domínios.

**Bloqueio de login** — cinco tentativas por e-mail, contador em memória. Reiniciar o container zera. Aceitável numa LAN com cinco pessoas conhecidas; **insuficiente se o sistema for exposto à internet**, onde precisaria ir para o banco e contar por IP.

---

## O que ainda não existe

- Reordenar links arrastando (ordem é alfabética dentro do grupo)
- Expurgo automático da lixeira
- Log de quem criou ou desativou quem
- Envio de senha provisória por e-mail
- Login integrado a AD ou Google Workspace (`src/auth.ts` está isolado para ser trocado)
- Vínculo com o `pax-it-stock-backend`: nome e CPF do colaborador são digitados nos dois sistemas
