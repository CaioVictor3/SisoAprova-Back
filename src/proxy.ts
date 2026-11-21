import { NextResponse } from "next/server";

export function proxy() {
  // Landing pública e estática: não consulta sessão, configuração ou serviços externos.
  // Os Route Handlers da API autenticam e atualizam os próprios cookies.
  return NextResponse.next();
}

export const config = { matcher: "/" };
