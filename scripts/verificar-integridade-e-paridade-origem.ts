// Verifica o contrato ativo Next sem carregar configuração, banco ou runtime Express.
import assert from "node:assert/strict";
import routes from "../src/contracts/rotas-publicas-api.json" with { type: "json" };
import { metadata } from "../src/contracts/validacao-conversao-contratos-api.js";
import { gerarDocumentoOpenApi } from "../src/http/documentacao-openapi.js";
const doc = gerarDocumentoOpenApi();
const vistos = new Set<string>();
for (const rota of routes) {
  const chave = rota.method + " " + rota.path;
  assert(!vistos.has(chave), "Rota duplicada");
  vistos.add(chave);
  assert(metadata[rota.request], "Contrato de entrada ausente");
  assert(metadata[rota.response], "Contrato de saída ausente");
  assert(doc.paths[rota.path]?.[rota.method.toLowerCase()], "Rota ausente no OpenAPI");
}
assert(
  !JSON.stringify(doc.paths).includes('"refreshToken"'),
  "Rotas ativas não devem exigir refreshToken",
);
console.log(
  `${vistos.size} contratos de rotas ativos presentes no OpenAPI. Paridade histórica .NET não é executada.`,
);
