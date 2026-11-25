import "./carregar-arquivo-ambiente.js";
import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";

export interface ConfiguracaoMercadoPago {
  accessToken: string;
  publicKey?: string;
  webhookUrl?: string;
  webhookSecret: string;
  sellerId: string;
  applicationId: string;
  ambiente: "teste" | "producao";
  retornoUrl: string;
  maxParcelas: number;
  timeoutMs: number;
}
export function carregarMercadoPago(env: NodeJS.ProcessEnv = process.env): ConfiguracaoMercadoPago {
  const falha = () =>
    new ErroRegraNegocioHttp(
      "Pagamentos indisponíveis. A configuração do Mercado Pago precisa ser concluída.",
      503,
    );
  const ambiente = env.MERCADO_PAGO_ENVIRONMENT ?? "teste";
  if (!["teste", "producao"].includes(ambiente)) throw falha();
  if (ambiente === "producao" && env.MERCADO_PAGO_PRODUCTION_ENABLED !== "true") throw falha();
  const accessToken = env.MERCADO_PAGO_ACCESS_TOKEN ?? "";
  const webhookSecret = env.MERCADO_PAGO_WEBHOOK_SIGNING_SECRET ?? "";
  const sellerId = env.MERCADO_PAGO_SELLER_ACCOUNT_ID ?? "";
  const applicationId = env.MERCADO_PAGO_APPLICATION_ID ?? "";
  const retornoUrl = env.MERCADO_PAGO_CHECKOUT_RETURN_URL ?? "";
  const publicKey = configuracaoPublicaMercadoPago(env).publicKey;
  const webhookUrl = env.MERCADO_PAGO_WEBHOOK_URL || undefined;
  const maxParcelas = Number(env.MERCADO_PAGO_MAX_INSTALLMENTS ?? "1");
  const timeoutMs = Number(env.MERCADO_PAGO_REQUEST_TIMEOUT_MILLISECONDS ?? "7000");
  if (
    !accessToken ||
    webhookSecret.length < 16 ||
    !/^\d+$/.test(sellerId) ||
    !/^\d+$/.test(applicationId)
  )
    throw falha();
  if (!accessToken.startsWith(ambiente === "teste" ? "TEST-" : "APP_USR-")) throw falha();
  try {
    const url = new URL(webhookUrl ?? "https://configuracao-painel.example.invalid/");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw falha();
  } catch {
    throw falha();
  }
  if (
    !Number.isInteger(maxParcelas) ||
    maxParcelas < 1 ||
    maxParcelas > 12 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 10000
  )
    throw falha();
  return {
    accessToken,
    publicKey,
    webhookUrl,
    webhookSecret,
    sellerId,
    applicationId,
    ambiente: ambiente as ConfiguracaoMercadoPago["ambiente"],
    retornoUrl,
    maxParcelas,
    timeoutMs,
  };
}

export function configuracaoPublicaMercadoPago(env: NodeJS.ProcessEnv = process.env) {
  const ambiente = env.MERCADO_PAGO_ENVIRONMENT ?? "teste";
  const publicKey = env.MERCADO_PAGO_PUBLIC_KEY ?? "";
  const maxParcelas = Number(env.MERCADO_PAGO_MAX_INSTALLMENTS ?? "1");
  if (
    !["teste", "producao"].includes(ambiente) ||
    (ambiente === "producao" && env.MERCADO_PAGO_PRODUCTION_ENABLED !== "true") ||
    !publicKey.startsWith(ambiente === "teste" ? "TEST-" : "APP_USR-") ||
    !Number.isInteger(maxParcelas) ||
    maxParcelas < 1 ||
    maxParcelas > 12
  )
    throw new ErroRegraNegocioHttp("A configuração pública de pagamentos está indisponível.", 503);
  return {
    publicKey,
    ambiente: ambiente as "teste" | "producao",
    maxParcelas,
    meiosPagamento: ["credit_card", "pix"] as const,
  };
}

// Credenciais legadas são opcionais; nunca reinterpretar TEST- como credencial Orders.
export function configuracaoOrdersLegada(config: ConfiguracaoMercadoPago): ConfiguracaoMercadoPago {
  return {
    ...config,
    accessToken: process.env.MERCADO_PAGO_ORDERS_ACCESS_TOKEN ?? config.accessToken,
    applicationId: process.env.MERCADO_PAGO_ORDERS_APPLICATION_ID ?? config.applicationId,
    sellerId: process.env.MERCADO_PAGO_ORDERS_SELLER_ACCOUNT_ID ?? config.sellerId,
  };
}
