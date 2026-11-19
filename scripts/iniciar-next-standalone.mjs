import { cpSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { config } from "dotenv";

const standalone = ".next/standalone";
if (!existsSync(`${standalone}/server.js`)) {
  console.error("Execute npm run build antes de iniciar a API em produção.");
  process.exit(1);
}

cpSync(".next/static", `${standalone}/.next/static`, { recursive: true });
if (existsSync("public")) cpSync("public", `${standalone}/public`, { recursive: true });

// O servidor standalone muda o diretório de trabalho ao iniciar.
config({ path: [".env.production.local", ".env.local", ".env.production", ".env"], quiet: true });

const porta = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || "0.0.0.0";

await new Promise((resolve) => {
  const verificador = createServer();
  verificador.once("error", (erro) => {
    if (erro && typeof erro === "object" && "code" in erro && erro.code === "EADDRINUSE") {
      console.error(
        `\n[Siso Aprova API] A porta ${porta} já está em uso por outro processo (ex.: outro terminal com 'npm run dev' ou 'npm run start' aberto).\n` +
          `Para liberar a porta ${porta} no macOS e iniciar novamente, execute:\n` +
          `  kill -9 $(lsof -ti :${porta})\n` +
          `Ou inicie em outra porta com: PORT=3001 npm run start\n`,
      );
      process.exit(1);
    }
    resolve(undefined);
  });
  verificador.once("listening", () => {
    verificador.close(() => resolve(undefined));
  });
  verificador.listen(porta, host);
});

await import("../.next/standalone/server.js");
