import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const local = mkdtempSync(join(tmpdir(), "siso-test-"));
process.chdir(local);
for (const nome of Object.keys(process.env))
  if (/SUPABASE|RESEND|OPENAI|MERCADO_PAGO|AUTHENTICATION|POSTGRES|FRONTEND|BACKEND/.test(nome))
    delete process.env[nome];
process.env.NODE_ENV = "test";
globalThis.fetch = async () => {
  throw new Error("Serviços externos proibidos em testes unitários");
};
process.on("exit", () => rmSync(local, { recursive: true, force: true }));
