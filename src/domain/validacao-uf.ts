import { ErroRegraNegocioHttp } from "./erros-validacoes-respostas-api.js";

const ufs = new Set(
  "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "),
);

export function normalizarUf(valor: unknown): string | null {
  if (valor == null) return null;
  if (typeof valor === "string") {
    const uf = valor.trim().toUpperCase();
    if (!uf) return null;
    if (ufs.has(uf)) return uf;
  }
  throw new ErroRegraNegocioHttp("Informe uma UF brasileira válida, como AC ou SP.");
}
