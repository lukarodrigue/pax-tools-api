import { Router } from "express";
import { z } from "zod";
import { exigirPapel } from "../auth.js";
import { db } from "../db.js";
import { ErroHttp, validar } from "../http.js";

export const rotasLinks = Router();

const urlInterna = z
  .string()
  .trim()
  .min(1)
  .refine((v) => /^(https?:\/\/|\/\/|\\\\)/i.test(v), {
    message: "Informe a URL completa (http://, https:// ou caminho de rede \\\\servidor\\pasta).",
  });

// minúsculas e sem repetição: "Financeiro" e "financeiro " viram a mesma etiqueta
const etiquetas = z
  .array(z.string().trim().min(1).max(30, "Cada etiqueta pode ter até 30 caracteres."))
  .max(15, "No máximo 15 etiquetas por link.")
  .transform((lista) => [...new Set(lista.map((e) => e.toLowerCase()))]);

const corpoLink = z.object({
  titulo: z.string().trim().min(1).max(120),
  url: urlInterna,
  descricao: z.string().trim().max(300).optional().nullable(),
  grupoId: z.string().min(1),
  ordem: z.number().int().optional(),
  aDescontinuar: z.boolean().optional(),
  etiquetas: etiquetas.optional(),
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
      },
    },
  });
  res.json(grupos);
});

rotasLinks.post("/grupos", exigirPapel("ADMIN"), async (req, res) => {
  const dados = validar(corpoGrupo, req.body);
  if (await db.grupo.findUnique({ where: { nome: dados.nome } })) {
    throw new ErroHttp(409, "Já existe um grupo com esse nome.");
  }
  res.status(201).json(await db.grupo.create({ data: dados }));
});

rotasLinks.put("/grupos/:id", exigirPapel("ADMIN"), async (req, res) => {
  const { nome } = validar(corpoGrupo.pick({ nome: true }), req.body);
  const existente = await db.grupo.findUnique({ where: { nome } });
  if (existente && existente.id !== req.params.id) throw new ErroHttp(409, "Já existe um grupo com esse nome.");
  res.json(await db.grupo.update({ where: { id: req.params.id }, data: { nome } }));
});

rotasLinks.delete("/grupos/:id", exigirPapel("ROOT"), async (req, res) => {
  const [ativos, naLixeira] = await Promise.all([
    db.link.count({ where: { grupoId: req.params.id, excluidoEm: null } }),
    db.link.count({ where: { grupoId: req.params.id, excluidoEm: { not: null } } }),
  ]);
  if (ativos > 0) throw new ErroHttp(409, `Mova ou exclua os ${ativos} links deste grupo antes.`);
  if (naLixeira > 0) {
    throw new ErroHttp(409, `Há ${naLixeira} links deste grupo na lixeira. Restaure ou apague de vez antes.`);
  }
  await db.grupo.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

rotasLinks.post("/", exigirPapel("ADMIN"), async (req, res) => {
  const dados = validar(corpoLink, req.body);
  const link = await db.link.create({ data: { ...dados, criadoPorId: req.usuario!.id } });
  res.status(201).json(link);
});

rotasLinks.put("/:id", exigirPapel("ADMIN"), async (req, res) => {
  const dados = validar(corpoLink.partial(), req.body);
  const link = await db.link.update({ where: { id: req.params.id }, data: dados });
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
  if (!link?.excluidoEm) throw new ErroHttp(409, "Mande para a lixeira antes de apagar de vez.");
  await db.link.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
