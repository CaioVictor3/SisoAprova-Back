import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";
// Limita durante a leitura, inclusive quando Content-Length está ausente.
export async function lerBytesLimitados(requisicao: Request, limite: number): Promise<Buffer> {
  const declarado = Number(requisicao.headers.get("content-length") ?? "0");
  if (declarado > limite)
    throw new ErroRegraNegocioHttp("A requisição excede o tamanho permitido.", 413);
  const leitor = requisicao.body?.getReader();
  if (!leitor) return Buffer.alloc(0);
  let tamanho = 0;
  const partes: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > limite) {
        void leitor.cancel().catch(() => {});
        throw new ErroRegraNegocioHttp("A requisição excede o tamanho permitido.", 413);
      }
      partes.push(value);
    }
  } finally {
    leitor.releaseLock();
  }
  return Buffer.concat(partes, tamanho);
}
