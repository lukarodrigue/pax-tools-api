import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import JSZip from "jszip";
import { z } from "zod";
import { db } from "../db.js";
import { validar } from "../http.js";

const aqui = dirname(fileURLToPath(import.meta.url));

/** Cada tipo de termo tem o seu .docx com marcadores {{...}}. As chaves espelham o enum TipoTermo do Prisma. */
const MODELOS = {
  PADRAO: "termo.docx",
  COBRADOR_DOURADOS: "termo_cobrador_dourados.docx",
} as const;
type TipoTermo = keyof typeof MODELOS;
const TIPOS = Object.keys(MODELOS) as [TipoTermo, ...TipoTermo[]];

/** Os modelos são lidos uma vez e reaproveitados; trocar um .docx exige reiniciar. */
const modelosEmCache = new Map<TipoTermo, Buffer>();
async function carregarModelo(tipo: TipoTermo) {
  let modelo = modelosEmCache.get(tipo);
  if (!modelo) {
    modelo = await readFile(join(aqui, "..", "templates", MODELOS[tipo]));
    modelosEmCache.set(tipo, modelo);
  }
  return modelo;
}

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

/** IMEI tem 15 dígitos e o último é verificador (Luhn): pega dígito trocado ou faltando. */
export function imeiValido(d: string) {
  if (!/^\d{15}$/.test(d)) return false;
  let soma = 0;
  for (let i = 0; i < 15; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    soma += n;
  }
  return soma % 10 === 0;
}

const soDigitos = (v: string) => v.replace(/\D/g, "");

/** Aplica a máscara até onde houver dígitos: "52998" vira "529.98". */
const formatarCpf = (v: string) =>
  soDigitos(v)
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");

/** "67999998888" vira "(67) 99999-8888". */
const formatarTelefone = (d: string) => d.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");

// ---------- validação ----------

const comum = {
  nomePessoa: z.string().trim().min(3, "Informe o nome do colaborador.").max(120),
  cpf: z.string().trim().refine(cpfValido, "CPF inválido."),
  ano: z.number().int().min(2000).max(2100),
};

const item = z.object({
  qtd: z.number().int().min(1).max(999),
  descricao: z.string().trim().min(1).max(120),
  condicao: z.enum(["NOVO", "USADO"]),
});

const corpoPadrao = z.object({
  ...comum,
  filial: z.string().trim().min(1).max(60),
  cidade: z.string().trim().min(1).max(60),
  itens: z.array(item).min(1).max(10),
});

const modelo = (rotulo: string) =>
  z.string().trim().min(2, `Informe o modelo ${rotulo}.`).max(40).transform((v) => v.toUpperCase());

const serie = (rotulo: string) =>
  z
    .string()
    .trim()
    .min(3, `Informe o número de série ${rotulo}.`)
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, `Número de série ${rotulo}: use só letras, números e hífen.`)
    .transform((v) => v.toUpperCase());

const corpoCobrador = z.object({
  ...comum,
  filial: z.string().trim().min(1, "Informe a filial.").max(60),
  celularModelo: modelo("do celular"),
  imei: z
    .string()
    .transform(soDigitos)
    .refine(imeiValido, "IMEI inválido: confira os 15 dígitos (disque *#06# no celular)."),
  celularSn: serie("do celular"),
  chip: z
    .string()
    .transform(soDigitos)
    .refine((d) => d.length === 11, "Número do chip: informe DDD + 9 dígitos."),
  plano: z.enum(["VOZ E DADOS", "DADOS"], { message: "Escolha o plano do chip." }),
  /** vazio = celular entregue sem acessórios */
  acessorios: z
    .string()
    .trim()
    .max(120)
    .transform((v) => v.toUpperCase()),
  email: z.string().trim().toLowerCase().max(120).email("E-mail do aparelho inválido."),
  impressoraModelo: modelo("da impressora"),
  impressoraSn: serie("da impressora"),
  maquinaModelo: modelo("da máquina de cartão"),
  maquinaSn: serie("da máquina de cartão"),
});

type DadosCobrador = z.infer<typeof corpoCobrador>;

// ---------- montagem do .docx ----------

