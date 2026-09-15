-- CreateEnum
CREATE TYPE "Papel" AS ENUM ('ROOT', 'ADMIN', 'PADRAO');

-- CreateTable
CREATE TABLE "Usuario" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "papel" "Papel" NOT NULL DEFAULT 'PADRAO',
    "precisaTrocarSenha" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sessao" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sessao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grupo" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Grupo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "descricao" TEXT,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "aDescontinuar" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    "grupoId" TEXT NOT NULL,
    "criadoPorId" TEXT,
    "excluidoEm" TIMESTAMP(3),
    "excluidoPorId" TEXT,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Termo" (
    "id" TEXT NOT NULL,
    "nomePessoa" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "filial" TEXT NOT NULL,
    "cidade" TEXT NOT NULL,
    "ano" INTEGER NOT NULL,
    "itens" JSONB NOT NULL,
    "nomeArquivo" TEXT NOT NULL,
    "emitidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emitidoPorId" TEXT,

    CONSTRAINT "Termo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_email_key" ON "Usuario"("email");

-- CreateIndex
CREATE INDEX "Sessao_usuarioId_idx" ON "Sessao"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "Grupo_nome_key" ON "Grupo"("nome");

-- CreateIndex
CREATE INDEX "Link_grupoId_ordem_idx" ON "Link"("grupoId", "ordem");

-- CreateIndex
CREATE INDEX "Link_excluidoEm_idx" ON "Link"("excluidoEm");

-- CreateIndex
CREATE INDEX "Termo_cpf_idx" ON "Termo"("cpf");

-- CreateIndex
CREATE INDEX "Termo_emitidoEm_idx" ON "Termo"("emitidoEm");

-- AddForeignKey
ALTER TABLE "Sessao" ADD CONSTRAINT "Sessao_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_grupoId_fkey" FOREIGN KEY ("grupoId") REFERENCES "Grupo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_criadoPorId_fkey" FOREIGN KEY ("criadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_excluidoPorId_fkey" FOREIGN KEY ("excluidoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Termo" ADD CONSTRAINT "Termo_emitidoPorId_fkey" FOREIGN KEY ("emitidoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
