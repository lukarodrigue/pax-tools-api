import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import JSZip from "jszip";
import { z } from "zod";
import { db } from "../db.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const CAMINHO_MODELO = join(aqui, "..", "templates", "termo.docx");

/** O modelo é lido uma vez e reaproveitado; trocar o .docx exige reiniciar. */
let modeloEmCache: Buffer | null = null;
async function carregarModelo() {
  if (!modeloEmCache) modeloEmCache = await readFile(CAMINHO_MODELO);
  return modeloEmCache;
}

const item = z.object({
  qtd: z.number().int().min(1).max(999),
  descricao: z.string().trim().min(1).max(120),
  condicao: z.enum(["NOVO", "USADO"]),
});

const corpo = z.object({
  nomePessoa: z.string().trim().min(3).max(120),
  cpf: z.string().trim(),
  filial: z.string().trim().min(1).max(60),
  cidade: z.string().trim().min(1).max(60),
  ano: z.number().int().min(2000).max(2100),
  itens: z.array(item).min(1).max(10),
});

export function cpfValido(entrada: string) {
  const d = entrada.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (let j = 9; j < 11; j++) {
    let soma = 0;
    for (let i = 0; i < j; i++) soma += Number(d[i]) * (j + 1 - i);
    let resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    if (resto !== Number(d[j])) return false;
  }
  return true;
}

const formatarCpf = (v: string) =>
  v.replace(/\D/g, "").replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");

const escaparXml = (t: string) =>
  t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function semAcento(t: string) {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function nomeArquivo(nome: string, filial: string, primeiroItem: string) {
  const limpo = (t: string) =>
    semAcento(t)
      .replace(/[^A-Za-z0-9 ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/(^|_)(\w)/g, (_m, a, b) => a + b.toUpperCase());
  return `Termo_${limpo(nome)}_-_${limpo(filial)}_-_${limpo(primeiroItem.split(/\s+/)[0] ?? "Item")}.docx`;
}

export async function montarTermo(dados: z.infer<typeof corpo>) {
  const zip = await JSZip.loadAsync(await carregarModelo());
  const arquivo = zip.file("word/document.xml");
  if (!arquivo) throw new Error("Modelo inválido: word/document.xml não encontrado.");

  const textoItens =
    dados.itens.map((i) => `${i.qtd} ${i.descricao.toUpperCase()}, ${i.condicao}`).join("; ") + ",";

  const valores: Record<string, string> = {
    NOME: dados.nomePessoa.toUpperCase(),
    CPF: formatarCpf(dados.cpf),
    FILIAL: `(${dados.filial.toUpperCase()})`,
    ITENS: textoItens,
    ANO: String(dados.ano),
    CIDADE: dados.cidade,
  };

  let xml = await arquivo.async("string");
  for (const [chave, valor] of Object.entries(valores)) {
    xml = xml.split(`{{${chave}}}`).join(escaparXml(valor));
  }
  if (xml.includes("{{")) throw new Error("Modelo tem marcador não preenchido.");

  zip.file("word/document.xml", xml);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, nome: nomeArquivo(dados.nomePessoa, dados.filial, dados.itens[0].descricao) };
}

export const rotasTermos = Router();

rotasTermos.post("/", async (req, res) => {
  const dados = corpo.safeParse(req.body);
  if (!dados.success) return res.status(400).json({ erro: dados.error.issues[0].message });
  if (!cpfValido(dados.data.cpf)) return res.status(400).json({ erro: "CPF inválido." });

  const { buffer, nome } = await montarTermo(dados.data);

  await db.termo.create({
    data: {
      nomePessoa: dados.data.nomePessoa.toUpperCase(),
      cpf: formatarCpf(dados.data.cpf),
      filial: dados.data.filial.toUpperCase(),
      cidade: dados.data.cidade,
      ano: dados.data.ano,
      itens: dados.data.itens,
      nomeArquivo: nome,
      emitidoPorId: req.usuario!.id,
    },
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${semAcento(nome)}"`);
  res.send(buffer);
});

rotasTermos.get("/historico", async (req, res) => {
  const busca = String(req.query.busca ?? "").trim();
  const termos = await db.termo.findMany({
    where: busca
      ? {
          OR: [
            { nomePessoa: { contains: busca, mode: "insensitive" } },
            { cpf: { contains: busca.replace(/\D/g, "") } },
          ],
        }
      : undefined,
    orderBy: { emitidoEm: "desc" },
    take: 100,
    include: { emitidoPor: { select: { nome: true } } },
  });
  res.json(termos);
});
