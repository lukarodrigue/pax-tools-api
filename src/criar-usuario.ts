/**
 * Cria ou redefine um usuário.
 *   docker compose exec app npm run usuario -- email@pax.com "Nome Sobrenome" "senha"
 */
import "./env.js";
import { gerarHash } from "./auth.js";
import { db } from "./db.js";

const [email, nome, senha] = process.argv.slice(2);

if (!email || !nome || !senha) {
  console.error('uso: npm run usuario -- <email> "<nome>" "<senha>"');
  process.exit(1);
}
if (senha.length < 10) {
  console.error("senha precisa ter pelo menos 10 caracteres");
  process.exit(1);
}

const senhaHash = await gerarHash(senha);
const usuario = await db.usuario.upsert({
  where: { email: email.toLowerCase() },
  update: { senhaHash, nome, ativo: true, papel: "ROOT" },
  create: { email: email.toLowerCase(), nome, senhaHash, papel: "ROOT" },
});

// trocar a senha derruba as sessões abertas
await db.sessao.deleteMany({ where: { usuarioId: usuario.id } });
console.log(`usuário pronto: ${usuario.email}`);
await db.$disconnect();
