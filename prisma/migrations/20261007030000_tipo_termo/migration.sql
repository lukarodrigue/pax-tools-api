-- CreateEnum
CREATE TYPE "TipoTermo" AS ENUM ('PADRAO', 'COBRADOR_DOURADOS');

-- AlterTable: termos já emitidos ficam como PADRAO
ALTER TABLE "Termo" ADD COLUMN     "tipo" "TipoTermo" NOT NULL DEFAULT 'PADRAO';
