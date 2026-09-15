/**
 * Carrega o .env quando ele existe.
 *
 * Em Docker as variáveis vêm do compose e este arquivo não faz nada.
 * Fora do Docker, o Prisma CLI lê o .env sozinho, mas o runtime da
 * aplicação não — sem isto, `npm run dev` quebra com
 * "Environment variable not found: DATABASE_URL".
 *
 * Feito à mão em vez de dotenv para não adicionar dependência por 20 linhas.
 * Importe este módulo ANTES de qualquer coisa que use process.env.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const caminho = join(raiz, ".env");

if (existsSync(caminho)) {
  for (const linha of readFileSync(caminho, "utf8").split("\n")) {
    const texto = linha.trim();
    if (!texto || texto.startsWith("#")) continue;

    const corte = texto.indexOf("=");
    if (corte < 1) continue;

    const chave = texto.slice(0, corte).trim();
    let valor = texto.slice(corte + 1).trim();

    // aspas ao redor do valor são delimitador, não conteúdo
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }

    // variável já definida no ambiente sempre vence o arquivo
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
}
