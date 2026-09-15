import { Router } from "express";
import { z } from "zod";
import { exigirPapel, gerarHash, verificarSenha } from "../auth.js";
import { db } from "../db.js";

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

const papeis = z.enum(["ROOT", "ADMIN", "PADRAO"]);

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

/** ADMIN cadastra gente comum; só ROOT cria outro ADMIN ou ROOT e
 *  só ROOT mexe no papel de quem já existe. */
function podeDefinir(quem: Express.Request["usuario"], papel: string) {
  if (quem?.papel === "ROOT") return true;
  return papel === "PADRAO";
}

rotasUsuarios.get("/", async (_req, res) => {
  res.json(await db.usuario.findMany({ select: SELECAO, orderBy: { nome: "asc" } }));
});

rotasUsuarios.post("/", async (req, res) => {
  const dados = novoUsuario.safeParse(req.body);
  if (!dados.success) return res.status(400).json({ erro: dados.error.issues[0].message });

  const email = dados.data.email.toLowerCase().trim();
  if (await db.usuario.findUnique({ where: { email } })) {
    return res.status(409).json({ erro: "Já existe usuário com esse e-mail." });
  }

  const papel = dados.data.papel ?? "PADRAO";
  if (!podeDefinir(req.usuario, papel)) {
    return res.status(403).json({ erro: "Só o root cria usuários com papel elevado." });
  }

  const usuario = await db.usuario.create({
    data: {
      email,
      nome: dados.data.nome,
      senhaHash: await gerarHash(dados.data.senha),
      papel,
      precisaTrocarSenha: true,
    },
    select: SELECAO,
  });
  res.status(201).json(usuario);
});

rotasUsuarios.patch("/:id/ativo", async (req, res) => {
  const ativo = z.object({ ativo: z.boolean() }).safeParse(req.body);
  if (!ativo.success) return res.status(400).json({ erro: "Informe ativo: true ou false." });

  if (req.params.id === req.usuario!.id && !ativo.data.ativo) {
    return res.status(409).json({ erro: "Você não pode desativar a si mesmo." });
  }
  if (!ativo.data.ativo && (await ehUltimoRoot(req.params.id))) {
    return res.status(409).json({ erro: "Este é o último root ativo." });
  }
  const alvo = await db.usuario.findUnique({ where: { id: req.params.id } });
  if (!podeDefinir(req.usuario, alvo?.papel ?? "PADRAO")) {
    return res.status(403).json({ erro: "Só o root altera usuários com papel elevado." });
  }

  const usuario = await db.usuario.update({
    where: { id: req.params.id },
    data: { ativo: ativo.data.ativo },
    select: SELECAO,
  });
  // desativar derruba o acesso na hora, não no fim da sessão
  if (!ativo.data.ativo) await db.sessao.deleteMany({ where: { usuarioId: usuario.id } });
  res.json(usuario);
});

rotasUsuarios.patch("/:id/papel", exigirPapel("ROOT"), async (req, res) => {
  const corpo = z.object({ papel: papeis }).safeParse(req.body);
  if (!corpo.success) return res.status(400).json({ erro: "Papel inválido." });

  if (corpo.data.papel !== "ROOT" && (await ehUltimoRoot(req.params.id))) {
    return res.status(409).json({ erro: "Este é o último root ativo." });
  }
  res.json(
    await db.usuario.update({
      where: { id: req.params.id },
      data: { papel: corpo.data.papel },
      select: SELECAO,
    }),
  );
});

rotasUsuarios.post("/:id/senha", async (req, res) => {
  const corpo = z.object({ senha: senhaForte }).safeParse(req.body);
  if (!corpo.success) return res.status(400).json({ erro: corpo.error.issues[0].message });

  const alvo = await db.usuario.findUnique({ where: { id: req.params.id } });
  if (!podeDefinir(req.usuario, alvo?.papel ?? "PADRAO")) {
    return res.status(403).json({ erro: "Só o root redefine senha de papel elevado." });
  }

  const usuario = await db.usuario.update({
    where: { id: req.params.id },
    data: { senhaHash: await gerarHash(corpo.data.senha), precisaTrocarSenha: true },
    select: SELECAO,
  });
  await db.sessao.deleteMany({ where: { usuarioId: usuario.id } });
  res.json(usuario);
});

/** Troca da própria senha. Não exige admin — está montada fora deste router. */
export const rotaMinhaSenha = Router();

rotaMinhaSenha.post("/", async (req, res) => {
  const corpo = z
    .object({ senhaAtual: z.string().min(1), senhaNova: senhaForte })
    .safeParse(req.body);
  if (!corpo.success) return res.status(400).json({ erro: corpo.error.issues[0].message });

  const usuario = await db.usuario.findUnique({ where: { id: req.usuario!.id } });
  if (!usuario || !(await verificarSenha(usuario.senhaHash, corpo.data.senhaAtual))) {
    return res.status(401).json({ erro: "Senha atual incorreta." });
  }
  if (corpo.data.senhaAtual === corpo.data.senhaNova) {
    return res.status(400).json({ erro: "A nova senha precisa ser diferente da atual." });
  }

  await db.usuario.update({
    where: { id: usuario.id },
    data: { senhaHash: await gerarHash(corpo.data.senhaNova), precisaTrocarSenha: false },
  });
  res.json({ ok: true });
});
