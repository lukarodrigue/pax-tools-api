import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import type { ZodType, ZodTypeDef } from "zod";

/** Erro esperado: vira resposta { erro } com o status informado. */
export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(mensagem);
  }
}

/** Valida o corpo com zod; em caso de falha responde 400 com a primeira mensagem. */
export function validar<T>(schema: ZodType<T, ZodTypeDef, unknown>, dados: unknown, mensagem?: string): T {
  const resultado = schema.safeParse(dados);
  if (!resultado.success) throw new ErroHttp(400, mensagem ?? resultado.error.issues[0].message);
  return resultado.data;
}

const ERROS_DO_PRISMA: Record<string, [number, string]> = {
  P2025: [404, "Registro não encontrado. Ele pode ter sido excluído por outra pessoa."],
  P2003: [400, "Referência inválida: o item relacionado não existe."],
  P2002: [409, "Já existe um registro com esse valor."],
};

// Express 5 encaminha para cá também os erros de rotas async
export function tratarErros(erro: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (erro instanceof ErroHttp) {
    return res.status(erro.status).json({ erro: erro.message, ...erro.extra });
  }
  if (erro instanceof Prisma.PrismaClientKnownRequestError && ERROS_DO_PRISMA[erro.code]) {
    const [status, mensagem] = ERROS_DO_PRISMA[erro.code];
    return res.status(status).json({ erro: mensagem });
  }
  // erros do próprio Express (JSON malformado, corpo grande demais) já trazem status 4xx
  const status = (erro as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({ erro: "Requisição inválida." });
  }
  console.error(erro);
  res.status(500).json({ erro: "Erro interno. Confira os logs do container." });
}
