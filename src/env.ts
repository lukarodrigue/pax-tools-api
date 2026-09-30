// Fora do Docker o .env não chega ao processo sozinho. Importe antes de tudo.
// Variáveis já definidas no ambiente vencem o arquivo.
import { existsSync } from "node:fs";

const caminho = new URL("../.env", import.meta.url);
if (existsSync(caminho)) process.loadEnvFile(caminho);
