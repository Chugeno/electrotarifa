// Entrada Cloudflare Workers. Los archivos de web/ se sirven como Static Assets (ver wrangler.toml);
// solo las rutas /api/* llegan a este Worker.
import app from "./app.js";

export default app;
