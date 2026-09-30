import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import JSZip from "jszip";
import { z } from "zod";
import { db } from "../db.js";
import { validar } from "../http.js";

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
  cpf: z.string().trim().refine(cpfValido, "CPF inválido."),
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

/** Aplica a máscara até onde houver dígitos: "52998" vira "529.98". */
const formatarCpf = (v: string) =>
  v
    .replace(/\D/g, "")
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");

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

const MARCADOR = /\{\{(\w+)\}\}/g;

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

  const modelo = await arquivo.async("string");
  const desconhecidos = [...modelo.matchAll(MARCADOR)].map((m) => m[1]).filter((c) => !(c in valores));
  if (desconhecidos.length) throw new Error(`Modelo tem marcador sem valor: ${desconhecidos.join(", ")}`);

  // uma passada só: o que a pessoa digitou nunca é lido de novo como marcador
  const xml = modelo.replace(MARCADOR, (_m, chave: string) => escaparXml(valores[chave]));

  zip.file("word/document.xml", xml);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, nome: nomeArquivo(dados.nomePessoa, dados.filial, dados.itens[0].descricao) };
}

export const rotasTermos = Router();

rotasTermos.post("/", async (req, res) => {
  const dados = validar(corpo, req.body);
  const { buffer, nome } = await montarTermo(dados);

  await db.termo.create({
    data: {
      nomePessoa: dados.nomePessoa.toUpperCase(),
      cpf: formatarCpf(dados.cpf),
      filial: dados.filial.toUpperCase(),
      cidade: dados.cidade,
      ano: dados.ano,
      itens: dados.itens,
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
  const temDigitos = /\d/.test(busca);
  // % e _ são curingas do LIKE: sem escapar, "%" traria todos os termos
  const literal = (t: string) => t.replace(/[\\%_]/g, "\\$&");

  const termos = await db.termo.findMany({
    where: busca
      ? {
          OR: [
            { nomePessoa: { contains: literal(busca), mode: "insensitive" } },
            // o CPF é gravado formatado: aceita a busca como digitada ou só com números
            ...(temDigitos
              ? [{ cpf: { contains: literal(busca) } }, { cpf: { contains: formatarCpf(busca) } }]
              : []),
          ],
        }
      : undefined,
    orderBy: { emitidoEm: "desc" },
    take: 100,
    include: { emitidoPor: { select: { nome: true } } },
  });
  res.json(termos);
});
