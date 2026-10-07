# pax-tools-api

Backend das ferramentas internas de TI da Pax Primavera: painel de links, termos de responsabilidade e gestão de usuários. Express 5 + Prisma + PostgreSQL.

O front está em **[pax-tools-web](https://github.com/lukarodrigue/pax-tools-web)**. Este repositório também guarda a infraestrutura (`docker-compose.yml`, `Caddyfile`, backup), porque o banco pertence a ele.

- [Arquitetura](#arquitetura)
- [Branches](#branches)
- [Rodar na sua máquina](#rodar-na-sua-máquina)
- [Subir no servidor](#subir-no-servidor)
- [Atualizar o servidor](#atualizar-o-servidor)
- [Comandos](#comandos)
- [Quando algo falha](#quando-algo-falha)
- [Papéis](#papéis)
- [Manutenção](#manutenção)

---

## Arquitetura

### Visão geral

Dois repositórios, quatro containers, um banco.

```
                    ┌──────────────────────── servidor (docker compose) ────────────────────────┐
                    │                                                                            │
 navegador ──:80──▶ │  proxy (Caddy) ──/api/*──▶  api (Node + Express) ──▶  banco (PostgreSQL)  │
                    │        │                                                                   │
                    │        └──── resto ─────▶  web (nginx com o build do React)                │
                    └────────────────────────────────────────────────────────────────────────────┘
```

| Container | O que é | Vem de |
|---|---|---|
| `proxy` | Caddy. Única porta exposta. Manda `/api/*` para a API e o resto para o front | imagem `caddy:2` + `Caddyfile` |
| `api` | Este repositório. Roda as migrations ao subir | `Dockerfile` daqui |
| `web` | Arquivos estáticos do front servidos por nginx | `Dockerfile` do `pax-tools-web` |
| `banco` | PostgreSQL 16, sem porta exposta | imagem `postgres:16` + volume `dados-postgres` |

Front e API ficam sob **o mesmo endereço** (`/` e `/api`). Por isso o cookie de sessão funciona sem CORS. Em desenvolvimento, o Vite imita isso repassando `/api` para a porta 3000.

### Estrutura

```
src/
  server.ts          monta o Express: CORS, sessão, rotas e tratador de erros
  auth.ts            login, logout, sessão por cookie e middlewares de permissão
  http.ts            ErroHttp, validar() e o tratador central de erros
  env.ts             carrega o .env fora do Docker
  db.ts              instância única do Prisma
  criar-usuario.ts   script de linha de comando para o primeiro ROOT
  modules/
    links.ts         painel, grupos, etiquetas e lixeira
    termos.ts        geração do .docx e histórico
    usuarios.ts      cadastro, papéis, desativação e troca de senha
  templates/
    termo.docx       modelo do termo com marcadores {{...}}
    termo_cobrador_dourados.docx  termo do kit de cobrança móvel de Dourados (celular, impressora, máquina)
prisma/
  schema.prisma      tabelas
  migrations/        histórico de alterações do banco (commitar sempre)
scripts/
  backup.sh          dump diário do banco
```

Cada funcionalidade é **um arquivo em `modules/`** com as suas rotas, validações e regras. Não existem camadas separadas (controller, service, repository). Para um sistema deste tamanho, ler um arquivo de cima a baixo é mais simples do que navegar por pastas.

### Como uma requisição passa pela API

```
requisição
  → carregarSessao        lê o cookie e preenche req.usuario (ou não)
  → exigirLogin           401 sem sessão · 403 se precisa trocar a senha
  → exigirPapel("ROOT")   403 se o papel não alcança
  → rota do módulo        validar(schema, req.body) → regra → Prisma
  → tratarErros           transforma qualquer erro em { erro: "mensagem" }
```

### Padrões do código

**Validação**: toda entrada passa por um schema do zod com `validar()`. Se falhar, a API responde 400 com a primeira mensagem do schema.

```ts
const dados = validar(corpoLink, req.body);
```

**Erros esperados**: lance `ErroHttp` com o status e a mensagem que o usuário vai ler. Não use `res.status(...).json(...)` para erro.

```ts
if (existente) throw new ErroHttp(409, "Já existe um grupo com esse nome.");
```

**Erros do banco**: o `tratarErros` converte os códigos do Prisma. Registro inexistente vira 404, referência inválida vira 400 e valor duplicado vira 409. Qualquer outro erro vira 500 e aparece no log.

**Rotas async**: o Express 5 captura erros de funções `async` sozinho. Não precisa de `try/catch` na rota.

**Permissão**: sempre no servidor, com `exigirPapel`. O front só esconde botões; quem decide é a API.

**Formato das respostas de erro**: sempre `{ "erro": "mensagem" }`. Em dois casos vem um campo extra, que o front usa para reagir:

| Campo | Quando | O que o front faz |
|---|---|---|
| `sessaoExpirada: true` | 401 por sessão vencida ou ausente | volta para o login com aviso |
| `trocarSenha: true` | 403 porque a senha precisa ser trocada | leva para Minha senha |

### Como adicionar uma funcionalidade

1. Crie `src/modules/nome.ts` com um `Router()` e as rotas.
2. Registre em `server.ts`: `app.use("/api/nome", exigirLogin, rotasNome);`
3. Se precisar de tabela nova: altere `prisma/schema.prisma` e rode `npx prisma migrate dev --name descricao-curta`.
4. Commite a pasta criada em `prisma/migrations/`. É ela que o servidor aplica.

### Sessão e segurança

- Senhas com argon2. Sessão é um id aleatório de 256 bits num cookie `httpOnly` e `sameSite=lax`, válido por 12 horas.
- Desativar um usuário ou redefinir a senha dele derruba as sessões abertas na hora.
- Login bloqueia por 10 minutos depois de 5 erros no mesmo e-mail. O contador fica em memória: reiniciar a API zera.
- O login leva o mesmo tempo com e-mail existente ou não, para não revelar quem está cadastrado.
- Toda consulta passa pelo Prisma com parâmetros; a busca escapa os curingas `%` e `_`.
- O `Caddyfile` envia `X-Frame-Options`, `X-Content-Type-Options` e `Referrer-Policy`, e esconde o cabeçalho `Server`.
- Com HTTP puro (situação atual), senha e cookie trafegam sem criptografia na rede interna. Veja [HTTPS](#https-quando-migrar-para-a-vps).

---

## Branches

Os dois repositórios usam o mesmo fluxo:

| Branch | Para quê |
|---|---|
| `dev` | Desenvolvimento. Todo commit vai aqui primeiro |
| `main` | O que está no servidor. Só recebe o que já foi testado no `dev` |

**O servidor só acompanha o `main`.** Para publicar, junte o `dev` no `main` **nos dois repositórios**:

```bash
git checkout main
git pull
git merge dev
git push
git checkout dev
```

---

## Rodar na sua máquina

**Pré-requisitos:** Node 22 ou mais novo, e Docker rodando (`docker info` precisa responder).

### Primeira vez

```bash
git checkout dev
cp .env.local.example .env
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d banco
docker compose ps                  # espere "healthy"

npm install
npx prisma migrate deploy          # cria as tabelas
npm run usuario -- teste@pax.local "Teste TI" "senha-local-2026"
npm run dev                        # API na porta 3000
```

Em outro terminal, suba o front (veja o README do `pax-tools-web`) e abra **http://localhost:5173**. Não use a 3000 direto: ela só responde JSON.

### Dia a dia

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d banco
npm run dev
```

Depois de um `git pull`, rode `npm install` e `npx prisma migrate deploy` se vieram dependências ou migrations novas.

### Mudou o banco?

```bash
npx prisma migrate dev --name descricao-curta   # cria a migration e aplica
```

---

## Subir no servidor

Servidor Linux com Docker. **Não use o `docker-compose.local.yml` no servidor**: ele expõe a porta do banco.

### 1. Os dois repositórios lado a lado, no `main`

O compose constrói o front a partir de `../pax-tools-web`, então os nomes das pastas importam:

```bash
cd /opt
git clone -b main git@github.com:lukarodrigue/pax-tools-api.git pax-tools-api
git clone -b main git@github.com:lukarodrigue/pax-tools-web.git pax-tools-web
cd pax-tools-api
```

```
/opt/
  pax-tools-api/    ← todos os comandos docker compose rodam daqui
  pax-tools-web/
```

### 2. Configurar

```bash
cp .env.example .env
nano .env        # troque POSTGRES_PASSWORD por uma senha forte
```

O `Caddyfile` já vem para HTTP na porta 80. Mantenha `COOKIE_SEGURO=false` enquanto não houver HTTPS. Com `true` em HTTP, o login responde OK mas a sessão não é salva.

### 3. Subir

```bash
docker compose up -d --build
docker compose ps              # banco, api, web e proxy "Up"
docker compose logs -f api     # deve mostrar as migrations e "ouvindo na porta 3000"
```

### 4. Primeiro usuário ROOT

Só ele é criado por linha de comando. Os outros são criados pela tela **Usuários**.

```bash
docker compose exec api npm run usuario:prod -- voce@paxprimavera.com.br "Seu Nome" "senha-longa-aqui"
```

Rodar de novo com um e-mail que já existe **redefine a senha e reativa a conta**, mantendo o papel. É o destravamento de emergência se alguém perder o acesso.

### 5. Voltar sozinho depois de reiniciar

```bash
sudo systemctl enable docker
```

### 6. Backup

```bash
crontab -e
# 0 2 * * * /opt/pax-tools-api/scripts/backup.sh >> /var/log/pax-tools-backup.log 2>&1
```

Guarda 30 dias em `backups/`. **Copie essa pasta para fora do servidor**: backup no mesmo disco não protege contra perda do disco.

Restaurar:

```bash
gunzip -c backups/paxtools-AAAAMMDD-HHMM.sql.gz | docker compose exec -T banco psql -U pax -d paxtools
```

Teste a restauração uma vez antes de precisar dela.

---

## Atualizar o servidor

Antes: o `dev` já foi juntado no `main` e enviado (`git push`) **nos dois repositórios** (veja [Branches](#branches)).

No servidor:

```bash
cd /opt/pax-tools-api && ./scripts/backup.sh     # garante um ponto de volta
cd /opt/pax-tools-api && git pull
cd /opt/pax-tools-web && git pull
cd /opt/pax-tools-api && docker compose up -d --build
docker compose ps
docker compose logs -f api     # confira as migrations e "ouvindo na porta 3000"
```

Sempre os **dois** repositórios: atualizar só um deixa front e API fora de sincronia, e o erro aparece como tela quebrada, não como falha de deploy.

As migrations rodam sozinhas quando o container `api` sobe. Não é preciso rodar `prisma` à mão.

### Se algo der errado

Volte os dois repositórios para o commit anterior e suba de novo:

```bash
cd /opt/pax-tools-api && git log --oneline -3     # anote o commit anterior
git checkout <commit-anterior>
cd /opt/pax-tools-web && git checkout <commit-anterior-do-front>
cd /opt/pax-tools-api && docker compose up -d --build
```

Se a atualização tinha migration, restaure também o backup feito antes (veja [Backup](#6-backup)). Depois de resolver, volte ao `main` com `git checkout main` nos dois.

### HTTPS (quando migrar para a VPS)

Hoje o sistema roda em HTTP na rede interna. Antes de expor para fora (VPS ou acesso de casa):

1. No `Caddyfile`, troque `:80` pelo domínio (`ferramentas.seudominio.com.br`). O Caddy emite o certificado sozinho.
2. No `.env`, mude `COOKIE_SEGURO=true`.
3. Acrescente `Strict-Transport-Security` aos cabeçalhos do `Caddyfile` (os outros cabeçalhos de segurança já estão lá).
4. Leve o bloqueio de login para o banco e conte tentativas também por IP. O contador em memória não basta na internet.

---

## Comandos

| O quê | Comando |
|---|---|
| Desenvolver | `npm run dev` |
| Compilar | `npm run build` |
| Nova migration | `npx prisma migrate dev --name descricao` |
| Aplicar migrations | `npx prisma migrate deploy` |
| Criar/redefinir usuário (local) | `npm run usuario -- <email> "<nome>" "<senha>"` |
| Criar/redefinir usuário (servidor) | `docker compose exec api npm run usuario:prod -- <email> "<nome>" "<senha>"` |
| Ver logs | `docker compose logs -f api` (ou `web`, `proxy`, `banco`) |
| Backup manual | `./scripts/backup.sh` |
| Parar (mantém dados) | `docker compose down` |
| Parar e **apagar o banco** | `docker compose down -v` |

Banco local no DBeaver: `localhost:5432`, usuário `pax`, senha `local`, base `paxtools`.

---

## Quando algo falha

| Sintoma | Causa provável |
|---|---|
| Login responde OK mas volta para a tela de login | `COOKIE_SEGURO=true` com HTTP. Use `false` até ter HTTPS |
| `Environment variable not found: DATABASE_URL` | Falta o `.env` na raiz da API |
| `Can't reach database server` | Banco parado. `docker compose ps -a` e `docker compose logs banco` |
| `POSTGRES_PASSWORD` vazio no log | `.env` incompleto. O compose trata variável ausente como texto vazio |
| `The table 'public.X' does not exist` | Faltou `npx prisma migrate deploy` |
| `The column X does not exist` depois de um pull | Migration nova não aplicada. Local: `migrate deploy`. Servidor: `up -d --build` |
| `build path ../pax-tools-web not found` | O front não está ao lado, ou a pasta tem outro nome |
| Tela quebrada logo depois de atualizar | Um dos repositórios ficou para trás. `git log -1` nos dois e confira se estão no `main` atualizado |
| Container em `Restarting` | `docker compose logs <serviço>`. O reinício automático esconde a falha de boot |
| `CORS policy` no console | Chamada à API vindo de outra origem. Preencha `ORIGENS_PERMITIDAS` no `.env` |

---

## Papéis

| | PADRAO | ADMIN | ROOT |
|---|---|---|---|
| Usar links, termos e histórico | ✅ | ✅ | ✅ |
| Criar, editar e mover links para a lixeira | | ✅ | ✅ |
| Criar e renomear grupos | | ✅ | ✅ |
| Excluir grupos (vazios) | | | ✅ |
| Lixeira: restaurar e apagar de vez | | | ✅ |
| Usuários: criar, desativar, redefinir senha e mudar papel | | | ✅ |

- Excluir link é reversível de propósito: o ADMIN manda para a lixeira e o ROOT decide.
- Termos nunca são excluídos: são registro de entrega.
- A API recusa desativar a si mesmo e recusa deixar o sistema sem nenhum ROOT ativo.

---

## Manutenção

**Modelo do termo**: `src/templates/termo.docx`, com os marcadores `{{NOME}}`, `{{CPF}}`, `{{FILIAL}}`, `{{ITENS}}`, `{{ANO}}` e `{{CIDADE}}`. O arquivo fica em cache: depois de trocar, faça o rebuild (`docker compose up -d --build`). Um marcador desconhecido no modelo faz a geração falhar com a lista dos marcadores sem valor.

**Etiquetas dos links**: gravadas sempre em minúsculas e sem repetição, até 15 por link.

**CORS**: fica inativo porque o Caddy serve front e API no mesmo endereço. Só preencha `ORIGENS_PERMITIDAS` se a API ganhar um domínio próprio.

### O que ainda não existe

- HTTPS (planejado para a migração para a VPS)
- Reordenar links arrastando (hoje a ordem é alfabética dentro do grupo)
- Limpeza automática da lixeira
- Registro de quem criou ou desativou cada usuário
- Login integrado ao AD ou ao Google Workspace (`src/auth.ts` está isolado para ser trocado)
- Integração com o `pax-it-stock-backend`: nome e CPF do colaborador são digitados nos dois sistemas