const escaparXml = (t: string) =>
  t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function semAcento(t: string) {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Termo_Nome_Da_Pessoa_-_Parte_-_Parte.docx */
function nomeArquivo(...partes: string[]) {
  const limpo = (t: string) =>
    semAcento(t)
      .replace(/[^A-Za-z0-9 ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/(^|_)(\w)/g, (_m, a, b) => a + b.toUpperCase());
  return `Termo_${partes.map(limpo).join("_-_")}.docx`;
}

const MARCADOR = /\{\{(\w+)\}\}/g;

async function preencherModelo(tipo: TipoTermo, valores: Record<string, string>) {
  const zip = await JSZip.loadAsync(await carregarModelo(tipo));
  const arquivo = zip.file("word/document.xml");
  if (!arquivo) throw new Error(`Modelo ${MODELOS[tipo]} inválido: word/document.xml não encontrado.`);

  const xmlModelo = await arquivo.async("string");
  const desconhecidos = [...xmlModelo.matchAll(MARCADOR)].map((m) => m[1]).filter((c) => !(c in valores));
  if (desconhecidos.length) {
    throw new Error(`Modelo ${MODELOS[tipo]} tem marcador sem valor: ${desconhecidos.join(", ")}`);
  }

  // uma passada só: o que a pessoa digitou nunca é lido de novo como marcador
  const xml = xmlModelo.replace(MARCADOR, (_m, chave: string) => escaparXml(valores[chave]));

  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function montarTermo(dados: z.infer<typeof corpoPadrao>) {
  const textoItens =
    dados.itens.map((i) => `${i.qtd} ${i.descricao.toUpperCase()}, ${i.condicao}`).join("; ") + ",";

  const buffer = await preencherModelo("PADRAO", {
    NOME: dados.nomePessoa.toUpperCase(),
    CPF: formatarCpf(dados.cpf),
    FILIAL: `(${dados.filial.toUpperCase()})`,
    ITENS: textoItens,
    ANO: String(dados.ano),
    CIDADE: dados.cidade,
  });
  const primeiroItem = dados.itens[0].descricao.split(/\s+/)[0] ?? "Item";
  return { buffer, nome: nomeArquivo(dados.nomePessoa, dados.filial, primeiroItem) };
}

/** A cidade é fixa: o modelo já traz "Dourados/MS" nas linhas de assinatura. */
export const CIDADE_COBRADOR = "Dourados/MS";

function textoKit(k: DadosCobrador) {
  const acessorios = k.acessorios ? `, ${k.acessorios}` : "";
  return (
    `1 CELULAR: ${k.celularModelo} (IMEI: ${k.imei} | SN: ${k.celularSn}), ` +
    `COM CHIP: ${formatarTelefone(k.chip)} (${k.plano})${acessorios}, ` +
    `1 IMPRESSORA TÉRMICA ${k.impressoraModelo} (SN: ${k.impressoraSn}), COM CARREGADOR, ` +
    `E 1 MÁQUINA DE CARTÃO ${k.maquinaModelo} (SN: ${k.maquinaSn}), COM CARREGADOR`
  );
}

/** Mesmo formato dos itens do termo padrão, para o histórico listar os dois juntos. */
function itensDoKit(k: DadosCobrador) {
  return [
    {
      qtd: 1,
      descricao:
        `CELULAR ${k.celularModelo} (IMEI ${k.imei}, SN ${k.celularSn}), ` +
        `CHIP ${formatarTelefone(k.chip)} (${k.plano}), E-MAIL ${k.email}` +
        (k.acessorios ? `, ${k.acessorios}` : ""),
    },
    { qtd: 1, descricao: `IMPRESSORA TÉRMICA ${k.impressoraModelo} (SN ${k.impressoraSn})` },
    { qtd: 1, descricao: `MÁQUINA DE CARTÃO ${k.maquinaModelo} (SN ${k.maquinaSn})` },
  ];
}

export async function montarTermoCobrador(dados: DadosCobrador) {
  const buffer = await preencherModelo("COBRADOR_DOURADOS", {
    NOME: dados.nomePessoa.toUpperCase(),
    CPF: formatarCpf(dados.cpf),
    FILIAL: `(${dados.filial.toUpperCase()})`,
    KIT: textoKit(dados),
    EMAIL: dados.email,
    ANO: String(dados.ano),
  });
  return { buffer, nome: nomeArquivo(dados.nomePessoa, "Cobrador Dourados") };
}

// ---------- rotas ----------

export const rotasTermos = Router();

rotasTermos.post("/", async (req, res) => {
  // sem "tipo" no corpo = termo padrão, como era antes do seletor
  const tipo = validar(z.enum(TIPOS).default("PADRAO"), req.body?.tipo, "Tipo de termo inválido.");

  let gerado: { buffer: Buffer; nome: string };
  if (tipo === "COBRADOR_DOURADOS") {
    const dados = validar(corpoCobrador, req.body);
    gerado = await montarTermoCobrador(dados);
    await db.termo.create({
      data: {
        tipo,
        nomePessoa: dados.nomePessoa.toUpperCase(),
        cpf: formatarCpf(dados.cpf),
        filial: dados.filial.toUpperCase(),
        cidade: CIDADE_COBRADOR,
        ano: dados.ano,
        itens: itensDoKit(dados),
        nomeArquivo: gerado.nome,
        emitidoPorId: req.usuario!.id,
      },
    });
  } else {
    const dados = validar(corpoPadrao, req.body);
    gerado = await montarTermo(dados);
    await db.termo.create({
      data: {
        tipo,
        nomePessoa: dados.nomePessoa.toUpperCase(),
        cpf: formatarCpf(dados.cpf),
        filial: dados.filial.toUpperCase(),
        cidade: dados.cidade,
        ano: dados.ano,
        itens: dados.itens,
        nomeArquivo: gerado.nome,
        emitidoPorId: req.usuario!.id,
      },
    });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${semAcento(gerado.nome)}"`);
  res.send(gerado.buffer);
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
