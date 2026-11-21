import { atenderDocumentacaoSwagger } from "../../../../http/interface-swagger.js";
import { cabecalhosSeguranca } from "../../../../security/headers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  contexto: { params: Promise<{ arquivo?: string[] }> },
) {
  if (process.env.NODE_ENV === "production")
    return new Response(null, { status: 404, headers: cabecalhosSeguranca() });
  const { arquivo } = await contexto.params;
  return atenderDocumentacaoSwagger(arquivo);
}
