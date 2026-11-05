// Entrada local (Node.js). En producción se usa src/worker.ts (Cloudflare Workers).
import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import app from "./app.js";

app.use("/*", serveStatic({ root: "./web" }));

const PORT = Number(process.env.PORT || 8000);

console.log(`\n=======================================================`);
console.log(`🚀 Servidor TypeScript (Hono + Better Auth + LibSQL) iniciado!`);
console.log(`👉 Abre en tu navegador: http://localhost:${PORT}`);
console.log(`=======================================================\n`);

serve({ fetch: app.fetch, port: PORT });
