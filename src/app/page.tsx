import type { Metadata } from "next";
import React from "react";

export const metadata: Metadata = { title: "Siso Aprova API" };

export default function PaginaApi(): React.JSX.Element {
  return (
    <main>
      <h1>Siso Aprova API</h1>
      <p>A API está em funcionamento.</p>
      {process.env.NODE_ENV !== "production" && (
        <p>
          <a href="/swagger">Abrir Swagger e testar as rotas</a>
        </p>
      )}
    </main>
  );
}
