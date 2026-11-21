import { writeFileSync } from "node:fs";
import { gerarDocumentoOpenApi } from "../src/http/documentacao-openapi.js";
const texto = JSON.stringify(gerarDocumentoOpenApi(), null, 2) + "\n";
if (process.argv[2]) writeFileSync(process.argv[2], texto);
else process.stdout.write(texto);
