import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";
export function ipConfiavel(requisicao: Request, hops: number): string | null {
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) return null;
  const partes = requisicao.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((x) => x.trim());
  const ip = partes?.at(-hops);
  if (!ip || !isIP(ip)) return null;
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}
export interface ArmazenamentoLimites {
  consumir(chave: string, limite: number, janelaMs?: number): void;
}
export class LimitesSqlite implements ArmazenamentoLimites {
  private db?: DatabaseSync;
  constructor(
    private arquivo = resolve(".cache/seguranca/limites.sqlite"),
    private agora = Date.now,
    private capacidade = 10_000,
  ) {}
  consumir(chave: string, limite: number, janelaMs = 60_000) {
    try {
      if (!this.db) {
        if (this.arquivo !== ":memory:")
          mkdirSync(dirname(this.arquivo), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(this.arquivo);
        this.db.exec(
          "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS limites (chave TEXT PRIMARY KEY, quantidade INTEGER NOT NULL, ate INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS limites_expiracao ON limites(ate)",
        );
      }
      const db = this.db;
      const hash = createHash("sha256").update(chave).digest("hex");
      const agora = this.agora();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM limites WHERE ate <= ?").run(agora);
        const registro = db.prepare("SELECT quantidade FROM limites WHERE chave=?").get(hash) as
          { quantidade: number } | undefined;
        if (registro && registro.quantidade >= limite)
          throw new ErroRegraNegocioHttp("Muitas tentativas. Aguarde um minuto.", 429);
        if (
          !registro &&
          Number((db.prepare("SELECT count(*) AS n FROM limites").get() as { n: number }).n) >=
            this.capacidade
        )
          throw new ErroRegraNegocioHttp(
            "Proteção temporariamente indisponível. Tente mais tarde.",
            503,
          );
        db.prepare(
          "INSERT INTO limites VALUES (?,1,?) ON CONFLICT(chave) DO UPDATE SET quantidade=quantidade+1",
        ).run(hash, agora + janelaMs);
        db.exec("COMMIT");
      } catch (erro) {
        db.exec("ROLLBACK");
        throw erro;
      }
    } catch (erro) {
      if (erro instanceof ErroRegraNegocioHttp) throw erro;
      throw new ErroRegraNegocioHttp(
        "Proteção temporariamente indisponível. Tente mais tarde.",
        503,
      );
    }
  }
  fechar() {
    this.db?.close();
    this.db = undefined;
  }
}
export const limitesAplicacao = new LimitesSqlite();
export function exigirIp(requisicao: Request, hops: number) {
  const ip = ipConfiavel(requisicao, hops);
  if (!ip)
    throw new ErroRegraNegocioHttp(
      "Não foi possível validar a origem de rede. Tente mais tarde.",
      503,
      "IP_UNAVAILABLE",
    );
  return ip;
}

export function limitarAutenticacao(
  requisicao: Request,
  hops: number,
  email: unknown,
  store: ArmazenamentoLimites = limitesAplicacao,
  producao = process.env.NODE_ENV === "production",
) {
  const ip = ipConfiavel(requisicao, hops);
  if (!ip && producao) exigirIp(requisicao, hops);
  if (ip) store.consumir("auth-ip:" + ip, 30);
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^\S+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  )
    throw new ErroRegraNegocioHttp("Informe um e-mail válido.", 400);
  store.consumir("auth-conta:" + email.trim().toLowerCase(), 10);
}
