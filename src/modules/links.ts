import { Router } from "express";
import { z } from "zod";
import { exigirPapel } from "../auth.js";
import { db } from "../db.js";

export const rotasLinks = Router();

const urlInterna = z
  .string()
  .trim()
  .min(1)
  .refine((v) => /^(https?:\/\/|\/\/|\\\\)/i.test(v), {
    message: "Informe a URL completa (http://, https:// ou caminho de rede \\\\servidor\\pasta).",
  });

const corpoLink = z.object({
  titulo: z.string().trim().min(1).max(120),
  url: urlInterna,
  descricao: z.string().trim().max(300).optional().nullable(),
  grupoId: z.string().min(1),
  ordem: z.number().int().optional(),
  aDescontinuar: z.boolean().optional(),
});

const corpoGrupo = z.object({
  nome: z.string().trim().min(1).max(60),
  ordem: z.number().int().optional(),
});

rotasLinks.get("/painel", async (_req, res) => {
  const grupos = await db.grupo.findMany({
    orderBy: [{ ordem: "asc" }, { nome: "asc" }],
    include: {
      links: {
        where: { excluidoEm: null },
        orderBy: [{ ordem: "asc" }, { titulo: "asc" }],
        include: { criadoPor: { select: { nome: true } } },
      },
    },
  });
  res.json(grupos);
});

rotasLinks.post("/grupos", exigirPapel("ADMIN"), async (req, res) => {
  const dados = corpoGrupo.safeParse(req.body);
  if (!dados.success) return res.status(400).json({ erro: dados.error.issues[0].message });
  const existente = await db.grupo.findUnique({ where: { nome: dados.data.nome } });
  if (existente) return res.status(409).json({ erro: "Já existe um grupo com esse nome." });
  res.status(201).json(await db.grupo.create({ data: dados.data }));
});

rotasLinks.delete("/grupos/:id", exigirPapel("ROOT"), async (req, res) => {
  const qtd = await db.link.count({ where: { grupoId: req.params.id, excluidoEm: null } });
  if (qtd > 0) {
    return res.status(409).json({ erro: `Mova ou apague os ${qtd} links deste grupo antes.` });
  }
  await db.grupo.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

rotasLinks.post("/", async (req, res) => {
  const dados = corpoLink.safeParse(req.body);
  if (!dados.success) return res.status(400).json({ erro: dados.error.issues[0].message });
  const link = await db.link.create({
    data: { ...dados.data, criadoPorId: req.usuario!.id },
  });
  res.status(201).json(link);
});

rotasLinks.put("/:id", exigirPapel("ADMIN"), async (req, res) => {
  const dados = corpoLink.partial().safeParse(req.body);
  if (!dados.success) return res.status(400).json({ erro: dados.error.issues[0].message });
  const link = await db.link.update({ where: { id: req.params.id }, data: dados.data });
  res.json(link);
});

/* ---- lixeira ----
 * ADMIN exclui: o link sai do painel mas continua no banco.
 * Só ROOT restaura ou apaga de vez. Exclusão vira reversível em vez de
 * depender de fila de aprovação, que travaria a equipe quando o root
 * estivesse fora. */

rotasLinks.delete("/:id", exigirPapel("ADMIN"), async (req, res) => {
  await db.link.update({
    where: { id: req.params.id },
    data: { excluidoEm: new Date(), excluidoPorId: req.usuario!.id },
  });
  res.json({ ok: true });
});

rotasLinks.get("/lixeira", exigirPapel("ROOT"), async (_req, res) => {
  res.json(
    await db.link.findMany({
      where: { excluidoEm: { not: null } },
      orderBy: { excluidoEm: "desc" },
      include: {
        grupo: { select: { nome: true } },
        excluidoPor: { select: { nome: true } },
      },
    }),
  );
});

rotasLinks.post("/:id/restaurar", exigirPapel("ROOT"), async (req, res) => {
  res.json(
    await db.link.update({
      where: { id: req.params.id },
      data: { excluidoEm: null, excluidoPorId: null },
    }),
  );
});

rotasLinks.delete("/:id/definitivo", exigirPapel("ROOT"), async (req, res) => {
  const link = await db.link.findUnique({ where: { id: req.params.id } });
  if (!link?.excluidoEm) {
    return res.status(409).json({ erro: "Mande para a lixeira antes de apagar de vez." });
  }
  await db.link.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
