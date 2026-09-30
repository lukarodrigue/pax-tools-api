import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Papel } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { ErroHttp, validar } from "./http.js";

const COOKIE = "pax_sessao";
const DURACAO_MS = 1000 * 60 * 60 * 12; // 12h

declare global {
  namespace Express {
    interface Request {
      usuario?: {
        id: string;
        nome: string;
        email: string;
        papel: Papel;
        precisaTrocarSenha: boolean;
      };
    }
  }
}

export const gerarHash = (senha: string) => hash(senha);

// usado quando o e-mail não existe: o login leva o mesmo tempo e não revela quem está cadastrado
const HASH_FALSO = hash("senha-que-nunca-confere");
export const verificarSenha = (hashArmazenado: string, senha: string) =>
  verify(hashArmazenado, senha);

/** Tentativas de login por e-mail. Em memória de propósito: reinício do
 *  processo limpa o bloqueio, e isso é aceitável para uma equipe de 5. */
const tentativas = new Map<string, { qtd: number; ate: number }>();

function bloqueado(email: string) {
  const t = tentativas.get(email);
  return !!t && t.qtd >= 5 && Date.now() < t.ate;
}

function registrarFalha(email: string) {
  const t = tentativas.get(email) ?? { qtd: 0, ate: 0 };
  t.qtd += 1;
  t.ate = Date.now() + 1000 * 60 * 10;
  tentativas.set(email, t);
}

export async function carregarSessao(req: Request, _res: Response, next: NextFunction) {
  const id = req.cookies?.[COOKIE];
  if (!id) return next();
  const sessao = await db.sessao.findUnique({ where: { id }, include: { usuario: true } });
  if (!sessao || sessao.expiraEm < new Date() || !sessao.usuario.ativo) return next();
  req.usuario = {
    id: sessao.usuario.id,
    nome: sessao.usuario.nome,
    email: sessao.usuario.email,
    papel: sessao.usuario.papel,
    precisaTrocarSenha: sessao.usuario.precisaTrocarSenha,
  };
  next();
}

export function exigirSessao(req: Request, _res: Response, next: NextFunction) {
  // a marca separa "sessão caiu" de outros 401, como senha atual incorreta
  if (!req.usuario) throw new ErroHttp(401, "Sessão expirada. Entre novamente.", { sessaoExpirada: true });
  next();
}

export function exigirLogin(req: Request, res: Response, next: NextFunction) {
  exigirSessao(req, res, () => {
    // senha definida por outra pessoa: nada funciona até a troca, nem pela API direto
    if (req.usuario!.precisaTrocarSenha) {
      throw new ErroHttp(403, "Troque sua senha antes de usar o sistema.", { trocarSenha: true });
    }
    next();
  });
}

/** ROOT > ADMIN > PADRAO. exigirPapel("ADMIN") libera ADMIN e ROOT. */
const FORCA: Record<Papel, number> = { PADRAO: 0, ADMIN: 1, ROOT: 2 };

export function exigirPapel(minimo: Papel) {
  // Request<any>: deixa a rota seguinte deduzir os parâmetros (:id) pelo caminho
  return (req: Request<any>, _res: Response, next: NextFunction) => {
    if (!req.usuario || FORCA[req.usuario.papel] < FORCA[minimo]) {
      throw new ErroHttp(403, "Seu perfil não permite esta ação.");
    }
    next();
  };
}

const entrada = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

export const rotasAuth = Router();

rotasAuth.post("/login", async (req, res) => {
  const dados = validar(entrada, req.body, "E-mail ou senha em formato inválido.");

  const email = dados.email.toLowerCase().trim();
  if (bloqueado(email)) throw new ErroHttp(429, "Muitas tentativas. Tente novamente em 10 minutos.");

  const usuario = await db.usuario.findUnique({ where: { email } });
  // mesma resposta para usuário inexistente e senha errada
  const hashParaConferir = usuario?.ativo ? usuario.senhaHash : await HASH_FALSO;
  const ok = (await verify(hashParaConferir, dados.senha)) && !!usuario?.ativo;
  if (!usuario || !ok) {
    registrarFalha(email);
    throw new ErroHttp(401, "E-mail ou senha incorretos.");
  }

  tentativas.delete(email);
  const id = randomBytes(32).toString("base64url");
  await db.sessao.create({
    data: { id, usuarioId: usuario.id, expiraEm: new Date(Date.now() + DURACAO_MS) },
  });
  res.cookie(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SEGURO === "true",
    maxAge: DURACAO_MS,
    path: "/",
  });
  res.json({
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    precisaTrocarSenha: usuario.precisaTrocarSenha,
  });
});

rotasAuth.post("/logout", async (req, res) => {
  const id = req.cookies?.[COOKIE];
  if (id) await db.sessao.deleteMany({ where: { id } });
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

rotasAuth.get("/eu", (req, res) => {
  if (!req.usuario) throw new ErroHttp(401, "Não autenticado.");
  res.json(req.usuario);
});

/** Remove sessões vencidas. Chamado no boot e a cada hora. */
export async function limparSessoes() {
  await db.sessao.deleteMany({ where: { expiraEm: { lt: new Date() } } });
}
