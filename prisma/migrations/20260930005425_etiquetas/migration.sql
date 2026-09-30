-- AlterTable
ALTER TABLE "Link" ADD COLUMN     "etiquetas" TEXT[] DEFAULT ARRAY[]::TEXT[];
