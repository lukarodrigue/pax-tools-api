import "./env.js";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { carregarSessao, exigirLogin, exigirPapel, limparSessoes, rotasAuth } from "./auth.js";
import { db } from "./db.js";
import { rotasLinks } from "./modules/links.js";
import { rotasTermos } from "./modules/termos.js";
import { rotaMinhaSenha, rotasUsuarios } from "./modules/usuarios.js";

const app = express();
const PORTA = Number(process.env.PORT ?? 3000);

app.set("trust proxy", 1);

/* CORS.
 * Em produção o Caddy serve front e API sob o mesmo hostname (/api/* vai
 * para cá), então a origem é a mesma e nada disso é exercitado. Isto existe
 * para o desenvolvimento (Vite em outra porta) e para o dia em que a API
 * ganhar um hostname próprio. Origem explícita e credentials: true —
 * "*" é incompatível com cookie. */
const ORIGENS = (process.env.ORIGENS_PERMITIDAS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origem = req.headers.origin;
  if (origem && ORIGENS.includes(origem)) {
    res.setHeader("Access-Control-Allow-Origin", origem);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());
app.use(carregarSessao);

app.get("/saude", async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, erro: "Banco indisponível." });
  }
});

app.use("/api/auth", rotasAuth);
// troca da própria senha fica ANTES do exigirLogin completo: quem precisa
// trocar está bloqueado em todo o resto e ainda assim tem que conseguir trocar
app.use("/api/minha-senha", (req, res, next) => {
  if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada. Entre novamente." });
  next();
}, rotaMinhaSenha);

app.use("/api/usuarios", exigirLogin, exigirPapel("ADMIN"), rotasUsuarios);
app.use("/api/links", exigirLogin, rotasLinks);
app.use("/api/termos", exigirLogin, rotasTermos);

app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(erro);
  res.status(500).json({ erro: "Erro interno. Confira os logs do container." });
});

await limparSessoes();
setInterval(() => void limparSessoes().catch(console.error), 1000 * 60 * 60);

app.listen(PORTA, () => console.log(`pax-tools ouvindo na porta ${PORTA}`));
