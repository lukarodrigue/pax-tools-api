import { Papel } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { gerarHash, verificarSenha } from "../auth.js";
import { db } from "../db.js";
import { ErroHttp, validar } from "../http.js";

export const rotasUsuarios = Router();

const SELECAO = {
  id: true,
  email: true,
  nome: true,
  ativo: true,
  papel: true,
  precisaTrocarSenha: true,
  criadoEm: true,
} as const;

const senhaForte = z.string().min(10, "A senha precisa de pelo menos 10 caracteres.");

const papeis = z.nativeEnum(Papel);

const novoUsuario = z.object({
  email: z.string().email("E-mail inválido."),
  nome: z.string().trim().min(3).max(120),
  senha: senhaForte,
  papel: papeis.optional(),
});

/** Impede que a equipe fique sem ninguém capaz de gerenciar acessos. */
async function ehUltimoRoot(id: string) {
  const alvo = await db.usuario.findUnique({ where: { id } });
  if (alvo?.papel !== "ROOT" || !alvo.ativo) return false;
  const quantos = await db.usuario.count({ where: { papel: "ROOT", ativo: true } });
  return quantos <= 1;
}

rotasUsuarios.get("/", async (_req, res) => {
  res.json(await db.usuario.findMany({ select: SELECAO, orderBy: { nome: "asc" } }));
});

rotasUsuarios.post("/", async (req, res) => {
  const dados = validar(novoUsuario, req.body);

  const email = dados.email.toLowerCase().trim();
  if (await db.usuario.findUnique({ where: { email } })) {
    throw new ErroHttp(409, "Já existe usuário com esse e-mail.");
  }

  const papel = dados.papel ?? "PADRAO";

  const usuario = await db.usuario.create({
    data: {
      email,
      nome: dados.nome,
      senhaHash: await gerarHash(dados.senha),
      papel,
      precisaTrocarSenha: true,
    },
    select: SELECAO,
  });
  res.status(201).json(usuario);
});

rotasUsuarios.patch("/:id/ativo", async (req, res) => {
  const { ativo } = validar(z.object({ ativo: z.boolean() }), req.body, "Informe ativo: true ou false.");

  if (req.params.id === req.usuario!.id && !ativo) throw new ErroHttp(409, "Você não pode desativar a si mesmo.");
  if (!ativo && (await ehUltimoRoot(req.params.id))) throw new ErroHttp(409, "Este é o último root ativo.");
  const usuario = await db.usuario.update({
    where: { id: req.params.id },
    data: { ativo },
    select: SELECAO,
  });
  // desativar derruba o acesso na hora, não no fim da sessão
  if (!ativo) await db.sessao.deleteMany({ where: { usuarioId: usuario.id } });
  res.json(usuario);
});

rotasUsuarios.patch("/:id/papel", async (req, res) => {
  const { papel } = validar(z.object({ papel: papeis }), req.body, "Papel inválido.");

  if (papel !== "ROOT" && (await ehUltimoRoot(req.params.id))) throw new ErroHttp(409, "Este é o último root ativo.");
  res.json(
    await db.usuario.update({
      where: { id: req.params.id },
      data: { papel },
      select: SELECAO,
    }),
  );
});

rotasUsuarios.post("/:id/senha", async (req, res) => {
  const { senha } = validar(z.object({ senha: senhaForte }), req.body);

  const usuario = await db.usuario.update({
    where: { id: req.params.id },
    data: { senhaHash: await gerarHash(senha), precisaTrocarSenha: true },
    select: SELECAO,
  });
  await db.sessao.deleteMany({ where: { usuarioId: usuario.id } });
  res.json(usuario);
});

/** Troca da própria senha. Não exige admin — está montada fora deste router. */
export const rotaMinhaSenha = Router();

rotaMinhaSenha.post("/", async (req, res) => {
  const { senhaAtual, senhaNova } = validar(
    z.object({ senhaAtual: z.string().min(1), senhaNova: senhaForte }),
    req.body,
  );

  const usuario = await db.usuario.findUnique({ where: { id: req.usuario!.id } });
  if (!usuario || !(await verificarSenha(usuario.senhaHash, senhaAtual))) {
    throw new ErroHttp(401, "Senha atual incorreta.");
  }
  if (senhaAtual === senhaNova) throw new ErroHttp(400, "A nova senha precisa ser diferente da atual.");

  await db.usuario.update({
    where: { id: usuario.id },
    data: { senhaHash: await gerarHash(senhaNova), precisaTrocarSenha: false },
  });
  res.json({ ok: true });
});
